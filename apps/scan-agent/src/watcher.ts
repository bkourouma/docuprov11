import { execFile } from 'node:child_process';
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AuthorizationError, UploadError, type ScanApiClient } from './api-client';
import {
  isCandidate,
  markAndCheckStable,
  pruneTracker,
  type Snapshot,
  type StabilityTracker,
} from './candidates';
import { FAILED_DIR, SENT_DIR, failureNote, nthName, sentSubdir } from './dispatch';
import type { Logger } from './logger';

export interface CycleOptions {
  watchDir: string;
  machineName: string;
  stableMs: number;
  maxAttempts: number;
  maxFileBytes: number;
}

export interface CycleResult {
  /** Fichiers déposés avec succès sur le serveur. */
  uploaded: number;
  /** Fichiers mis en quarantaine dans `_erreurs`. */
  failed: number;
  /** Fichiers vus mais pas encore stables (le scanner écrit toujours). */
  pending: number;
}

/**
 * État conservé entre deux cycles. `attempts` compte les échecs *rejouables* par fichier : c'est
 * lui qui décide du passage en quarantaine, sans quoi une API en panne ferait boucler l'agent
 * indéfiniment sur les mêmes fichiers.
 */
export interface AgentState {
  tracker: StabilityTracker;
  attempts: Map<string, number>;
}

export function createState(): AgentState {
  return { tracker: new Map(), attempts: new Map() };
}

/**
 * Prépare le dossier surveillé et ses deux sous-dossiers de service, masqués dans l'explorateur :
 * la personne qui numérise ne doit voir que ses PDF en attente, pas la mécanique de l'agent. Les
 * dossiers existent bien (rien n'est supprimé, la traçabilité est intacte), ils ne s'affichent
 * simplement plus. Rejoué à chaque démarrage : masque aussi les dossiers créés par une version
 * précédente.
 */
export async function ensureDirs(watchDir: string): Promise<void> {
  await mkdir(watchDir, { recursive: true });
  for (const sub of [SENT_DIR, FAILED_DIR]) {
    const dir = join(watchDir, sub);
    await mkdir(dir, { recursive: true });
    await hideFromExplorer(dir);
  }
}

const run = promisify(execFile);

/**
 * Pose l'attribut « caché » sur un dossier (Windows). Purement cosmétique : un échec — droits
 * refusés, système non-Windows — ne doit jamais empêcher l'agent de démarrer.
 */
async function hideFromExplorer(dir: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    await run('attrib', ['+h', dir]);
  } catch {
    /* l'agent fonctionne à l'identique avec des dossiers visibles */
  }
}

/**
 * Un balayage du dossier surveillé : repère les fichiers dont l'écriture est terminée, les dépose
 * dans la file §07, puis les déplace hors du dossier — un fichier envoyé ne doit jamais pouvoir
 * être renvoyé, et un fichier refusé ne doit jamais disparaître silencieusement.
 *
 * Propage `AuthorizationError` : problème de compte, pas de fichier. L'appelant interrompt le
 * cycle et laisse tout en place.
 */
export async function runCycle(
  client: ScanApiClient,
  state: AgentState,
  options: CycleOptions,
  logger: Logger,
  now: () => number = Date.now,
): Promise<CycleResult> {
  const result: CycleResult = { uploaded: 0, failed: 0, pending: 0 };

  const entries = await readdir(options.watchDir, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile() && isCandidate(e.name)).map((e) => e.name);
  pruneTracker(state.tracker, names);
  pruneTracker(state.attempts, names);

  for (const fileName of names) {
    const fullPath = join(options.watchDir, fileName);
    let snapshot: Snapshot;
    try {
      const info = await stat(fullPath);
      snapshot = { size: info.size, mtimeMs: info.mtimeMs, at: now() };
    } catch {
      continue; // disparu ou renommé entre le readdir et le stat : rien à faire
    }

    if (!markAndCheckStable(state.tracker, fileName, snapshot, options.stableMs)) {
      result.pending += 1;
      continue;
    }

    if (snapshot.size > options.maxFileBytes) {
      await quarantine(
        options.watchDir,
        fileName,
        `Fichier trop volumineux (${Math.round(snapshot.size / 1024 / 1024)} Mo)`,
        logger,
      );
      result.failed += 1;
      continue;
    }

    let content: Buffer;
    try {
      content = await readFile(fullPath);
    } catch (e) {
      // EBUSY / EPERM : le pilote tient encore le fichier ouvert malgré une taille figée.
      logger.debug({ fileName, err: (e as Error).message }, 'fichier verrouillé, essai suivant');
      result.pending += 1;
      continue;
    }

    try {
      const uploaded = await client.upload(fileName, content, options.machineName);
      await moveInto(options.watchDir, join(SENT_DIR, sentSubdir(new Date(snapshot.at))), fileName);
      state.tracker.delete(fileName);
      state.attempts.delete(fileName);
      result.uploaded += 1;
      logger.info(
        { fileName, mailScannedDocumentId: uploaded.mailScannedDocumentId, bytes: content.length },
        'scan déposé dans la file',
      );
    } catch (e) {
      if (e instanceof AuthorizationError) throw e;
      const error = e instanceof UploadError ? e : new UploadError((e as Error).message, true);
      const attempts = (state.attempts.get(fileName) ?? 0) + 1;
      state.attempts.set(fileName, attempts);

      if (!error.retryable || attempts >= options.maxAttempts) {
        const reason = error.retryable
          ? `${error.message} (abandon après ${attempts} tentatives)`
          : error.message;
        await quarantine(options.watchDir, fileName, reason, logger);
        state.tracker.delete(fileName);
        state.attempts.delete(fileName);
        result.failed += 1;
      } else {
        logger.warn(
          { fileName, attempts, err: error.message },
          'dépôt échoué, nouvelle tentative au prochain cycle',
        );
        result.pending += 1;
      }
    }
  }

  return result;
}

/** Écarte un fichier dans `_erreurs` avec un `.motif.txt` expliquant le rejet. */
async function quarantine(
  watchDir: string,
  fileName: string,
  reason: string,
  logger: Logger,
): Promise<void> {
  const finalName = await moveInto(watchDir, FAILED_DIR, fileName);
  await writeFile(
    join(watchDir, FAILED_DIR, `${finalName}.motif.txt`),
    failureNote(fileName, reason, new Date()),
    'utf8',
  );
  logger.error({ fileName, reason }, 'scan mis en quarantaine');
}

/**
 * Déplace `fileName` dans `subdir` sans jamais écraser : le nom retenu est le premier libre de la
 * suite `nom.pdf`, `nom (2).pdf`… Renvoie le nom effectivement utilisé.
 */
async function moveInto(watchDir: string, subdir: string, fileName: string): Promise<string> {
  const targetDir = join(watchDir, subdir);
  await mkdir(targetDir, { recursive: true });
  for (let n = 1; n <= 1000; n += 1) {
    const candidate = nthName(fileName, n);
    const target = join(targetDir, candidate);
    // `rename` écrase la cible en silence (sur Windows comme sur POSIX) : on réserve d'abord le
    // nom avec un `open` en `wx`, seule opération qui échoue si le nom est déjà pris. Le `rename`
    // qui suit n'écrase alors que notre propre fichier vide.
    try {
      await (await open(target, 'wx')).close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    await rename(join(watchDir, fileName), target);
    return candidate;
  }
  throw new Error(`Impossible de déplacer « ${fileName} » : 1000 noms déjà pris dans ${subdir}`);
}
