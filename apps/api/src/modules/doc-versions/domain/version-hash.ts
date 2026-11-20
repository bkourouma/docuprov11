import { createHash } from 'node:crypto';

/** SHA-256 hexadécimal (minuscules) d'un contenu binaire. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Empreinte d'une VERSION à partir des empreintes de ses pièces, DÉJÀ rangées dans l'ordre
 * `sort_order` par l'appelant.
 *
 *  - une seule pièce : son SHA-256 tel quel (donc comparable à `document_file.hash`) ;
 *  - plusieurs : SHA-256 de la concaténation des empreintes séparées par `\n` (l'ordre compte :
 *    réordonner les pièces change le contenu de la version) ;
 *  - aucune pièce : liste vide refusée, une version sans contenu n'a pas d'empreinte.
 */
export function computeVersionHash(fileHashes: string[]): string {
  if (fileHashes.length === 0) {
    throw new Error("Aucune empreinte de pièce : impossible de calculer l'empreinte de version");
  }
  if (fileHashes.length === 1) return fileHashes[0];
  return createHash('sha256').update(fileHashes.join('\n')).digest('hex');
}
