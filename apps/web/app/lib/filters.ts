/**
 * Recherche dans les Select / TreeSelect insensible a la casse ET aux accents
 * (e accentue = e, etc.). antd ne normalise pas les diacritiques par defaut, d'ou ces helpers.
 */

/** Minuscule + suppression des accents (NFD puis retrait des diacritiques). */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** `filterOption` d'un <Select> : compare l'option (label) a la saisie, sans casse ni accents. */
export function filterByLabel(input: string, option?: { label?: unknown }): boolean {
  return normalizeText(String(option?.label ?? '')).includes(normalizeText(input));
}

/** `filterTreeNode` d'un <TreeSelect> : compare le titre du noeud a la saisie, sans casse ni accents. */
export function filterByTitle(input: string, node: { title?: unknown }): boolean {
  return normalizeText(String(node?.title ?? '')).includes(normalizeText(input));
}
