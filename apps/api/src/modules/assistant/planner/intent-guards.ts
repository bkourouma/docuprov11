import { AsstActionTool } from '@archivage/types';
import { MAIL_INPUTATION_TYPE_IDS } from '../../workflow-agent-catalog/catalog.contracts';
import { sanitizeText } from '../../workflow-agents/injection/untrusted';
import type { PlannerInputationTypeView } from './planner.types';

// Gardes d'INTENTION du validateur d'actions (fonctions pures, sans accès aux données).
//
// Le message de l'utilisateur est la SEULE source d'intention : ces fonctions lisent exclusivement les textes de
// l'utilisateur (message courant et messages précédents de l'échange), jamais un texte de courrier, un nom d'acteur
// ou une sortie du modèle. Elles sont TOLÉRANTES (casse, accents, conjugaisons usuelles, français et anglais) mais
// l'échec reste fermé : en cas de doute, le validateur pose une question ou refuse.

/** Borne de lecture d'un texte utilisateur (caractères) : au-delà, le texte est coupé avant analyse. */
export const USER_TEXT_MAX_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const APOSTROPHES = /[‘’‛ʼ`´′]/g;
const LIGATURES: ReadonlyArray<[RegExp, string]> = [
  [/œ/g, 'oe'],
  [/æ/g, 'ae'],
  [/ß/g, 'ss'],
];

/**
 * Texte « replié » : nettoyé (`sanitizeText`), sans accents, en minuscules, apostrophes unifiées. Les symboles
 * (« n° », « # ») sont conservés (utile pour repérer un numéro de courrier).
 */
export function foldText(input: unknown, max = USER_TEXT_MAX_CHARS): string {
  let out = sanitizeText(input, max)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(APOSTROPHES, "'");
  for (const [re, by] of LIGATURES) out = out.replace(re, by);
  return out;
}

/** Texte normalisé en mots : `foldText` puis tout ce qui n'est ni lettre ASCII ni chiffre devient une espace. */
export function normalizeWords(input: unknown, max = USER_TEXT_MAX_CHARS): string {
  return foldText(input, max)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `needle` (déjà normalisé) figure-t-il dans `haystack` (déjà normalisé), en mots entiers ? */
export function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Vrai si l'un des textes normalisés contient la phrase (mots entiers). */
export function phraseInAny(texts: readonly string[], needle: string): boolean {
  return texts.some((t) => containsPhrase(t, needle));
}

/** Mots vides ignorés pour juger qu'un filtre ou un désignateur est « significatif ». */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'au', 'aux', 'avec', 'ce', 'ces', 'cet', 'cette', 'ci', 'd', 'dans', 'de', 'des', 'du', 'elle', 'en', 'et',
  'il', 'j', 'je', 'l', 'la', 'le', 'les', 'leur', 'leurs', 'lui', 'm', 'ma', 'me', 'mes', 'moi', 'mon', 'n', 'ne',
  'nos', 'notre', 'nous', 'on', 'ou', 'par', 'pas', 'pour', 'qu', 'que', 'qui', 's', 'sa', 'sans', 'se', 'ses', 'si',
  'son', 'sous', 'sur', 't', 'ta', 'te', 'tes', 'toi', 'ton', 'tu', 'un', 'une', 'vos', 'votre', 'vous', 'y',
  'an', 'and', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'the',
  'this', 'that', 'to', 'with', 'your',
  // Mots du domaine trop génériques pour désigner quoi que ce soit.
  'courrier', 'courriers', 'mail', 'mails', 'lettre', 'espace', 'espaces', 'merci', 'stp', 'svp',
]);

/** Un texte normalisé est « significatif » : au moins 2 caractères et au moins un mot hors mots vides. */
export function isSignificant(normalized: string): boolean {
  if (normalized.length < 2) return false;
  return normalized.split(' ').some((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/** Prépare les textes de l'utilisateur (message courant d'abord) sous forme normalisée en mots. */
export function normalizeUserTexts(current: string, previous: readonly string[]): string[] {
  return [current, ...previous].map((t) => normalizeWords(t)).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Intention : un ORDRE cohérent avec l'outil
// ---------------------------------------------------------------------------

const IMPUTATION_PATTERNS: readonly RegExp[] = [
  /\bimput[a-z]*\b/,
  /\baffect(e|es|er|ez|ons|ation|ations|e)\b/,
  /\battribu[a-z]*\b/,
  /\bassign[a-z]*\b/,
  /\btransm(et|ets|ettre|ettez|ettons|is|ission)\b/,
  /\bconfi(e|es|er|ez|ons|erai|erais)\b/,
  /\b(envoi[a-z]*|envoy[a-z]*)\b(\s+[a-z0-9]+){0,4}?\s+(a|au|aux)\b/,
  /\b(fais|faites|faire)\s+passer\b/,
  /\bpasse(z|r)?\s+(le|la|les|ce|ca|l)?\s*(courrier\s+)?(a|au|aux)\b/,
  /\b(allocate|dispatch)[a-z]*\b/,
  /\bforward[a-z]*\b/,
  /\bsend\s+(it|this|this\s+mail|this\s+letter|the\s+mail|the\s+letter)?\s*to\b/,
  /\bhand\s+(it\s+|this\s+)?over\b/,
];

const RELANCE_PATTERNS: readonly RegExp[] = [
  /\brelanc[a-z]*\b/,
  /\brappel[a-z]*\b/,
  /\bpress(e|er|ez|es|ons)\b/,
  /\bremind[a-z]*\b/,
  /\bchase[a-z]*\b/,
  /\bfollow\s+up\b/,
  /\bnudge[a-z]*\b/,
];

const BROUILLON_PATTERNS: readonly RegExp[] = [
  /\bbrouillon[a-z]*\b/,
  /\bredig[a-z]*\b/,
  /\bredact[a-z]*\b/,
  /\brepon[a-z]*\b/,
  /\bdraft[a-z]*\b/,
  /\bdraught[a-z]*\b/,
  /\brepl(y|ies|ied)\b/,
  /\brespon(d|ds|se)\b/,
  /\banswer[a-z]*\b/,
  /\bwrite\s+(a|an|the)?\s*(answer|letter|response)\b/,
];

const INTENT_PATTERNS: Record<string, readonly RegExp[]> = {
  [AsstActionTool.ImputationCourrier]: IMPUTATION_PATTERNS,
  [AsstActionTool.Relance]: RELANCE_PATTERNS,
  [AsstActionTool.BrouillonReponse]: BROUILLON_PATTERNS,
};

const FR_NEG_BEFORE = new Set(['ne', 'n']);
const FR_NEG_AFTER = new Set(['pas', 'jamais', 'plus', 'point']);
const EN_NEG_BEFORE = new Set(['not', 'never', 'dont']);

/** L'occurrence en `index` (début du verbe) est-elle niée (« ne … pas », « n'… jamais », « don't », « do not ») ? */
function isNegated(text: string, index: number, length: number): boolean {
  const before = text.slice(0, index).trim().split(' ').filter(Boolean).slice(-3);
  const after = text
    .slice(index + length)
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 3);
  if (before.some((w) => FR_NEG_BEFORE.has(w)) && after.some((w) => FR_NEG_AFTER.has(w))) return true;
  const joined = before.join(' ');
  if (/\b(ne|n) (pas|jamais|plus)$/.test(joined)) return true; // « ne pas imputer »
  if (before.some((w) => EN_NEG_BEFORE.has(w)) || /\b(don t|do not|does not|doesn t)$/.test(joined)) return true;
  return false;
}

// Durcissement (corpus d'attaque du planificateur) : un mot d'ordre employé dans un CONSTAT ou une QUESTION n'est
// pas un ordre. Ces règles ne font que RETIRER des occurrences (échec fermé : au pire, l'utilisateur reformule).

/**
 * Mot IMMÉDIATEMENT avant le verbe qui en fait un participe ou un constat (« a été imputé », « est déjà transmis »,
 * « j'ai rédigé », « est à imputer »). Seul le mot précédent compte : « c'est urgent, impute… » reste un ordre.
 */
const AUX_IMMEDIATE = new Set([
  'ete', 'deja', 'est', 'sont', 'etait', 'etaient', 'etre', 'sera', 'seront', 'serait', 'fut',
  'ai', 'as', 'a', 'avons', 'avez', 'ont', 'avait', 'avais', 'avaient', 'aurait', 'auront',
  'been', 'was', 'were', 'is', 'are', 'already', 'being', 'has', 'have', 'had',
]);

/** « répondre » adressé à l'assistant (« réponds-moi », « réponds en une phrase », « answer me ») : pas un brouillon. */
const REPLY_VERB = /^(?:repond[a-z]*|respond[a-z]*|repl(?:y|ies|ied)|answer[a-z]*)$/;
const REPLY_TO_ASSISTANT_NEXT = new Set([
  'moi', 'nous', 'me', 'en', 'oui', 'non', 'juste', 'simplement', 'brievement', 'seulement', 'uniquement', 'clairement',
  'precisement', 'franchement', 'vite', 'us', 'briefly', 'yes', 'no', 'only', 'just', 'simply', 'in', 'my', 'this', 'the',
]);
/** Après « répondre à », ces mots désignent l'échange avec l'assistant, pas un correspondant. */
const REPLY_TO_ASSISTANT_OBJECT = new Set(['moi', 'ma', 'mes', 'nous', 'notre', 'nos', 'toi', 'ta', 'tes', 'cette', 'la', 'me', 'my', 'this', 'the']);
const REPLY_OBJECT_ALLOWED_AFTER_THE = new Set(['courrier', 'mail', 'lettre', 'demande', 'mairie', 'letter', 'sender', 'email']);
/** « réponse » (nom) : brouillon seulement s'il est produit (« prépare une réponse », « projet de réponse ») ou adressé. */
const REPLY_NOUN = /^(?:reponses?|response|responses)$/;
const PRODUCTION_WORDS = new Set([
  'prepare', 'preparer', 'preparez', 'prepares', 'redige', 'rediger', 'redigez', 'ecris', 'ecrire', 'ecrivez', 'fais',
  'faites', 'faire', 'propose', 'proposer', 'proposez', 'elabore', 'elaborer', 'formule', 'formuler', 'projet', 'brouillon',
  'modele', 'proposition', 'ebauche', 'write', 'draft', 'compose', 'besoin', 'veux', 'voudrais', 'souhaite',
]);
const MAIL_OBJECTS = new Set([
  'courrier', 'courriers', 'mail', 'mails', 'lettre', 'lettres', 'expediteur', 'expeditrice', 'expediteurs', 'correspondant',
  'correspondante', 'demande', 'requete', 'reclamation', 'demandeur', 'demandeuse', 'sender', 'letter', 'email', 'lui', 'leur',
]);
/** « rappeler » au sens de « se souvenir » / « pour rappel » : pas une relance. */
const REMIND_VERB = /^(?:rappel[a-z]*|remind[a-z]*)$/;
const REMIND_SELF_BEFORE = new Set(['me', 'moi', 'nous', 'te', 'vous', 'pour', 'se', 'm', 't', 's']);
const REMIND_SELF_AFTER = new Set(['moi', 'nous', 'toi', 'vous', 'me', 'us', 'que', 'qu', 'pourquoi', 'comment']);
/** « presse » nom (« la presse », « communiqué de presse ») : pas une relance. */
const PRESS_WORD = /^press(?:e|er|ez|es|ons)$/;
const PRESS_NOUN_BEFORE = new Set(['la', 'de', 'en', 'revue', 'communique', 'article', 'agence', 'sous', 'une', 'des', 'cette']);

function wordsAround(text: string, index: number, length: number): { before: string[]; word: string; after: string[] } {
  const before = text.slice(0, index).trim().split(' ').filter(Boolean);
  const rest = text.slice(index).trim().split(' ').filter(Boolean);
  const matchedWords = text.slice(index, index + length).trim().split(' ').filter(Boolean).length || 1;
  return { before, word: rest[0] ?? '', after: rest.slice(matchedWords) };
}

/** L'occurrence est-elle un constat (participe), un remerciement ou un emploi qui ne demande pas l'action ? */
function isNonOrderUse(tool: string, text: string, index: number, length: number): boolean {
  const { before, word, after } = wordsAround(text, index, length);
  const prev1 = before[before.length - 1] ?? '';
  if (AUX_IMMEDIATE.has(prev1)) return true;
  // « merci pour la réponse », « thanks for the draft » : un remerciement n'est pas une demande.
  const window = before.slice(-4).join(' ');
  if (/\b(?:merci(?: beaucoup| bien)? pour|thanks? (?:you )?for)\b/.test(window)) return true;

  if (tool === AsstActionTool.BrouillonReponse) {
    if (REPLY_VERB.test(word)) {
      const next = after[0] ?? '';
      if (next === 'lui' || next === 'leur' || next === 'him' || next === 'her' || next === 'them') return false;
      if (next === 'a' || next === 'au' || next === 'aux' || next === 'to') {
        const obj = after[1] ?? '';
        if (REPLY_TO_ASSISTANT_OBJECT.has(obj)) {
          const noun = after[2] ?? '';
          return !((obj === 'la' || obj === 'cette' || obj === 'the' || obj === 'this') && REPLY_OBJECT_ALLOWED_AFTER_THE.has(noun));
        }
        return false;
      }
      if (REPLY_TO_ASSISTANT_NEXT.has(next)) return true;
      // Verbe seul ou suivi d'autre chose : brouillon seulement si un courrier/correspondant est visé.
      return !after.slice(0, 4).some((w) => MAIL_OBJECTS.has(w));
    }
    if (REPLY_NOUN.test(word)) {
      if (before.slice(-3).some((w) => PRODUCTION_WORDS.has(w))) return false;
      const next = after[0] ?? '';
      if ((next === 'a' || next === 'au' || next === 'aux' || next === 'to') && after.slice(1, 4).some((w) => MAIL_OBJECTS.has(w))) {
        return false;
      }
      if (next === 'type' || next === 'standard') return false;
      return true;
    }
  }
  if (tool === AsstActionTool.Relance) {
    if (REMIND_VERB.test(word)) {
      if (REMIND_SELF_BEFORE.has(prev1) || REMIND_SELF_AFTER.has(after[0] ?? '')) return true;
    }
    if (PRESS_WORD.test(word) && PRESS_NOUN_BEFORE.has(prev1)) return true;
  }
  return false;
}

/** Un texte normalisé contient-il un ordre (non nié, hors constat ou remerciement) pour l'outil ? */
export function textOrders(tool: string, normalizedText: string): boolean {
  const patterns = INTENT_PATTERNS[tool];
  if (!patterns) return false;
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, 'g');
    for (const m of normalizedText.matchAll(re)) {
      if (m.index === undefined) continue;
      if (isNegated(normalizedText, m.index, m[0].length)) continue;
      if (isNonOrderUse(tool, normalizedText, m.index, m[0].length)) continue;
      return true;
    }
  }
  return false;
}

/** Formules de DEMANDE polie qui font d'une question un ordre (« peux-tu imputer… ? »). */
const REQUEST_MODALS =
  /\b(?:peux tu|pourrais tu|pouvez vous|pourriez vous|veux tu|voudrais tu|voulez vous|voudriez vous|tu peux|tu pourrais|vous pouvez|vous pourriez|merci de|can you|could you|would you|will you|please)\b/;

/** Phrases d'un texte de l'utilisateur, normalisées, avec leur nature interrogative. */
export function userSentences(text: string): Array<{ norm: string; question: boolean }> {
  const folded = foldText(text);
  const out: Array<{ norm: string; question: boolean }> = [];
  for (const m of folded.matchAll(/[^.!?;\n…]+[.!?;\n…]*/g)) {
    const chunk = m[0];
    const norm = normalizeWords(chunk);
    if (!norm) continue;
    out.push({ norm, question: /\?/.test(chunk) });
  }
  return out;
}

/**
 * L'intention est-elle établie ? Les textes de l'utilisateur (message courant et messages précédents de l'échange,
 * bruts) doivent contenir un ordre cohérent avec l'outil. Une QUESTION (« est-ce que ce courrier est imputé à la
 * DAF ? ») n'est pas un ordre, sauf formule de demande (« peux-tu imputer… ? »). Outil inconnu (dont la
 * délégation) : toujours faux.
 */
export function intentAllows(tool: string, userTexts: readonly string[]): boolean {
  if (!INTENT_PATTERNS[tool]) return false;
  return userTexts.some((t) =>
    userSentences(t).some((s) => (!s.question || REQUEST_MODALS.test(s.norm)) && textOrders(tool, s.norm)),
  );
}

// ---------------------------------------------------------------------------
// Délai (jours calendaires, jamais de date)
// ---------------------------------------------------------------------------

export const DELAY_DAYS_MIN = 1;
export const DELAY_DAYS_MAX = 90;

const NUMBER_WORDS: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11,
  douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, 'dix sept': 17, 'dix huit': 18, 'dix neuf': 19,
  vingt: 20,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20,
};
// « six » est commun aux deux langues. « a »/« an » (anglais) ne sont PAS des nombres ici : « à jour » (« mise à
// jour ») ne doit jamais valoir 1 jour ; « a week » / « a month » / « a day » sont traités à part.
const NUMBER_ALT = Object.keys(NUMBER_WORDS)
  .sort((x, y) => y.length - x.length)
  .map((w) => w.replace(' ', '\\s+'))
  .join('|');
const NUM = `(\\d{1,4}|${NUMBER_ALT})`;

const DAY_UNIT = '(?:jours?|jrs?|j|days?)';
const WEEK_UNIT = '(?:semaines?|sem|weeks?|wk)';
const MONTH_UNIT = '(?:mois|months?)';
const HOUR_UNIT = '(?:heures?|h|hours?|hrs?)';

const WEEKDAYS = '(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const MONTHS =
  '(?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december)';

/** Échéances exprimées comme une DATE (non convertibles en jours de façon sûre) : toujours ambiguës. */
const DATE_LIKE_PATTERNS: readonly RegExp[] = [
  // « d'ici » suivi d'autre chose qu'une quantité convertible (« d'ici 3 jours », « d'ici demain » restent sûrs).
  new RegExp(
    `\\bd ici (?!(?:${NUM})\\s*(?:${DAY_UNIT}|${WEEK_UNIT}|${MONTH_UNIT}|${HOUR_UNIT})\\b|(?:une?|1) quinzaine\\b|(?:une?|1) huitaine\\b|demain\\b|apres demain\\b)`,
  ),
  new RegExp(`\\b(?:avant|jusqu a|jusqu au|au plus tard|pour|by|until|before)\\s+(?:le |la |ce |cette |the |next |this )?(?:${WEEKDAYS}|${MONTHS}|\\d{1,2}(?:er)?\\s+${MONTHS}|\\d{1,2}\\s+\\d{1,2}(?:\\s+\\d{2,4})?|la fin|fin|end of)`),
  new RegExp(`\\b(?:le\\s+)?\\d{1,2}(?:er)?\\s+${MONTHS}\\b`),
  /\b\d{1,2} \d{1,2} \d{2,4}\b/, // 12/05/2026 (normalisé en « 12 05 2026 »)
  /\b(?:jours?|days?) (?:ouvres?|ouvrables?|ouvrable|business|working)\b/,
  /\b(?:business|working) days?\b/,
  new RegExp(`\\b${WEEKDAYS} (?:prochain|soir|matin|next)\\b`),
  /\b(?:fin de (?:la )?semaine|fin du mois|end of (?:the )?(?:week|month)|semaine prochaine|mois prochain|next week|next month)\b/,
];

/** Urgence sans quantité : ambiguë seulement si aucun nombre de jours n'est donné dans le même texte. */
const URGENCY_PATTERNS: readonly RegExp[] = [
  /\burgen(t|te|ts|tes|ce|cy)\b/,
  /\basap\b/,
  /\bau plus vite\b/,
  /\bdes que possible\b/,
  /\bau plus tot\b/,
  /\brapidement\b/,
  /\bsans delai\b/,
  /\b(?:delai|echeance|deadline)\b/,
  /\bas soon as possible\b/,
];

export interface DelayExtraction {
  /** Délais distincts (jours calendaires), dans l'ordre d'apparition. Une valeur hors 1..90 reste listée. */
  days: number[];
  /** Un délai est évoqué mais n'est pas convertible de façon sûre en jours (date, jours ouvrés, « 36 h »…). */
  vague: boolean;
}

function wordToNumber(raw: string): number | null {
  const key = raw.replace(/\s+/g, ' ');
  if (/^\d+$/.test(key)) return Number(key);
  return NUMBER_WORDS[key] ?? null;
}

/**
 * Délais candidats d'UN texte de l'utilisateur (brut). Exemples : « sous 3 jours » = 3, « 3j » = 3,
 * « une semaine » = 7, « deux semaines » = 14, « un mois » = 30, « demain » = 1, « après-demain » = 2,
 * « 48h » = 2, « 36 h » = non convertible, « d'ici vendredi » = non convertible, « 2 à 3 jours » = 2 et 3.
 */
export function extractDelayCandidates(text: string): DelayExtraction {
  const norm = normalizeWords(text);
  const found: Array<{ at: number; days: number }> = [];
  let vague = false;
  if (!norm) return { days: [], vague: false };

  // Nombres décimaux devant une unité (« 1,5 jour ») : non convertibles. `foldText` garde la virgule.
  const folded = foldText(text);
  if (new RegExp(`\\d+[.,]\\d+\\s*(?:${DAY_UNIT}|${WEEK_UNIT}|${MONTH_UNIT}|${HOUR_UNIT})\\b`).test(folded)) vague = true;

  const units: Array<{ unit: string; factor: number | 'hours' }> = [
    { unit: DAY_UNIT, factor: 1 },
    { unit: WEEK_UNIT, factor: 7 },
    { unit: MONTH_UNIT, factor: 30 },
    { unit: HOUR_UNIT, factor: 'hours' },
  ];
  const consumed: Array<[number, number]> = [];
  const overlaps = (s: number, e: number): boolean => consumed.some(([cs, ce]) => s < ce && e > cs);
  const push = (at: number, n: number, factor: number | 'hours'): void => {
    if (factor === 'hours') {
      if (n > 0 && n % 24 === 0) found.push({ at, days: n / 24 });
      else vague = true;
      return;
    }
    found.push({ at, days: n * factor });
  };

  // Fourchette chiffrée avec trait d'union (« 2-3 jours ») : lue sur le texte replié, deux candidats => ambigu.
  if (new RegExp(`\\b\\d{1,4}\\s*-\\s*\\d{1,4}\\s*(?:${DAY_UNIT}|${WEEK_UNIT}|${MONTH_UNIT}|${HOUR_UNIT})\\b`).test(folded)) {
    vague = true;
  }

  for (const { unit, factor } of units) {
    // Fourchettes : « 2 a 3 jours », « deux ou trois jours », « 2 to 3 days » (connecteur obligatoire : « dix sept
    // jours » vaut 17, pas 10 et 7).
    const range = new RegExp(`\\b${NUM}\\s+(?:a|ou|to|or)\\s+${NUM}\\s*${unit}\\b`, 'g');
    for (const m of norm.matchAll(range)) {
      if (m.index === undefined) continue;
      const a = wordToNumber(m[1] ?? '');
      const b = wordToNumber(m[2] ?? '');
      if (a === null || b === null) continue;
      consumed.push([m.index, m.index + m[0].length]);
      push(m.index, a, factor);
      push(m.index, b, factor);
    }
    const single = new RegExp(`\\b${NUM}\\s*${unit}\\b`, 'g');
    for (const m of norm.matchAll(single)) {
      if (m.index === undefined) continue;
      if (overlaps(m.index, m.index + m[0].length)) continue;
      const n = wordToNumber(m[1] ?? '');
      if (n === null) continue;
      consumed.push([m.index, m.index + m[0].length]);
      push(m.index, n, factor);
    }
  }

  // Anglais : « a day », « a week », « a month » (jamais en français : « à jour » n'est pas un délai).
  for (const m of norm.matchAll(/\b(?:within|in|under) (?:a|an|one) (day|week|month)\b/g)) {
    if (m.index === undefined || overlaps(m.index, m.index + m[0].length)) continue;
    found.push({ at: m.index, days: m[1] === 'day' ? 1 : m[1] === 'week' ? 7 : 30 });
  }

  for (const m of norm.matchAll(/\b(apres demain|day after tomorrow)\b/g)) {
    if (m.index !== undefined) found.push({ at: m.index, days: 2 });
  }
  for (const m of norm.matchAll(/\b(demain|tomorrow)\b/g)) {
    if (m.index === undefined) continue;
    const prefix = norm.slice(Math.max(0, m.index - 6), m.index);
    if (/apres $/.test(prefix) || /after $/.test(norm.slice(Math.max(0, m.index - 10), m.index))) continue;
    found.push({ at: m.index, days: 1 });
  }
  if (/\bquinzaine\b/.test(norm)) {
    const at = norm.search(/\bquinzaine\b/);
    found.push({ at, days: 15 });
  }
  if (/\bhuitaine\b/.test(norm)) {
    const at = norm.search(/\bhuitaine\b/);
    found.push({ at, days: 8 });
  }

  if (DATE_LIKE_PATTERNS.some((re) => re.test(norm))) vague = true;
  if (found.length === 0 && URGENCY_PATTERNS.some((re) => re.test(norm))) vague = true;

  found.sort((x, y) => x.at - y.at);
  const days: number[] = [];
  for (const f of found) if (!days.includes(f.days)) days.push(f.days);
  return { days, vague };
}

export type DelayDecision =
  | { status: 'none' }
  | { status: 'ok'; days: number }
  | { status: 'ambiguous' };

function decideOne(e: DelayExtraction): DelayDecision | null {
  if (e.vague || e.days.length > 1) return { status: 'ambiguous' };
  if (e.days.length === 1) {
    const d = e.days[0] as number;
    if (!Number.isInteger(d) || d < DELAY_DAYS_MIN || d > DELAY_DAYS_MAX) return { status: 'ambiguous' };
    return { status: 'ok', days: d };
  }
  return null;
}

/**
 * Délai imposé par le CODE : message COURANT d'abord ; à défaut, l'historique (un seul délai distinct pour
 * l'ensemble des messages précédents). Plusieurs délais, délai non convertible ou hors 1..90 : ambigu.
 * Aucun délai évoqué : pas de délai (celui que le modèle aurait mis est écarté).
 */
export function decideDelay(current: string, previous: readonly string[]): DelayDecision {
  const first = decideOne(extractDelayCandidates(current));
  if (first) return first;
  const merged: DelayExtraction = { days: [], vague: false };
  for (const t of previous) {
    const e = extractDelayCandidates(t);
    merged.vague = merged.vague || e.vague;
    for (const d of e.days) if (!merged.days.includes(d)) merged.days.push(d);
  }
  return decideOne(merged) ?? { status: 'none' };
}

// ---------------------------------------------------------------------------
// Numéros de courrier cités par l'utilisateur
// ---------------------------------------------------------------------------

const ID_MAX = 2_147_483_647;
const NOT_A_MAIL_WORDS = /\b(imputation|imputations|relance|relances|type|types|groupe|groupes|acteur|acteurs|espace|espaces|modele|modeles|document|documents|piece|pieces|dossier|dossiers)\s*$/;

/**
 * Numéros de courrier cités dans un texte de l'utilisateur : « courrier 4321 », « courrier n°4321 », « n°4321 »,
 * « #4321 », « numéro 4321 », « mail 4321 ». Un numéro précédé d'un autre objet (« imputation n°55 ») est ignoré.
 */
export function mentionedMailIds(text: string): number[] {
  const folded = foldText(text);
  const out: number[] = [];
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n >= 1 && n <= ID_MAX && !out.includes(n)) out.push(n);
  };
  const explicit =
    /\b(?:courriers?|mails?|lettres?|letters?)\s*(?:n\s*°|n°|no(?=\s*\.?\s*\d)|num(?:ero)?|number|#|ref(?:erence)?)?\s*\.?\s*:?\s*(\d{1,10})\b/g;
  for (const m of folded.matchAll(explicit)) add(m[1]);
  const bare = /(?:\bn\s*°|\bno(?=\d)|#|\bnumero\s+|\bnumber\s+)\s*(\d{1,10})\b/g;
  for (const m of folded.matchAll(bare)) {
    if (m.index === undefined) continue;
    const before = folded
      .slice(Math.max(0, m.index - 30), m.index)
      .replace(/[^a-z0-9]+/g, ' ')
      .trimEnd();
    if (NOT_A_MAIL_WORDS.test(before)) continue;
    add(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Type d'imputation demandé
// ---------------------------------------------------------------------------

/** Alias reconnus pour les types figés du référentiel (en plus des libellés actifs). « fort » = sans ambiguïté. */
const TYPE_ALIASES: ReadonlyArray<{ typeId: number; phrase: string; strong: boolean }> = [
  { typeId: MAIL_INPUTATION_TYPE_IDS.pourSuivi, phrase: 'pour suivi', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.pourSuivi, phrase: 'en suivi', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.pourSuivi, phrase: 'suivi', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.pourSuivi, phrase: 'follow up', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'validation dg', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'validation du dg', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'validation de la dg', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'validation par le dg', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'validation directeur general', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'validation du directeur general', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'validation de la direction generale', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'visa dg', strong: true },
  // « DG » seul peut désigner le DESTINATAIRE (« impute au DG ») : signal faible, jamais décisif à lui seul.
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'dg', strong: false },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDirection, phrase: 'validation direction', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDirection, phrase: 'validation de la direction', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDirection, phrase: 'validation du directeur', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDirection, phrase: 'visa direction', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.enCopie, phrase: 'en copie', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.enCopie, phrase: 'pour copie', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.enCopie, phrase: 'copie', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.enCopie, phrase: 'cc', strong: true },
  { typeId: MAIL_INPUTATION_TYPE_IDS.enCopie, phrase: 'in copy', strong: true },
  // « validation » seule : DG ou Direction ? signal faible pour les deux.
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDG, phrase: 'validation', strong: false },
  { typeId: MAIL_INPUTATION_TYPE_IDS.validationDirection, phrase: 'validation', strong: false },
];

export interface TypeMentions {
  /** Types désignés sans ambiguïté (libellé actif ou alias fort). */
  strong: number[];
  /** Types évoqués de façon ambiguë (« DG » seul, « validation » seule). */
  weak: number[];
}

/**
 * Types d'imputation mentionnés dans UN texte (brut). Les phrases les plus longues sont reconnues d'abord et
 * « consomment » leur passage (« validation de la direction générale » ne compte pas aussi comme « validation
 * de la direction »). Les libellés des types ACTIFS (`activeTypes`) sont des désignations fortes.
 */
export function detectTypeMentions(text: string, activeTypes: readonly PlannerInputationTypeView[]): TypeMentions {
  const phrases: Array<{ typeId: number; phrase: string; strong: boolean }> = [...TYPE_ALIASES];
  for (const t of activeTypes) {
    const phrase = normalizeWords(t.label, 400);
    if (phrase.length >= 3 && isSignificant(phrase)) phrases.push({ typeId: t.id, phrase, strong: true });
  }
  phrases.sort((a, b) => b.phrase.length - a.phrase.length);
  let rest = ` ${normalizeWords(text)} `;
  const strong: number[] = [];
  const weak: number[] = [];
  const consumedPhrases = new Set<string>();
  for (const p of phrases) {
    const needle = ` ${p.phrase} `;
    const already = consumedPhrases.has(p.phrase);
    if (!already && !rest.includes(needle)) continue;
    if (!already) {
      consumedPhrases.add(p.phrase);
      rest = rest.split(needle).join(' \u0000 ');
    }
    const bucket = p.strong ? strong : weak;
    if (!bucket.includes(p.typeId)) bucket.push(p.typeId);
  }
  return { strong, weak: weak.filter((id) => !strong.includes(id)) };
}

export type TypeDecision =
  | { status: 'explicit'; typeId: number }
  | { status: 'default'; typeId: number }
  | { status: 'ambiguous'; candidates: number[] }
  | { status: 'unavailable' };

/**
 * Type décidé par le CODE : mention explicite (message courant, à défaut l'historique), sinon « Pour suivi »
 * (HYPOTHÈSE MÉTIER par défaut) s'il est actif. Deux types forts, ou un signal faible seul : ambigu.
 * Un type cité mais inactif (absent de `activeTypes`) : ambigu (l'utilisateur doit choisir un type actif).
 */
export function decideInputationType(
  current: string,
  previous: readonly string[],
  activeTypes: readonly PlannerInputationTypeView[],
): TypeDecision {
  const activeIds = new Set(activeTypes.map((t) => t.id));
  const evaluate = (texts: readonly string[]): TypeDecision | null => {
    const strong: number[] = [];
    const weak: number[] = [];
    for (const t of texts) {
      const m = detectTypeMentions(t, activeTypes);
      for (const id of m.strong) if (!strong.includes(id)) strong.push(id);
      for (const id of m.weak) if (!weak.includes(id)) weak.push(id);
    }
    if (strong.length === 1) {
      const id = strong[0] as number;
      return activeIds.has(id) ? { status: 'explicit', typeId: id } : { status: 'ambiguous', candidates: [id] };
    }
    if (strong.length > 1) return { status: 'ambiguous', candidates: strong };
    if (weak.length > 0) return { status: 'ambiguous', candidates: weak };
    return null;
  };
  const decided = evaluate([current]) ?? evaluate(previous);
  if (decided) return decided;
  if (activeIds.has(MAIL_INPUTATION_TYPE_IDS.pourSuivi)) {
    return { status: 'default', typeId: MAIL_INPUTATION_TYPE_IDS.pourSuivi };
  }
  return { status: 'unavailable' };
}

// ---------------------------------------------------------------------------
// Désignation d'un libellé (acteur, espace) par l'utilisateur
// ---------------------------------------------------------------------------

/**
 * Désignateurs d'un libellé « Nom — Groupe » : le libellé complet, chacun de ses segments, et (option) les mots
 * significatifs (3 caractères et plus) du PREMIER segment (le nom). Tous normalisés.
 */
export function labelDesignators(label: string, opts: { nameWords: boolean } = { nameWords: true }): string[] {
  const full = normalizeWords(label, 600);
  const out = new Set<string>();
  if (full && isSignificant(full)) out.add(full);
  const segments = sanitizeText(label, 2_400)
    .split(/\s+[—–-]\s+|[,;/|()[\]]/)
    .map((s) => normalizeWords(s, 600))
    .filter((s) => s.length >= 2 && isSignificant(s));
  for (const s of segments) out.add(s);
  if (opts.nameWords) {
    const first = segments[0] ?? '';
    for (const w of first.split(' ')) {
      if (w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) out.add(w);
    }
  }
  return [...out];
}

/**
 * Parmi `candidates`, lesquels sont désignés de façon DISTINCTIVE par les textes de l'utilisateur ? Un candidat est
 * désigné s'il possède un désignateur présent dans les textes qu'aucun autre candidat ne partage.
 */
export function distinctlyDesignated<T>(
  candidates: readonly T[],
  labelOf: (c: T) => string,
  userNorms: readonly string[],
  opts: { nameWords: boolean } = { nameWords: true },
): T[] {
  const designators = candidates.map((c) => labelDesignators(labelOf(c), opts));
  const matched = designators.map((ds) => ds.filter((d) => phraseInAny(userNorms, d)));
  return candidates.filter((_, i) => {
    const mine = matched[i] ?? [];
    return mine.some((d) => !matched.some((other, j) => j !== i && other.includes(d)));
  });
}
