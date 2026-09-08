import { extname } from 'node:path';

/** Sous-dossiers de service créés dans le dossier surveillé (ignorés au balayage : ce sont des dossiers). */
export const SENT_DIR = '_envoyes';
export const FAILED_DIR = '_erreurs';

/**
 * Dossier de classement des envois réussis : `_envoyes/AAAA-MM-JJ`. En UTC comme tous les
 * horodatages du projet — le déploiement de référence est à UTC+0, et c'est une trace technique,
 * pas une date métier (la date métier du courrier est saisie à l'enregistrement §05).
 */
export function sentSubdir(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Nom de repli en cas de collision : `scan.pdf` → `scan (2).pdf`, `scan (3).pdf`… Deux scans du
 * même jour portant le nom par défaut du pilote (`image.pdf`) sont la norme, pas l'exception :
 * écraser reviendrait à perdre un courrier déjà accepté par le serveur.
 */
export function nthName(fileName: string, n: number): string {
  if (n <= 1) return fileName;
  const ext = extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${stem} (${n})${ext}`;
}

/** Contenu du fichier `.motif.txt` déposé à côté d'un scan mis en quarantaine. */
export function failureNote(fileName: string, reason: string, at: Date): string {
  return [
    `Fichier      : ${fileName}`,
    `Mis en quarantaine : ${at.toISOString()}`,
    `Motif        : ${reason}`,
    '',
    'Corrigez la cause puis remettez le fichier dans le dossier surveillé pour un nouvel essai.',
    '',
  ].join('\n');
}
