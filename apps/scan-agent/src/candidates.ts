import { extname } from 'node:path';

/**
 * Extensions acceptées — miroir strict de `ACCEPTED_EXTENSIONS` de
 * `apps/api/src/modules/courriers/mail-scanned.service.ts` (§07). Envoyer autre chose ne
 * produirait qu'un 400 : autant le filtrer sur le poste, sans traverser le réseau.
 */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.tif'] as const;

/** Content-Type posé sur la partie multipart (le serveur se fie à l'extension, pas à ce champ). */
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

/**
 * Suffixes des fichiers en cours d'écriture. Les pilotes de scanner et les navigateurs écrivent
 * d'abord sous un nom temporaire puis renomment : les prendre pour des scans revient à envoyer
 * des fichiers tronqués.
 */
const WORK_IN_PROGRESS = ['.tmp', '.temp', '.part', '.partial', '.crdownload', '.filepart'];

export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Le fichier est-il un scan à envoyer ? Rejette les fichiers cachés/système (`.`, `~$` d'Office)
 * et les temporaires, puis exige une extension acceptée par l'API.
 */
export function isCandidate(fileName: string): boolean {
  if (!fileName || fileName.startsWith('.') || fileName.startsWith('~$')) return false;
  const lower = fileName.toLowerCase();
  if (WORK_IN_PROGRESS.some((suffix) => lower.endsWith(suffix))) return false;
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extname(lower));
}

/** Observation d'un fichier à un instant donné. */
export interface Snapshot {
  size: number;
  mtimeMs: number;
  at: number;
}

/** Mémoire des observations entre deux balayages, indexée par nom de fichier. */
export type StabilityTracker = Map<string, Snapshot>;

/**
 * Le fichier a-t-il fini d'être écrit ? On ne se fie pas aux événements du système de fichiers
 * (peu fiables sur partage réseau et absents de certains pilotes) : un fichier est prêt quand sa
 * taille ET sa date de modification n'ont pas bougé depuis `stableMs`. Un fichier vide n'est
 * jamais prêt — c'est le fichier créé juste avant l'écriture du flux.
 *
 * Effet de bord assumé : met à jour `tracker` avec la première observation de l'état courant,
 * qui sert de point de départ au délai.
 */
export function markAndCheckStable(
  tracker: StabilityTracker,
  fileName: string,
  current: Snapshot,
  stableMs: number,
): boolean {
  const previous = tracker.get(fileName);
  if (!previous || previous.size !== current.size || previous.mtimeMs !== current.mtimeMs) {
    tracker.set(fileName, current); // le fichier bouge encore : le compteur repart de zéro
    return false;
  }
  if (current.size <= 0) return false;
  return current.at - previous.at >= stableMs;
}

/** Oublie les fichiers disparus du dossier, pour que le suivi ne grossisse pas indéfiniment. */
export function pruneTracker(
  tracker: Map<string, unknown>,
  presentFileNames: Iterable<string>,
): void {
  const present = new Set(presentFileNames);
  for (const name of [...tracker.keys()]) {
    if (!present.has(name)) tracker.delete(name);
  }
}
