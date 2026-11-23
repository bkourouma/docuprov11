/**
 * Suffixe unique pour les données créées par les aides (qui n'ont pas accès à la fixture `uniq`).
 * Horodatage base 36 + aléa : unique entre workers parallèles et entre exécutions successives
 * sur une même base (les données E2E ne sont jamais purgées entre deux tests).
 */
let counter = 0;

export function uniqueSuffix(): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

/** Version « identifiant » : minuscules ASCII, chiffres et tirets uniquement. */
export function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Date du jour (UTC) au format AAAA-MM-JJ, celui qu'attend l'API (`z.coerce.date`). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
