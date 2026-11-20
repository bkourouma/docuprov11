import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { safeDocumentId } from './collab-working-state';

/** Plafond du registre par document : au-delà, plus aucune nouvelle mention n'est notifiée (anti-spam). */
export const MAX_REGISTRY_IDS = 5000;
/** Taille maximale du fichier relu (au-delà : considéré corrompu). 5000 ids tiennent largement dedans. */
const MAX_REGISTRY_BYTES = 128 * 1024;
const REGISTRY_VERSION = 1;

/** Registre relu : `corrupted` = fichier présent mais inexploitable (repart d'un registre vide). */
export interface MentionRegistry {
  ids: Set<number>;
  corrupted: boolean;
}

/**
 * Registre SERVEUR des mentions déjà notifiées : `ARCHIVES/collab/<id>.mentions.json`, HORS du
 * Y.Doc (un écrivain ne peut ni le réécrire pour faire re-notifier, ni le vider ou le remplir pour
 * faire taire une notification). Le chemin n'est construit que depuis l'entier de document validé
 * (`safeDocumentId`) ; écriture atomique (fichier temporaire puis `rename`) ; taille bornée.
 *
 * L'appelant sérialise les accès d'un même document (verrou par document).
 */
export class MentionRegistryStore {
  private readonly dir: string;

  constructor(archivesRoot: string) {
    this.dir = join(resolve(archivesRoot), 'collab');
  }

  private path(documentId: number): string {
    return join(this.dir, `${safeDocumentId(documentId)}.mentions.json`);
  }

  /** Jamais d'exception pour un fichier absent ou abîmé : registre vide (`corrupted` pour le second cas). */
  async read(documentId: number): Promise<MentionRegistry> {
    const file = this.path(documentId);
    let raw: string;
    try {
      const buffer = await readFile(file);
      if (buffer.length > MAX_REGISTRY_BYTES) return { ids: new Set(), corrupted: true };
      raw = buffer.toString('utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ids: new Set(), corrupted: false };
      return { ids: new Set(), corrupted: true };
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; ids?: unknown };
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed.version !== REGISTRY_VERSION ||
        !Array.isArray(parsed.ids) ||
        parsed.ids.length > MAX_REGISTRY_IDS
      ) {
        return { ids: new Set(), corrupted: true };
      }
      const ids = new Set<number>();
      for (const v of parsed.ids) {
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
          return { ids: new Set(), corrupted: true };
        }
        ids.add(v);
      }
      return { ids, corrupted: false };
    } catch {
      return { ids: new Set(), corrupted: true };
    }
  }

  /** Écrit atomiquement ; jette si le registre dépasse le plafond (l'appelant doit l'avoir borné). */
  async write(documentId: number, ids: ReadonlySet<number>): Promise<void> {
    if (ids.size > MAX_REGISTRY_IDS) throw new Error('Registre de mentions trop volumineux');
    const target = this.path(documentId);
    const sorted = [...ids].sort((a, b) => a - b);
    const data = JSON.stringify({ version: REGISTRY_VERSION, ids: sorted });
    await mkdir(this.dir, { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, target);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }
}
