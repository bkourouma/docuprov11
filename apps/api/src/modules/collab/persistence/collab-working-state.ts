import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EDITOR_LIMITS } from '@archivage/editor';

/** Plus grand identifiant de document admis (entier 32 bits signé, comme la colonne `document_id`). */
const MAX_DOCUMENT_ID = 2_147_483_647;

/** État de travail relu depuis le disque (déjà contrôlé : taille et empreinte). */
export interface WorkingState {
  state: Buffer;
  baseVersionId: number;
}

interface WorkingMeta {
  baseVersionId: number;
  byteLength: number;
  sha256: string;
  savedAt: string;
}

/**
 * Valide l'identifiant et le renvoie en décimal strict. SEUL point d'entrée des noms de fichier :
 * aucun fragment venu de l'extérieur n'entre dans un chemin (pas de traversée possible).
 */
export function safeDocumentId(documentId: unknown): string {
  if (
    typeof documentId !== 'number' ||
    !Number.isSafeInteger(documentId) ||
    documentId < 1 ||
    documentId > MAX_DOCUMENT_ID
  ) {
    throw new Error('Identifiant de document invalide');
  }
  return String(documentId);
}

/**
 * État de travail (autosave) des documents texte : `ARCHIVES/collab/<id>.bin` (état Yjs) et
 * `<id>.json` (métadonnées : version de base, taille, empreinte). Écriture atomique (fichier
 * temporaire puis `rename`). Les métadonnées sont écrites EN DERNIER et portent l'empreinte du
 * `.bin` : une coupure entre les deux renommages laisse un couple incohérent, détecté et ignoré
 * à la lecture (on retombe alors sur l'état de la version courante, jamais sur un état mélangé).
 */
export class WorkingStateStore {
  private readonly dir: string;

  constructor(archivesRoot: string) {
    this.dir = join(resolve(archivesRoot), 'collab');
  }

  private paths(documentId: number) {
    const id = safeDocumentId(documentId);
    return { bin: join(this.dir, `${id}.bin`), meta: join(this.dir, `${id}.json`) };
  }

  private async atomicWrite(target: string, data: Buffer | string): Promise<void> {
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, target);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  async write(documentId: number, state: Uint8Array, baseVersionId: number): Promise<void> {
    const { bin, meta } = this.paths(documentId);
    if (!Number.isSafeInteger(baseVersionId) || baseVersionId < 1) {
      throw new Error('Version de base invalide');
    }
    if (state.byteLength > EDITOR_LIMITS.MAX_STATE_BYTES) {
      throw new Error('État du document trop volumineux');
    }
    const buffer = Buffer.from(state.buffer, state.byteOffset, state.byteLength);
    const metadata: WorkingMeta = {
      baseVersionId,
      byteLength: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      savedAt: new Date().toISOString(),
    };
    await mkdir(this.dir, { recursive: true });
    await this.atomicWrite(bin, buffer);
    await this.atomicWrite(meta, JSON.stringify(metadata));
  }

  /** `null` si absent, illisible, incohérent ou trop gros (jamais d'exception pour un fichier abîmé). */
  async read(documentId: number): Promise<WorkingState | null> {
    const { bin, meta } = this.paths(documentId);
    try {
      const parsed = JSON.parse(await readFile(meta, 'utf8')) as Partial<WorkingMeta>;
      if (
        !parsed ||
        typeof parsed.baseVersionId !== 'number' ||
        !Number.isSafeInteger(parsed.baseVersionId) ||
        typeof parsed.byteLength !== 'number' ||
        typeof parsed.sha256 !== 'string' ||
        parsed.byteLength > EDITOR_LIMITS.MAX_STATE_BYTES
      ) {
        return null;
      }
      const state = await readFile(bin);
      if (state.length !== parsed.byteLength) return null;
      if (createHash('sha256').update(state).digest('hex') !== parsed.sha256) return null;
      return { state, baseVersionId: parsed.baseVersionId };
    } catch {
      return null;
    }
  }

  async remove(documentId: number): Promise<void> {
    const { bin, meta } = this.paths(documentId);
    for (const file of [meta, bin]) {
      try {
        await unlink(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }
}
