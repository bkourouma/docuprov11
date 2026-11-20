// Identifiant public (slug) d'une publication d'espace — fonctions PURES.

export const SLUG_MIN = 3;
export const SLUG_MAX = 120;
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Base de repli quand le libellé ne fournit aucun caractère exploitable (ex. « *** »). */
const FALLBACK_BASE = 'espace';

export function isValidSlug(slug: string): boolean {
  return slug.length >= SLUG_MIN && slug.length <= SLUG_MAX && SLUG_PATTERN.test(slug);
}

/**
 * Dérive un slug d'un libellé : minuscules, sans accents, séparateurs réduits à un tiret.
 * Le résultat est tronqué en laissant la place d'un suffixe numérique (`-999`).
 */
export function slugify(label: string): string {
  const base = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX - 8)
    .replace(/-+$/g, '');
  if (base.length < SLUG_MIN) return base ? `${FALLBACK_BASE}-${base}` : FALLBACK_BASE;
  return base;
}

/** Premier slug libre : `base`, puis `base-2`, `base-3`… */
export function nextAvailableSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
