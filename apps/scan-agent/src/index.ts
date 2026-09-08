import './config/load-env';
import { loadEnv, resolveCredentials, resolveWatchDir, type Credentials } from './config/env';
import { logger } from './logger';
import { AuthorizationError, ScanApiClient } from './api-client';
import { createState, ensureDirs, runCycle } from './watcher';
import { FAILED_DIR, SENT_DIR } from './dispatch';

/**
 * Agent de numérisation — remplaçant du service Windows du source (§01.5.1).
 *
 * Tourne sur le POSTE DE SCAN : il surveille le dossier où le pilote dépose ses fichiers et les
 * pousse dans la file « Documents scannés » (§07) via l'API. Aucun accès base ni disque serveur :
 * tout passe par `POST /courriers/documents-scannes`, donc l'agent n'a besoin que du réseau et de
 * sa clé de service — posée une fois à l'installation, personne n'a rien à saisir ensuite.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const watchDir = resolveWatchDir(env);
  const credentials = resolveCredentials(env);
  const client = new ScanApiClient({ baseUrl: env.SCAN_AGENT_API_URL, credentials });

  await ensureDirs(watchDir);
  logger.info(
    {
      watchDir,
      apiUrl: env.SCAN_AGENT_API_URL,
      machineName: env.SCAN_AGENT_MACHINE_NAME,
      pollMs: env.SCAN_AGENT_POLL_MS,
      auth: credentials.kind === 'apiKey' ? 'clé de service' : `compte ${credentials.username}`,
    },
    'agent de numérisation démarré',
  );

  // Échec explicite au démarrage plutôt que silencieux au premier scan : sans accès à la file,
  // l'agent ne sert à rien et l'exploitant doit le voir tout de suite dans les logs du service.
  try {
    await client.checkAccess();
    logger.info('accès à la file « Documents scannés » vérifié');
  } catch (e) {
    if (e instanceof AuthorizationError) {
      // 401 et 403 se corrigent à des endroits différents : ne jamais les présenter avec le même
      // message, l'exploitant chercherait au mauvais endroit.
      logger.error({ err: e.message, status: e.status }, authFailureHint(e.status, credentials));
      process.exitCode = 1;
      return;
    }
    logger.warn({ err: (e as Error).message }, 'API injoignable au démarrage, on réessaiera');
  }

  const state = createState();
  const options = {
    watchDir,
    machineName: env.SCAN_AGENT_MACHINE_NAME,
    stableMs: env.SCAN_AGENT_STABLE_MS,
    maxAttempts: env.SCAN_AGENT_MAX_ATTEMPTS,
    maxFileBytes: Math.round(env.SCAN_AGENT_MAX_FILE_MB * 1024 * 1024),
  };

  let stopping = false;
  // Réveille l'attente entre deux cycles : sans ça, un `Stop-Service` patienterait jusqu'à
  // `SCAN_AGENT_POLL_MS` avant d'être pris en compte, et NSSM finirait par tuer le process.
  let wake: (() => void) | null = null;
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'arrêt demandé, fin du cycle en cours');
    wake?.();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Boucle séquentielle : un seul cycle à la fois, donc jamais deux envois du même fichier même
  // si l'API répond lentement (un setInterval, lui, se recouvrirait).
  while (!stopping) {
    try {
      const res = await runCycle(client, state, options, logger);
      if (res.uploaded || res.failed) {
        logger.info(res, 'cycle terminé');
      } else {
        logger.debug(res, 'cycle sans nouveau scan');
      }
    } catch (e) {
      if (e instanceof AuthorizationError) {
        logger.error(
          { err: e.message },
          'cycle interrompu : compte de service refusé — aucun fichier déplacé',
        );
      } else {
        logger.error({ err: (e as Error).message }, 'cycle en erreur');
      }
    }
    await sleep(env.SCAN_AGENT_POLL_MS);
  }

  logger.info(
    { sentDir: SENT_DIR, failedDir: FAILED_DIR },
    'agent de numérisation arrêté proprement',
  );
}

/** Message d'exploitation : chaque cas doit dire où aller corriger, pas seulement ce qui a raté. */
function authFailureHint(status: number, credentials: Credentials): string {
  if (credentials.kind === 'apiKey') {
    return status === 401
      ? 'clé de service refusée — SCAN_AGENT_API_KEY doit être identique ici et dans le .env du serveur (API redémarrée après le changement)'
      : "clé de service sans accès à la file — la route n'accepte pas la clé sur ce serveur, vérifiez sa version";
  }
  return status === 401
    ? `identifiants refusés pour « ${credentials.username} » — vérifiez SCAN_AGENT_USERNAME / SCAN_AGENT_PASSWORD (compte actif, mot de passe à jour)`
    : `compte « ${credentials.username} » sans accès à la file — ajoutez le menu /courriers/documents-scannes à son rôle`;
}

void main().catch((e: unknown) => {
  logger.error({ err: (e as Error).message }, "démarrage de l'agent impossible");
  process.exit(1);
});
