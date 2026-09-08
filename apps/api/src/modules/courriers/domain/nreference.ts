/**
 * Génération du numéro d'enregistrement `NReference` (§05 / §19).
 *
 * Format source : max des NReference numériques existants + 1, sur 5 chiffres (`ToString("D5")`
 * → "00001", "00002", …). Repli "00001" si aucun.
 *
 * La PORTÉE de l'ensemble `existing` est décidée par l'appelant (service, phase C) :
 *   - Arrivée (§05) : registre GLOBAL du bureau d'ordre.
 *   - Départ (§19) : uniquement les Départs du MÊME type — corrige le bug de numérotation globale
 *     du `GetNextNReference()` source. L'unicité par type est en outre garantie en base par
 *     l'index partiel `ux_mail_nreference_per_type`.
 *
 * Fonctions pures : la sûreté vis-à-vis de la concurrence (max+1 non transactionnel de la source)
 * est traitée côté service (transaction + contrainte d'unicité + retry).
 */

export const NREFERENCE_WIDTH = 5;
export const NREFERENCE_FALLBACK = '00001';

/** Parse la partie numérique d'un NReference ("00042" → 42) ; null si non strictement numérique. */
export function parseReferenceNumber(nref: string | null | undefined): number | null {
  if (nref == null) return null;
  const trimmed = nref.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/** Formate un numéro sur `width` chiffres (D5 par défaut) : 1 → "00001". */
export function formatReference(n: number, width = NREFERENCE_WIDTH): string {
  return String(n).padStart(width, '0');
}

/** Prochain numéro = max des numéros existants + 1 (1 si aucun numéro valide). */
export function nextReferenceNumber(existing: readonly (string | null | undefined)[]): number {
  const max = existing.reduce<number>((acc, r) => {
    const n = parseReferenceNumber(r);
    return n !== null && n > acc ? n : acc;
  }, 0);
  return max + 1;
}

/** Prochain NReference formaté (D5) sur l'ensemble `existing` fourni par l'appelant. */
export function nextReference(existing: readonly (string | null | undefined)[]): string {
  return formatReference(nextReferenceNumber(existing));
}
