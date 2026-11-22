import { sanitizeText, replaceAngles, truncateSafe } from '../workflow-agents/injection/untrusted';

// Docu-Flow W5 — chiffres lus dans la description (montants, seuils, délais, pourcentages) pour la relecture.
// Fonction pure : aucune E/S. Le texte cité est nettoyé et borné ; jamais d'interprétation hasardeuse (un chiffre
// sans unité reconnue n'est pas capté : références, dates, années, numéros).

export const FIGURES_MAX_LINES = 15;
export const FIGURES_QUOTE_MAX = 60;
const DESCRIPTION_SCAN_MAX = 8000;
const SUFFIX = '— à vérifier avant publication.';

/** Montant lu : valeur numérique, unité normalisée et texte cité. */
export interface WfFigureAmount {
  value: number;
  /** 'FCFA' | 'francs' | 'euros' | '' (aucune devise écrite). */
  unit: '' | 'FCFA' | 'francs' | 'euros';
  quote: string;
  index: number;
  end: number;
}

// Nombre : « 5 000 000 », « 5.000.000 », « 2,5 », « 5000000 ». Jamais précédé d'un chiffre, lettre, « / », « - » ou « , ».
const NUM = String.raw`(\d{1,3}(?:[ .]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)`;
const BEFORE = String.raw`(?<![\p{L}\p{N}/_.,-])`;
const SCALE_WORDS = String.raw`(milliards?|millions?|mds?|m|k)`;
const CURRENCY = String.raw`(f\s?cfa|fcfa|xof|francs?\s+cfa|francs?|€|euros?|eur)`;
const OF = String.raw`(?:(?:de|d['’])\s*)?`;

const MONEY_WITH_CURRENCY = new RegExp(
  String.raw`${BEFORE}${NUM}(?:\s*${SCALE_WORDS}(?![\p{L}]))?\s*${OF}${CURRENCY}(?![\p{L}])`,
  'giu',
);
const MONEY_SCALE_ONLY = new RegExp(String.raw`${BEFORE}${NUM}\s*(milliards?|millions?)(?![\p{L}])`, 'giu');
const PERCENT = new RegExp(String.raw`${BEFORE}${NUM}\s*(?:%|pour\s*cent(?![\p{L}])|pourcent(?![\p{L}]))`, 'giu');
const DURATION = new RegExp(
  String.raw`${BEFORE}(\d{1,4})\s*(jours?|heures?|semaines?|mois)(?![\p{L}])(?:\s+(ouvr[ée]e?s?|ouvrables?|calendaires?))?`,
  'giu',
);

/** Convertit « 5 000 000 », « 5.000.000 », « 2,5 » en nombre ; `null` si illisible. */
export function parseFrenchNumber(text: string): number | null {
  const t = text.trim();
  let normalized: string;
  if (/^\d{1,3}(?:[ .]\d{3})+(?:,\d+)?$/.test(t)) normalized = t.replace(/[ .]/g, '').replace(',', '.');
  else if (/^\d+(?:[.,]\d+)?$/.test(t)) normalized = t.replace(',', '.');
  else return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function scaleFactor(word: string | undefined): number {
  if (!word) return 1;
  const w = word.toLowerCase();
  if (w.startsWith('milliard') || w === 'md' || w === 'mds') return 1e9;
  if (w.startsWith('million') || w === 'm') return 1e6;
  if (w === 'k') return 1e3;
  return 1;
}

function normalizeUnit(raw: string | undefined): WfFigureAmount['unit'] {
  if (!raw) return '';
  const c = raw.toLowerCase().replace(/\s+/g, ' ');
  if (c === '€' || c.startsWith('euro') || c === 'eur') return 'euros';
  if (/cfa|xof/.test(c)) return 'FCFA';
  return 'francs';
}

/** Entier groupé par milliers avec une espace : 5000000 devient « 5 000 000 ». */
export function formatFrenchInteger(n: number): string {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? '-' : '';
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function cleanQuote(text: string): string {
  return truncateSafe(replaceAngles(sanitizeText(text)).replace(/\s+/g, ' ').trim(), FIGURES_QUOTE_MAX);
}

/** Montants d'argent lus dans la description, dans l'ordre d'apparition (sans doublon de position). */
export function findMoneyAmounts(description: string): WfFigureAmount[] {
  const text = sanitizeText(typeof description === 'string' ? description : '', DESCRIPTION_SCAN_MAX);
  const found: WfFigureAmount[] = [];
  const overlaps = (start: number, end: number): boolean => found.some((f) => start < f.end && end > f.index);

  for (const m of text.matchAll(MONEY_WITH_CURRENCY)) {
    const base = parseFrenchNumber(m[1] ?? '');
    if (base === null) continue;
    const value = Math.round(base * scaleFactor(m[2]));
    if (!Number.isSafeInteger(value)) continue;
    found.push({ value, unit: normalizeUnit(m[3]), quote: cleanQuote(m[0]), index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  for (const m of text.matchAll(MONEY_SCALE_ONLY)) {
    const index = m.index ?? 0;
    if (overlaps(index, index + m[0].length)) continue;
    const base = parseFrenchNumber(m[1] ?? '');
    if (base === null || !Number.isSafeInteger(Math.round(base * scaleFactor(m[2])))) continue;
    found.push({
      value: Math.round(base * scaleFactor(m[2])),
      unit: '',
      quote: cleanQuote(m[0]),
      index,
      end: index + m[0].length,
    });
  }
  return found.sort((a, b) => a.index - b.index);
}

function moneyLine(a: WfFigureAmount): string {
  const formatted = a.unit ? `${formatFrenchInteger(a.value)} ${a.unit}` : formatFrenchInteger(a.value);
  const same = a.quote.replace(/\s+/g, ' ').toLowerCase() === formatted.toLowerCase();
  const soit = same ? '' : ` soit ${formatted}`;
  return `Seuil lu dans la description : « ${a.quote} »${soit} ${SUFFIX}`.replace(/ {2,}/g, ' ');
}

/**
 * Repère les montants, pourcentages et délais de la description et renvoie des lignes de relecture en français.
 * Au plus 15 lignes, sans doublon. Les nombres sans unité reconnue (références, dates, années) sont ignorés.
 */
export function extractFigures(description: string): string[] {
  if (typeof description !== 'string' || description.length === 0) return [];
  const text = sanitizeText(description, DESCRIPTION_SCAN_MAX);
  const items: Array<{ index: number; line: string }> = [];

  const money = findMoneyAmounts(text);
  for (const a of money) items.push({ index: a.index, line: moneyLine(a) });

  const covered = (start: number, end: number): boolean => money.some((a) => start < a.end && end > a.index);

  for (const m of text.matchAll(PERCENT)) {
    const index = m.index ?? 0;
    if (covered(index, index + m[0].length)) continue;
    items.push({ index, line: `Pourcentage lu dans la description : « ${cleanQuote(m[0])} » ${SUFFIX}` });
  }
  for (const m of text.matchAll(DURATION)) {
    const index = m.index ?? 0;
    if (covered(index, index + m[0].length)) continue;
    // « à 10 heures » : heure de la journée, pas un délai.
    if (/^heures?$/i.test(m[2] ?? '') && /(?:^|[^\p{L}])à\s*$/iu.test(text.slice(Math.max(0, index - 4), index))) continue;
    items.push({ index, line: `Délai lu dans la description : « ${cleanQuote(m[0])} » ${SUFFIX}` });
  }

  items.sort((a, b) => a.index - b.index);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const { line } of items) {
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= FIGURES_MAX_LINES) break;
  }
  return lines;
}
