/**
 * Champs comparables des pièces et normalisation DÉTERMINISTE (en code, jamais par le modèle).
 * Montants à 2 décimales, dates ISO, références sans ponctuation, textes sans accents ni casse.
 */
export const COMPARE_FIELDS = ['montant', 'date', 'reference', 'objet', 'tiers'] as const;
export type CompareField = (typeof COMPARE_FIELDS)[number];

/** Retire accents, passe en minuscules (comparaison de libellés et de textes). */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Classement d'un libellé de métadonnée vers un champ comparable (premier motif gagnant)
// ---------------------------------------------------------------------------
const META_PATTERNS: ReadonlyArray<[CompareField, RegExp]> = [
  ['montant', /\b(montant|somme|total|prix|amount|ttc|ht|valeur)\b/],
  ['date', /\b(date|echeance|emission)\b/],
  ['tiers', /\b(tiers|fournisseur|client|emetteur|expediteur|partenaire|beneficiaire|vendeur|prestataire|societe)\b/],
  ['objet', /\b(objet|titre|libelle|subject|designation|sujet)\b/],
  ['reference', /\b(reference|ref|numero|n|no|facture|contrat|bon)\b/],
];

/** Champ comparable correspondant à un libellé de métadonnée, ou `null`. */
export function classifyMetadataLabel(label: string): CompareField | null {
  const words = fold(label).replace(/[^a-z0-9]+/g, ' ');
  for (const [field, pattern] of META_PATTERNS) {
    if (pattern.test(words)) return field;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Montant : nombre à 2 décimales ("1234.50"), ou `null` si illisible. */
export function normalizeAmount(raw: string): string | null {
  // `\s` couvre déjà l'espace insécable et l'espace fine insécable (séparateurs de milliers).
  let s = raw.replace(/\s/g, '');
  s = s.replace(/[^0-9.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const negative = s.startsWith('-');
  s = s.replace(/-/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimalAt = -1;
  if (lastComma >= 0 && lastDot >= 0) {
    decimalAt = Math.max(lastComma, lastDot);
  } else if (lastComma >= 0) {
    const count = (s.match(/,/g) ?? []).length;
    decimalAt = count === 1 ? lastComma : -1; // une virgule seule : décimale (usage français)
  } else if (lastDot >= 0) {
    const count = (s.match(/\./g) ?? []).length;
    const after = s.length - lastDot - 1;
    // un point suivi d'exactement 3 chiffres et précédé d'au plus 3 chiffres : séparateur de milliers
    decimalAt = count === 1 && !(after === 3 && lastDot >= 1 && lastDot <= 3) ? lastDot : -1;
  }
  let intPart: string;
  let fracPart = '';
  if (decimalAt >= 0) {
    intPart = s.slice(0, decimalAt).replace(/[.,]/g, '');
    fracPart = s.slice(decimalAt + 1).replace(/[.,]/g, '');
  } else {
    intPart = s.replace(/[.,]/g, '');
  }
  if (intPart === '') intPart = '0';
  if (!/^\d+$/.test(intPart) || (fracPart !== '' && !/^\d+$/.test(fracPart))) return null;
  const value = Number(`${intPart}.${fracPart || '0'}`);
  if (!Number.isFinite(value)) return null;
  const fixed = value.toFixed(2);
  return negative && value !== 0 ? `-${fixed}` : fixed;
}

const MONTHS: Record<string, number> = {
  janvier: 1,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
};

function validIso(year: number, month: number, day: number): string | null {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/** Date : AAAA-MM-JJ, ou `null` si illisible (jj/mm/aaaa, jj-mm-aaaa, jj.mm.aaaa, « 12 mars 2026 »). */
export function normalizeDate(raw: string): string | null {
  const s = fold(raw).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t\s].*)?$/.exec(s);
  if (m) return validIso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return validIso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})(?:er)?\s+([a-z]+)\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2]]) return validIso(Number(m[3]), MONTHS[m[2]], Number(m[1]));
  return null;
}

/** Référence : sans accents, majuscules, uniquement lettres et chiffres ; préfixe « n° » ignoré. */
export function normalizeReference(raw: string): string | null {
  const s = fold(raw)
    .replace(/^\s*(?:n\s*[°º]|no\s*[.:]|num(?:ero)?\s*[.:°º]|ref(?:erence)?\s*[.:])\s*/, '')
    .replace(/[^a-z0-9]/g, '');
  return s === '' ? null : s.toUpperCase();
}

/** Texte libre : sans accents ni casse, ponctuation et espaces multiples réduits. */
export function normalizeText(raw: string): string | null {
  const s = fold(raw)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return s === '' ? null : s;
}

/**
 * Valeur normalisée d'un champ. Une valeur illisible garde une forme textuelle préfixée (`brut:`) pour ne
 * jamais être déclarée égale à une valeur lue.
 */
export function normalizeField(field: CompareField, raw: string): string {
  let norm: string | null;
  switch (field) {
    case 'montant':
      norm = normalizeAmount(raw);
      break;
    case 'date':
      norm = normalizeDate(raw);
      break;
    case 'reference':
      norm = normalizeReference(raw);
      break;
    default:
      norm = normalizeText(raw);
  }
  return norm ?? `brut:${normalizeText(raw) ?? raw.trim()}`;
}
