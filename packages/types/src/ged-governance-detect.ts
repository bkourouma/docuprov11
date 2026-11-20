import {
  applyAiMasking,
  GED_AI_DEFAULT_MASKING_REPLACEMENT,
  GED_AI_MASKING_ENTITIES,
  GED_AI_MASKING_ENTITY_MARKERS,
  GED_AI_MASKING_MAX_TEXT_CHARS,
  GedAiMaskingKind,
  type GedAiMaskingRuleDef,
} from './ged';
import {
  GED_GOVERNANCE_CONTEXT_RADIUS,
  GED_GOVERNANCE_MAX_TEXT_CHARS,
  GOVERNANCE_PII_ENTITIES,
  GOVERNANCE_SENSITIVITY_REASONS,
  governanceSensitivityOutputSchema,
  type GovernancePiiEntity,
  type GovernancePiiFinding,
  type GovernanceSensitivityOutput,
  type GovernanceSensitivityReason,
  type GovernanceSensitivityScore,
} from './ged-governance';

// ===========================================================================
// Détection déterministe des données personnelles et de la sensibilité (lot 5)
// ===========================================================================
// Fonctions pures, sans effet de bord, sans dépendance hors zod / ./ged. Aucune ne renvoie une
// valeur brute (e-mail, IBAN, téléphone, carte, NIR, identifiant) : seuls des comptes et des
// extraits MASQUÉS sortent de `detectPii`.
//
// LIMITES CONNUES
// - Les noms de personnes ne sont jamais détectés ici (`name` est réservé au modèle IA) ; seul le
//   masquage des « civilité + nom » protège les extraits.
// - Un numéro de téléphone local sans indicatif ni zéro initial (« 77 123 45 67 ») n'est pas détecté.
// - Un numéro de facture de 10 chiffres collés commençant par 0 est pris pour un téléphone (confiance 0,6).
// - Les e-mails obfusqués (« jean [at] exemple »), IBAN à clé fausse, cartes à clé de Luhn fausse
//   et pièces d'identité sans mot-clé sont volontairement ignorés.

/** Niveau de confidentialité actif (table `confidentialite`). */
export interface GovernanceConfidentialiteLevel {
  confidentialiteId: number;
  label: string;
  rank: number;
}

// ---------------------------------------------------------------------------
// Texte d'entrée
// ---------------------------------------------------------------------------

/** Plafonne puis normalise en NFKC (chiffres et « @ » pleine chasse, espaces insécables → espace). */
function prepareText(text: unknown): string {
  if (typeof text !== 'string') return '';
  const cut = text.length > GED_GOVERNANCE_MAX_TEXT_CHARS ? text.slice(0, GED_GOVERNANCE_MAX_TEXT_CHARS) : text;
  const normalized = cut.normalize('NFKC');
  return normalized.length > GED_GOVERNANCE_MAX_TEXT_CHARS
    ? normalized.slice(0, GED_GOVERNANCE_MAX_TEXT_CHARS)
    : normalized;
}

type DetectedEntity = Exclude<GovernancePiiEntity, 'name'>;

interface Hit {
  entity: DetectedEntity;
  start: number;
  end: number;
  confidence: number;
}

const isFree = (occupied: Uint8Array, start: number, end: number): boolean => {
  for (let i = start; i < end; i += 1) if (occupied[i] === 1) return false;
  return true;
};

const digitsOf = (s: string): string => s.replace(/\D/g, '');

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

const RX_EMAIL =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.){1,6}\p{L}{2,24}(?![\p{L}\p{N}-])/gu;

/** Extensions de fichiers qui, après un « @ », trahissent un nom de fichier (logo@2x.png). */
const FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'css', 'js', 'ts', 'json', 'pdf', 'doc',
  'docx', 'xls', 'xlsx', 'zip', 'html', 'htm', 'xml', 'txt', 'mp3', 'mp4', 'woff', 'woff2', 'tif', 'tiff',
]);

function isPlausibleEmail(value: string): boolean {
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (tld.length < 2 || FILE_EXTENSIONS.has(tld)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Pièces d'identité (ancrées sur un mot-clé)
// ---------------------------------------------------------------------------

const IDENTITY_KEYWORDS = String.raw`carte[ \t]+(?:nationale[ \t]+)?d['’]identit[ée]|carte[ \t]+d['’][ée]lecteur|carte[ \t]+consulaire|pi[èe]ce[ \t]+d['’]identit[ée]|titre[ \t]+de[ \t]+s[ée]jour|permis[ \t]+de[ \t]+conduire|passeport|cnib|cni|cin|nin`;
/** Groupe 1 : tout ce qui précède l'identifiant (mot-clé, « n° », « : »…) ; groupe 2 : l'identifiant. */
const RX_IDENTITY = new RegExp(
  String.raw`((?<![\p{L}\p{N}])(?:${IDENTITY_KEYWORDS})(?![\p{L}\p{N}])(?:[ \t]+[\p{L}'’\-]{2,20}){0,2}[ \t]*(?:(?:n°|num[ée]ro|no\.?|num\.?)[ \t]*:?|:)[ \t]*)([A-Z0-9]{6,14})(?![\p{L}\p{N}])`,
  'giu',
);

/** Identifiants ancrés trouvés dans `text` : plages [début, fin[ de l'identifiant SEUL. */
function findIdentityRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(RX_IDENTITY)) {
    const id = m[2] ?? '';
    if (digitsOf(id).length < 4) continue;
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    out.push([start, start + id.length]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// IBAN
// ---------------------------------------------------------------------------

const RX_IBAN =
  /(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?![\p{L}\p{N}])/giu;

/** Longueurs IBAN connues (pays francophones et principaux voisins) ; autre pays : 15 à 34 admis. */
const IBAN_LENGTHS: Record<string, number> = {
  FR: 27, BE: 16, LU: 20, CH: 21, DE: 22, GB: 22, ES: 24, IT: 27, NL: 18, PT: 25, MC: 27,
  CI: 28, SN: 28, ML: 28, BF: 28, BJ: 28, TG: 28, NE: 28, GW: 25, CM: 27, MA: 28, TN: 24, DZ: 26,
  GA: 27, CG: 27, CF: 27, TD: 27, GQ: 27, MG: 27, MR: 27, EG: 29,
};

/** Clé IBAN : réarrangement puis mod 97 = 1 (calcul itératif, sans grands entiers). */
function ibanIsValid(compact: string): boolean {
  if (compact.length < 15 || compact.length > 34) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  const expected = IBAN_LENGTHS[compact.slice(0, 2)];
  if (expected !== undefined && expected !== compact.length) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i += 1) {
    const code = rearranged.charCodeAt(i);
    const value = code >= 65 ? code - 55 : code - 48;
    remainder = value >= 10 ? (remainder * 100 + value) % 97 : (remainder * 10 + value) % 97;
  }
  return remainder === 1;
}

// ---------------------------------------------------------------------------
// NIR (sécurité sociale française)
// ---------------------------------------------------------------------------

/** 1|2, année, mois (01-12 ou 20-99), département (dont 2A/2B), commune, ordre, clé ; séparateur uniforme. */
const RX_NIR =
  /(?<![\p{L}\p{N}])(?<!\d ?)([12])( ?)(\d{2})\2(0[1-9]|1[0-2]|[2-9]\d)\2(\d{2}|2[AB])\2(\d{3})\2(\d{3})\2(\d{2})(?![\p{L}\p{N}])(?! ?\d)/giu;

/** Clé attendue : 97 − (n mod 97), Corse 2A → 19 et 2B → 18. */
function nirKeyIsValid(parts: readonly string[]): boolean {
  const body = [parts[1], parts[3], parts[4], parts[5], parts[6], parts[7]]
    .join('')
    .toUpperCase()
    .replace('2A', '19')
    .replace('2B', '18');
  if (!/^\d{13}$/.test(body)) return false;
  let r = 0;
  for (let i = 0; i < body.length; i += 1) r = (r * 10 + (body.charCodeAt(i) - 48)) % 97;
  return 97 - r === Number(parts[8]);
}

// ---------------------------------------------------------------------------
// Téléphone
// ---------------------------------------------------------------------------

/** Indicatifs pays plausibles (E.164) : les codes sont sans préfixe commun, on teste 1 à 3 chiffres. */
const COUNTRY_CODES: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  const add = (...codes: number[]) => codes.forEach((c) => set.add(String(c)));
  const range = (from: number, to: number) => {
    for (let c = from; c <= to; c += 1) set.add(String(c));
  };
  add(1, 7, 20, 27, 30, 31, 32, 33, 34, 36, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49, 81, 82, 84, 86, 98);
  range(51, 58);
  range(60, 66);
  range(90, 95);
  add(211, 212, 213, 216, 218);
  range(220, 258);
  range(260, 269);
  add(290, 291, 297, 298, 299);
  range(350, 359);
  range(370, 389);
  add(420, 421, 423);
  range(500, 509);
  range(590, 599);
  range(670, 692);
  add(850, 852, 853, 855, 856, 880, 886);
  range(960, 968);
  range(970, 977);
  range(992, 996);
  add(998);
  return set;
})();

const countryCodeOf = (digits: string): string | null => {
  for (let len = 1; len <= 3; len += 1) {
    const prefix = digits.slice(0, len);
    if (COUNTRY_CODES.has(prefix)) return prefix;
  }
  return null;
};

/** Ni collé à une lettre/chiffre/« + », ni à un identifiant (« REF-… »), ni à la suite d'un montant. */
const PHONE_LB = String.raw`(?<![\p{L}\p{N}+])(?<![\p{L}\p{N}][-_/])(?<!\d[ .,])`;
const RX_PHONE_INTL = new RegExp(
  String.raw`${PHONE_LB}(?:\+|00)[ ]?[1-9]\d{0,2}(?:[ .\-]?\(0\))?(?:[ .\-]?\d){5,13}(?![ .\-]?\d)`,
  'gu',
);
/** 0X puis 4 paires de chiffres, même séparateur partout (ou aucun) : écarte « 01-03-2024 12 ». */
const RX_PHONE_FR = new RegExp(
  String.raw`${PHONE_LB}0[1-9]([ .\-]?)\d{2}\1\d{2}\1\d{2}\1\d{2}(?![ .\-]?\d)`,
  'gu',
);

function isPlausibleInternational(raw: string): boolean {
  let digits = digitsOf(raw.replace(/\(0\)/g, ''));
  if (raw.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 9 || digits.length > 15) return false;
  const code = countryCodeOf(digits);
  if (code === null) return false;
  if (code === '33' && digits.length !== 11) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Carte bancaire
// ---------------------------------------------------------------------------

const RX_CARD = /(?<!\d[ -]?)\d(?:[ -]?\d){12,18}(?![ -]?\d)/gu;

function luhnIsValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Sans séparateur, ou découpage usuel : 4-4-4-4 (…), 4-6-5 (American Express), dernier groupe de 1 à 4. */
function cardGroupingIsPlausible(raw: string): boolean {
  if (!/[ -]/.test(raw)) return true;
  const groups = raw.split(/[ -]/);
  if (groups.length === 3) return groups[0]!.length === 4 && groups[1]!.length === 6 && groups[2]!.length === 5;
  return groups.every((g, i) => (i < groups.length - 1 ? g.length === 4 : g.length >= 1 && g.length <= 4));
}

// ---------------------------------------------------------------------------
// Détection
// ---------------------------------------------------------------------------

const FAMILY_CONTEXT_LIMIT = 3;
const CONTEXT_MAX_CHARS = 400;

function collectHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const occupied = new Uint8Array(text.length);
  const accept = (entity: DetectedEntity, start: number, end: number, confidence: number): void => {
    if (!isFree(occupied, start, end)) return;
    occupied.fill(1, start, end);
    hits.push({ entity, start, end, confidence });
  };

  // 1. E-mail (en premier : sa partie locale peut ressembler à un numéro).
  for (const m of text.matchAll(RX_EMAIL)) {
    if (isPlausibleEmail(m[0])) accept('email', m.index ?? 0, (m.index ?? 0) + m[0].length, 0.9);
  }

  // 2. Pièces d'identité ancrées (avant le téléphone : « CNI n° 0123456789 » n'est pas un téléphone).
  for (const [start, end] of findIdentityRanges(text)) accept('identity', start, end, 0.7);

  // 3. IBAN : clé mod 97 valide exigée, sinon rien.
  for (const m of text.matchAll(RX_IBAN)) {
    const compact = m[0].replace(/ /g, '').toUpperCase();
    if (ibanIsValid(compact)) accept('iban', m.index ?? 0, (m.index ?? 0) + m[0].length, 1);
  }

  // 4. NIR : forme valide ; clé juste 0,95, clé fausse 0,5.
  for (const m of text.matchAll(RX_NIR)) {
    const confidence = nirKeyIsValid(m) ? 0.95 : 0.5;
    accept('nir', m.index ?? 0, (m.index ?? 0) + m[0].length, confidence);
  }

  // 5. Téléphone.
  for (const m of text.matchAll(RX_PHONE_INTL)) {
    if (isPlausibleInternational(m[0])) accept('phone', m.index ?? 0, (m.index ?? 0) + m[0].length, 0.9);
  }
  for (const m of text.matchAll(RX_PHONE_FR)) {
    accept('phone', m.index ?? 0, (m.index ?? 0) + m[0].length, m[1] === '' ? 0.6 : 0.9);
  }

  // 6. Carte bancaire : Luhn valide exigé (en dernier : ne revendique pas un NIR ou un téléphone).
  for (const m of text.matchAll(RX_CARD)) {
    const digits = digitsOf(m[0]);
    if (digits.length < 13 || digits.length > 19) continue;
    if (/^(\d)\1+$/.test(digits)) continue;
    if (!cardGroupingIsPlausible(m[0]) || !luhnIsValid(digits)) continue;
    accept('card', m.index ?? 0, (m.index ?? 0) + m[0].length, 0.9);
  }

  return hits.sort((a, b) => a.start - b.start);
}

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * Fenêtre masquée autour d'une occurrence : rayon `GED_GOVERNANCE_CONTEXT_RADIUS`, coupée aux
 * frontières de mots, ÉLARGIE pour ne jamais trancher une valeur détectée, puis chaque valeur
 * détectée est remplacée par son marqueur AVANT le masquage général (aucune valeur brute ne sort).
 */
function buildContext(
  text: string,
  target: Hit,
  hits: readonly Hit[],
  protectedSpans: ReadonlyArray<readonly [number, number]>,
): string {
  const radius = GED_GOVERNANCE_CONTEXT_RADIUS;
  let start = Math.max(0, target.start - radius);
  let end = Math.min(text.length, target.end + radius);
  if (start > 0 && !isSpace(text[start - 1]) && !isSpace(text[start])) {
    while (start < target.start && !isSpace(text[start])) start += 1;
  }
  if (end < text.length && !isSpace(text[end - 1]) && !isSpace(text[end])) {
    while (end > target.end && !isSpace(text[end - 1])) end -= 1;
  }
  for (const h of hits) {
    if (h.start < start && start < h.end) start = h.start;
    if (h.start < end && end < h.end) end = h.end;
  }
  // Un nom (civilité + mots) n'est jamais tranché non plus : sinon un fragment sortirait non masqué.
  for (const [from, to] of protectedSpans) {
    if (from < start && start < to) start = from;
    if (from < end && end < to) end = to;
  }
  let out = '';
  let cursor = start;
  for (const h of hits) {
    if (h.end <= start || h.start >= end) continue;
    out += text.slice(cursor, h.start) + GED_AI_MASKING_ENTITY_MARKERS[h.entity];
    cursor = h.end;
  }
  out += text.slice(cursor, end);
  return maskPiiContextText(out.replace(/\s+/g, ' ').trim()).slice(0, CONTEXT_MAX_CHARS);
}

/**
 * Détecte les familles de données personnelles d'un texte (jamais `name`). Une entrée par famille
 * trouvée, dans l'ordre de `GOVERNANCE_PII_ENTITIES` ; `count` = occurrences retenues,
 * `confidence` = la plus haute des occurrences. Confiances : e-mail 0,9 ; téléphone 0,9 (indicatif
 * ou format séparé) ou 0,6 (10 chiffres collés) ; IBAN 1 (clé valide seulement) ; carte 0,9 (Luhn
 * valide seulement) ; NIR 0,95 (clé valide) ou 0,5 ; pièce d'identité ancrée 0,7.
 */
export function detectPii(text: string): GovernancePiiFinding[] {
  const prepared = prepareText(text);
  if (prepared.length === 0) return [];
  const hits = collectHits(prepared);
  const protectedSpans: Array<readonly [number, number]> = [];
  if (hits.length > 0) {
    for (const m of prepared.matchAll(RX_CIVILITY_NAME)) protectedSpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const findings: GovernancePiiFinding[] = [];
  for (const entity of GOVERNANCE_PII_ENTITIES) {
    if (entity === 'name') continue;
    const family = hits.filter((h) => h.entity === entity);
    if (family.length === 0) continue;
    const contexts: string[] = [];
    for (const hit of family) {
      if (contexts.length >= FAMILY_CONTEXT_LIMIT) break;
      const context = buildContext(prepared, hit, hits, protectedSpans);
      if (context.length > 0 && !contexts.includes(context)) contexts.push(context);
    }
    findings.push({
      entity,
      count: family.length,
      confidence: Math.max(...family.map((h) => h.confidence)),
      contexts,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Masquage des extraits
// ---------------------------------------------------------------------------

const NAME_MARKER = '[NOM]';
const NAME_WORD = String.raw`(?:\p{Lu}\.|\p{Lu}[\p{L}\p{M}'’\-]*)`;
/** Civilité (M., Mme, Mlle, Monsieur, Madame, Dr, Pr, Me…) suivie de 1 à 3 mots capitalisés. */
const RX_CIVILITY_NAME = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:MM\.|M\.|Mme\.?|MME\.?|Mlle\.?|MLLE\.?|Monsieur|MONSIEUR|Madame|MADAME|Mademoiselle|Docteur|Professeur|Ma[îi]tre|Dr\.?|Pr\.?|Me\.?)[ \t]+${NAME_WORD}(?:[ \t]+${NAME_WORD}){0,2}`,
  'gu',
);

const MASKING_RULES: readonly GedAiMaskingRuleDef[] = GED_AI_MASKING_ENTITIES.map((entity) => ({
  kind: GedAiMaskingKind.Entite,
  pattern: entity,
}));

const MASK_PASSES_MAX = 4;

function maskOnce(input: string): string {
  let text = input;
  // 1. Identifiants ancrés par mot-clé (le mot-clé reste, la valeur disparaît).
  const ranges = findIdentityRanges(text);
  if (ranges.length > 0) {
    let out = '';
    let cursor = 0;
    for (const [start, end] of ranges) {
      out += text.slice(cursor, start) + GED_AI_MASKING_ENTITY_MARKERS.identity;
      cursor = end;
    }
    text = out + text.slice(cursor);
  }
  // 2. Civilité + nom (avant le masquage général, qui les remplacerait par [IDENTITÉ]).
  text = text.replace(RX_CIVILITY_NAME, NAME_MARKER);
  // 3. Toutes les entités et le filet de chiffres.
  if (text.length > GED_AI_MASKING_MAX_TEXT_CHARS) text = text.slice(0, GED_AI_MASKING_MAX_TEXT_CHARS);
  return applyAiMasking(text, MASKING_RULES, { includeDefaults: true }).text;
}

/**
 * Masque toutes les entités (e-mail, téléphone, montant, IBAN, carte, NIR, identité), les
 * « civilité + nom » (`[NOM]`) et les identifiants ancrés par mot-clé (`[IDENTITÉ]`). Le texte est
 * tronqué AVANT masquage (jamais d'exception pour un texte long) ; le résultat est un point fixe
 * (idempotent). En cas d'échec inattendu du masquage, tout le texte est remplacé (échec fermé).
 */
export function maskPiiContextText(text: string): string {
  try {
    let current = prepareText(text);
    for (let pass = 0; pass < MASK_PASSES_MAX; pass += 1) {
      const next = maskOnce(current);
      if (next === current) return next;
      current = next;
    }
    return current;
  } catch {
    return GED_AI_DEFAULT_MASKING_REPLACEMENT;
  }
}

// ---------------------------------------------------------------------------
// Mots-clés de sensibilité
// ---------------------------------------------------------------------------

type KeywordReason = Extract<GovernanceSensitivityReason, `keyword_${string}`>;

const KEYWORD_LISTS: ReadonlyArray<readonly [KeywordReason, readonly string[]]> = [
  [
    'keyword_health',
    [
      'dossier medical', 'dossiers medicaux', 'secret medical', 'diagnostic', 'ordonnance', 'arret maladie',
      'arret de travail', 'pathologie', 'certificat medical', 'certificats medicaux', 'compte rendu operatoire',
      'donnees de sante',
    ],
  ],
  [
    'keyword_hr',
    [
      'bulletin de paie', 'bulletin de salaire', 'fiche de paie', 'fiche de paye', 'salaire', 'licenciement',
      'sanction disciplinaire', 'avertissement disciplinaire', "entretien annuel d'evaluation",
      "entretien d'evaluation", 'rupture conventionnelle',
    ],
  ],
  [
    'keyword_legal',
    ['contentieux', 'plainte', 'procedure judiciaire', 'jugement', 'protocole transactionnel', 'assignation en justice'],
  ],
  [
    'keyword_finance',
    [
      'releve bancaire', "releve d'identite bancaire", 'rib', 'declaration fiscale', "avis d'imposition",
      'declaration de revenus',
    ],
  ],
  [
    'keyword_secret',
    [
      'strictement confidentiel', 'strictement confidentielle', 'secret defense', 'ne pas diffuser', 'confidentiel',
      'confidentielle',
    ],
  ],
];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mots entiers uniquement : « nonconfidentielle » n'est pas « confidentiel ». */
const KEYWORD_REGEXES: ReadonlyArray<readonly [KeywordReason, RegExp]> = KEYWORD_LISTS.map(([reason, words]) => [
  reason,
  new RegExp(
    `(?<![a-z0-9])(?:${words.map((w) => escapeRegex(w).replace(/ /g, '\\s+')).join('|')})s?(?![a-z0-9])`,
  ),
]);

/** Texte en minuscules, sans accents, apostrophes droites. */
function foldForKeywords(text: string): string {
  return prepareText(text)
    .toLowerCase()
    .replace(/[’‘ʼ`´]/g, "'")
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/** Mots-clés de sensibilité (français, insensibles à la casse et aux accents), uniques, ordre fixe. */
export function detectSensitivityKeywords(text: string): GovernanceSensitivityReason[] {
  const folded = foldForKeywords(text);
  if (folded.length === 0) return [];
  const out: GovernanceSensitivityReason[] = [];
  for (const [reason, regex] of KEYWORD_REGEXES) if (regex.test(folded)) out.push(reason);
  return out;
}

// ---------------------------------------------------------------------------
// Score et proposition de sensibilité
// ---------------------------------------------------------------------------

export interface GovernanceSensitivityInput {
  findings: readonly GovernancePiiFinding[];
  keywordReasons: readonly GovernanceSensitivityReason[];
  aiScore?: GovernanceSensitivityScore | null;
  levels: readonly GovernanceConfidentialiteLevel[];
  current: { confidentialiteId: number | null; rank: number | null };
  /** `false` par défaut : sans lui, aucune proposition d'abaissement n'est jamais émise. */
  allowLowering?: boolean;
}

const STRONG_ENTITIES: readonly GovernancePiiEntity[] = ['iban', 'card', 'nir', 'identity'];
const STRONG_MIN_CONFIDENCE = 0.7;
const NAME_MIN_CONFIDENCE = 0.6;
const DIFFUSE_TOTAL_THRESHOLD = 5;
/** Au moins 2 familles distinctes ne pèsent qu'à partir de 3 occurrences : une signature (1 e-mail + 1 téléphone) ne compte pas. */
const DIFFUSE_FAMILIES_MIN_TOTAL = 3;

/**
 * RÈGLE DE SCORE (0 aucune, 1 modérée, 2 élevée) :
 * - score 2 si une famille iban/card/nir/identity a une confiance >= 0,7, ou mot-clé santé, ou avis
 *   du modèle = 2 ;
 * - sinon score 1 si : au moins 2 familles distinctes parmi email/phone/name ET au moins 3
 *   occurrences au total (une signature « 1 e-mail + 1 téléphone » reste à 0), ou au moins 5
 *   occurrences email+phone+name au total, ou `name` présent avec une confiance >= 0,6, ou un
 *   mot-clé RH / juridique / finance / secret, ou avis du modèle = 1 ;
 * - sinon 0 : UNE adresse e-mail ou UN téléphone isolés (signature de courrier) ne rendent pas un
 *   document sensible.
 * `reasons` : codes `pii_<entité>` des familles qui ont pesé, mots-clés, `ai_moderate` / `ai_high`
 * selon l'avis du modèle ; sans doublon.
 */
export function computeSensitivityScore(
  input: Pick<GovernanceSensitivityInput, 'findings' | 'keywordReasons' | 'aiScore'>,
): { score: GovernanceSensitivityScore; reasons: GovernanceSensitivityReason[] } {
  const byEntity = new Map<GovernancePiiEntity, GovernancePiiFinding>();
  for (const f of input.findings) {
    if (f.count <= 0) continue;
    const previous = byEntity.get(f.entity);
    if (!previous) byEntity.set(f.entity, { ...f });
    else byEntity.set(f.entity, { ...previous, count: previous.count + f.count, confidence: Math.max(previous.confidence, f.confidence) });
  }
  const keywords = new Set<GovernanceSensitivityReason>(
    input.keywordReasons.filter((r) => r.startsWith('keyword_')),
  );
  const aiScore = input.aiScore ?? null;

  const strong = STRONG_ENTITIES.filter((e) => (byEntity.get(e)?.confidence ?? 0) >= STRONG_MIN_CONFIDENCE);
  const diffuse = (['email', 'phone', 'name'] as const).filter((e) => byEntity.has(e));
  const diffuseTotal = diffuse.reduce((sum, e) => sum + (byEntity.get(e)?.count ?? 0), 0);
  const nameWeighs = (byEntity.get('name')?.confidence ?? 0) >= NAME_MIN_CONFIDENCE;
  const diffuseWeighs =
    (diffuse.length >= 2 && diffuseTotal >= DIFFUSE_FAMILIES_MIN_TOTAL) || diffuseTotal >= DIFFUSE_TOTAL_THRESHOLD;

  let score: GovernanceSensitivityScore = 0;
  if (strong.length > 0 || keywords.has('keyword_health') || aiScore === 2) score = 2;
  else if (
    diffuseWeighs ||
    nameWeighs ||
    aiScore === 1 ||
    ['keyword_hr', 'keyword_legal', 'keyword_finance', 'keyword_secret'].some((k) => keywords.has(k as GovernanceSensitivityReason))
  ) {
    score = 1;
  }
  if (score === 0) return { score, reasons: [] };

  const weighing = new Set<GovernancePiiEntity>(strong);
  if (diffuseWeighs) diffuse.forEach((e) => weighing.add(e));
  else if (nameWeighs) weighing.add('name');
  const reasons: GovernanceSensitivityReason[] = [];
  for (const entity of GOVERNANCE_PII_ENTITIES) {
    if (weighing.has(entity)) reasons.push(`pii_${entity}` as GovernanceSensitivityReason);
  }
  for (const reason of GOVERNANCE_SENSITIVITY_REASONS) {
    if (reason.startsWith('keyword_') && keywords.has(reason)) reasons.push(reason);
  }
  if (aiScore === 2) reasons.push('ai_high');
  else if (aiScore === 1) reasons.push('ai_moderate');
  return { score, reasons };
}

/** Niveaux valides triés par rang croissant (un seul niveau par rang : le plus petit identifiant). */
function sortedLevels(levels: readonly GovernanceConfidentialiteLevel[]): GovernanceConfidentialiteLevel[] {
  const valid = (Array.isArray(levels) ? levels : []).filter(
    (l) =>
      l !== null &&
      typeof l === 'object' &&
      Number.isInteger(l.confidentialiteId) &&
      l.confidentialiteId > 0 &&
      Number.isInteger(l.rank),
  );
  valid.sort((a, b) => a.rank - b.rank || a.confidentialiteId - b.confidentialiteId);
  const out: GovernanceConfidentialiteLevel[] = [];
  for (const level of valid) if (out.length === 0 || out[out.length - 1]!.rank !== level.rank) out.push(level);
  return out;
}

/**
 * Propose un niveau de confidentialité d'après le score. Niveau cible parmi n niveaux triés :
 * score 1 → indice round((n-1)/3), score 2 → indice round(2(n-1)/3), avec indice(2) >= indice(1)+1
 * (plafonné à n-1) dès que n >= 3. Élévation seulement ; l'abaissement n'est proposé qu'avec
 * `allowLowering`. Un niveau égal au courant ne donne jamais de proposition.
 */
export function proposeSensitivity(input: GovernanceSensitivityInput): GovernanceSensitivityOutput | null {
  const { score, reasons } = computeSensitivityScore(input);
  if (score === 0) return null;
  const levels = sortedLevels(input.levels);
  const n = levels.length;
  if (n === 0) return null;

  const low = Math.round((n - 1) / 3);
  let high = Math.round((2 * (n - 1)) / 3);
  if (n >= 3 && high < low + 1) high = Math.min(low + 1, n - 1);
  const target = levels[score === 1 ? low : high]!;

  const currentRank = input.current.rank;
  let direction: 'raise' | 'lower';
  if (currentRank === null || currentRank === undefined || !Number.isInteger(currentRank)) direction = 'raise';
  else if (target.rank > currentRank) direction = 'raise';
  else if (target.rank < currentRank && input.allowLowering === true) direction = 'lower';
  else return null;

  const hasCurrent = typeof currentRank === 'number' && Number.isInteger(currentRank);
  const output: GovernanceSensitivityOutput = {
    schemaVersion: 1,
    kind: 'sensitivity',
    score,
    currentConfidentialiteId: hasCurrent ? (input.current.confidentialiteId ?? null) : null,
    currentRank: hasCurrent ? currentRank : null,
    proposedConfidentialiteId: target.confidentialiteId,
    proposedRank: target.rank,
    direction,
    reasons,
    detection: { deterministic: true, ai: input.aiScore !== undefined && input.aiScore !== null },
  };
  return governanceSensitivityOutputSchema.parse(output);
}

// ---------------------------------------------------------------------------
// Doublons : titres, vecteurs, original
// ---------------------------------------------------------------------------

/**
 * Titre normalisé : minuscules, sans accents, sans extension finale (.pdf, .docx…), sans marqueur
 * de copie (« copie de », « - copie », « (1) », « copy »), ponctuation → espaces, espaces compactés.
 */
export function normalizeTitle(title: string): string {
  if (typeof title !== 'string') return '';
  let s = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘ʼ`´]/g, "'")
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim();
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s
      .replace(/\.(?=[a-z0-9]{1,5}$)[a-z0-9]*[a-z][a-z0-9]*$/, '')
      .replace(/\s*\(\d{1,3}\)$/, '')
      .replace(/(?:^|[\s\-_–])+(?:copie|copy)(?:\s+\d{1,3})?$/, '')
      .trim();
    if (s === before) break;
  }
  s = s.replace(/^(?:copie\s+de|copy\s+of)\s+/, '').replace(/\(\d{1,3}\)/g, ' ');
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const titleTokens = (normalized: string): Set<string> =>
  new Set(normalized.split(' ').filter((t) => t.length >= 2));

/** Jaccard sur les jetons (longueur >= 2) des titres normalisés ; 0 si l'un est vide. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na.length === 0 || nb.length === 0) return 0;
  const ta = titleTokens(na);
  const tb = titleTokens(nb);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Cosinus de deux vecteurs ; 0 si longueurs différentes, vide, norme nulle ou valeur non finie ; borné à [-1, 1]. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const result = dot / (Math.sqrt(na) * Math.sqrt(nb));
  if (!Number.isFinite(result)) return 0;
  return Math.max(-1, Math.min(1, result));
}

export function buildDuplicateGroupKey(originalDocumentId: number): string {
  return `dup:${originalDocumentId}`;
}

/** Original d'un groupe : le plus ancien (`createdAt`), à égalité le plus petit `documentId`. */
export function pickOriginalDocumentId(
  candidates: ReadonlyArray<{ documentId: number; createdAt: Date | string }>,
): number {
  if (candidates.length === 0) throw new Error('Aucun candidat : impossible de désigner un original.');
  const timeOf = (value: Date | string): number => {
    const t = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  let best = candidates[0]!;
  let bestTime = timeOf(best.createdAt);
  for (const c of candidates.slice(1)) {
    const t = timeOf(c.createdAt);
    if (t < bestTime || (t === bestTime && c.documentId < best.documentId)) {
      best = c;
      bestTime = t;
    }
  }
  return best.documentId;
}
