import { AsstActionTool, AsstMessageRole } from '@archivage/types';
import { MAIL_INPUTATION_TYPE_IDS } from '../../workflow-agent-catalog/catalog.contracts';
import { sanitizeText } from '../../workflow-agents/injection/untrusted';
import { isClarificationContent } from './clarification-format';
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

// --- Propositions (« clauses ») -----------------------------------------------------------------------
//
// Une négation, un refus ou une hypothèse portent sur la PROPOSITION où ils figurent : de son début jusqu'au
// séparateur suivant (ponctuation `, : ( ) [ ] — –` et fin de phrase `. ! ? ; …`, ou mot de liaison « mais »,
// « puis », « sinon », « plutôt », « par contre »…). « et », « ou », « ni » ne SÉPARENT PAS (choix prudent) :
// « pas d'imputation à la DAF et relance Awa » garde la négation sur « relance » (au pire l'utilisateur reformule),
// alors que couper sur « et » libérerait « ne pas imputer et relancer Awa ». Échec fermé : ces règles ne font que
// RETIRER des ordres ou des désignations, jamais en créer.

/** Mot d'un texte replié, avec sa position dans ce texte. */
interface Token {
  w: string;
  start: number;
}

/** Proposition : texte replié (`foldText`), position de début dans le texte analysé, mots. */
interface Clause {
  base: number;
  folded: string;
  tokens: Token[];
  words: string[];
}

/** Ponctuation qui ferme une proposition (y compris les fins de phrase). */
const CLAUSE_PUNCT = /[,:()[\]{}—–.!?;\n…]|\s-\s/g;

const BOUNDARY_SEQUENCES: readonly (readonly string[])[] = [
  ['mais'], ['but'], ['cependant'], ['pourtant'], ['toutefois'], ['neanmoins'], ['however'], ['puis'], ['ensuite'],
  ['then'], ['sinon'], ['otherwise'], ['plutot'], ['instead'], ['rather'], ['whereas'],
  ['par', 'contre'], ['en', 'revanche'], ['au', 'contraire'], ['a', 'la', 'place'],
];

function tokenize(folded: string): Token[] {
  const out: Token[] = [];
  for (const m of folded.matchAll(/[a-z0-9]+/g)) {
    if (m.index !== undefined) out.push({ w: m[0], start: m.index });
  }
  return out;
}

function startsSequence(words: readonly string[], i: number, seq: readonly string[]): boolean {
  for (let k = 0; k < seq.length; k++) if (words[i + k] !== seq[k]) return false;
  return true;
}

function makeClause(base: number, folded: string): Clause | null {
  const tokens = tokenize(folded);
  return tokens.length === 0 ? null : { base, folded, tokens, words: tokens.map((t) => t.w) };
}

/** Propositions d'un texte DÉJÀ replié (`foldText` ou `normalizeWords`), dans l'ordre. */
function clausesOfFolded(folded: string): Clause[] {
  const pieces: Array<{ base: number; text: string }> = [];
  let last = 0;
  for (const m of folded.matchAll(CLAUSE_PUNCT)) {
    if (m.index === undefined) continue;
    pieces.push({ base: last, text: folded.slice(last, m.index) });
    last = m.index + m[0].length;
  }
  pieces.push({ base: last, text: folded.slice(last) });
  const out: Clause[] = [];
  for (const piece of pieces) {
    const tokens = tokenize(piece.text);
    const words = tokens.map((t) => t.w);
    let from = 0;
    const flush = (to: number | null): void => {
      const s = tokens[from]?.start ?? 0;
      const e = to === null ? piece.text.length : (tokens[to]?.start ?? piece.text.length);
      const c = makeClause(piece.base + s, piece.text.slice(s, e));
      if (c) out.push(c);
    };
    for (let i = 1; i < words.length; i++) {
      if (BOUNDARY_SEQUENCES.some((seq) => startsSequence(words, i, seq))) {
        flush(i);
        from = i;
      }
    }
    if (words.length > 0) flush(null);
  }
  return out;
}

// --- Marqueurs de négation, de refus et d'hypothèse -----------------------------------------------------

/** Mots qui, AVANT le verbe dans la proposition, en font un refus (« pas d'imputation », « sans brouillon »…). */
const NEG_WORDS: ReadonlySet<string> = new Set([
  'pas', 'jamais', 'aucun', 'aucune', 'aucuns', 'aucunes', 'sans', 'ni', 'rien', 'inutile', 'inutiles', 'sauf', 'excepte',
  'exceptee', 'hormis', 'stop', 'not', 'never', 'no', 'without', 'nor', 'neither', 'none', 'nothing', 'cannot', 'except',
  'excluding', 'refrain',
]);
/** Familles de verbes de refus (« évite d'imputer », « annule la relance », « avoid », « cancel »). */
const NEG_STEMS = /^(?:evit|annul|supprim|cancel|avoid)[a-z]*$/;
/** « arrête de / cesse de » : refus (« arrêté » seul peut être un acte administratif). */
const NEG_BEFORE_DE = /^(?:arret|cess)(?:e|es|ez|er|ons)$/;
/** Second terme d'une négation « ne … pas / jamais / plus / rien / aucun… ». */
const FR_NEG_PARTNERS: ReadonlySet<string> = new Set([
  'pas', 'jamais', 'plus', 'point', 'rien', 'aucun', 'aucune', 'personne', 'guere', 'nullement',
]);
/** « don't », « doesn't », « won't »… (normalisés en « don t », « doesn t »…). */
const EN_T_AUX: ReadonlySet<string> = new Set([
  'don', 'doesn', 'didn', 'won', 'wouldn', 'shouldn', 'mustn', 'can', 'couldn', 'isn', 'aren', 'wasn', 'weren', 'haven',
  'hasn', 'needn',
]);
/** « dont » sans apostrophe, en anglais seulement (« dont assign ») : le relatif français « dont » n'est pas un refus. */
const EN_DONT_NEXT: ReadonlySet<string> = new Set([
  'want', 'wanna', 'assign', 'forward', 'send', 'remind', 'draft', 'reply', 'answer', 'write', 'do', 'need', 'chase',
  'follow', 'nudge', 'dispatch', 'allocate', 'respond',
]);
/** Hypothèse ou doute : « si », « il faudrait », « je me demande », « what if »… (pas des ordres). */
const HYP_WORDS: ReadonlySet<string> = new Set([
  'si', 'if', 'whether', 'faudrait', 'devrais', 'devrait', 'devrions', 'devriez', 'devraient', 'passerait', 'donnerait',
  'arriverait', 'serait', 'seraient', 'vaudrait', 'supposons', 'imaginons', 'admettons', 'hypothese', 'hypothetiquement',
  'hypothetically', 'wonder', 'wondering', 'suppose', 'imagine',
]);
const HYP_SEQUENCES: readonly (readonly string[])[] = [
  ['s', 'il'], ['s', 'ils'], ['faut', 'il'], ['dois', 'je'], ['doit', 'on'], ['doit', 'il'], ['est', 'ce', 'qu', 'il', 'faut'],
  ['est', 'ce', 'que', 'je', 'dois'], ['est', 'ce', 'qu', 'on', 'doit'], ['me', 'demande'], ['me', 'demandais'],
  ['se', 'demande'], ['what', 'if'], ['should', 'i'], ['should', 'we'], ['shall', 'i'], ['shall', 'we'], ['i', 'would'],
  ['we', 'would'], ['would', 'it'],
];
/** Verbe d'ordre au conditionnel ou à l'imparfait (« j'imputerais », « si j'imputais ») : jamais un ordre. */
const COND_OR_IMPERFECT =
  /^(?:imput|affect|attribu|assign|transmett|confi|envoy|enverr|relanc|rappel|rappell|press|redig|redige|repond)(?:erais|erait|erions|eriez|eraient|rais|rait|rions|riez|raient|ais|ait|ions|iez|aient)$/;
/** Expressions figées NEUTRES : leurs mots ne nient ni ne supposent rien (« n'oublie pas de », « s'il te plaît »). */
const NEUTRAL_IDIOMS: readonly (readonly string[])[] = [
  ['s', 'il', 'te', 'plait'], ['s', 'il', 'vous', 'plait'], ['n', 'oublie', 'pas'], ['n', 'oubliez', 'pas'],
  ['n', 'oublions', 'pas'], ['ne', 'pas', 'oublier'], ['n', 'hesite', 'pas'], ['n', 'hesitez', 'pas'], ['ne', 'tarde', 'pas'],
  ['ne', 'tardez', 'pas'], ['ne', 'manque', 'pas'], ['ne', 'manquez', 'pas'], ['sans', 'faute'], ['sans', 'tarder'],
  ['sans', 'plus', 'attendre'], ['sans', 'attendre'], ['sans', 'delai'], ['sans', 'delais'], ['pas', 'plus', 'tard', 'que'],
  ['pas', 'plus', 'tard', 'qu'], ['no', 'later', 'than'], ['don', 't', 'forget'], ['do', 'not', 'forget'], ['never', 'forget'],
  ['don', 't', 'hesitate'], ['do', 'not', 'hesitate'], ['without', 'delay'], ['without', 'fail'], ['si', 'possible'],
  ['if', 'possible'], ['si', 'tu', 'peux'], ['si', 'vous', 'pouvez'], ['if', 'you', 'can'], ['if', 'you', 'could'],
  ['pas', 'de', 'souci'], ['pas', 'de', 'probleme'], ['no', 'problem'], ['not', 'only'], ['pas', 'seulement'],
  ['non', 'seulement'],
];
/** Pronoms compléments entre le verbe et une négation familière (« relance-le pas »). */
const OBJECT_PRONOUNS: ReadonlySet<string> = new Set(['le', 'la', 'les', 'l', 'lui', 'leur', 'y', 'en', 'it', 'them']);

function idiomMask(words: readonly string[]): boolean[] {
  const mask = words.map(() => false);
  for (let i = 0; i < words.length; i++) {
    for (const seq of NEUTRAL_IDIOMS) {
      if (startsSequence(words, i, seq)) for (let k = 0; k < seq.length; k++) mask[i + k] = true;
    }
  }
  return mask;
}

type MarkerKind = 'neg' | 'hyp' | 'ne';

/** Marqueur qui COMMENCE au mot `k` (mots neutralisés ignorés). « ne » seul n'est qu'un début de négation. */
function markerAt(words: readonly string[], ignored: readonly boolean[], k: number): MarkerKind | null {
  if (ignored[k]) return null;
  const w = words[k] ?? '';
  const next = words[k + 1] ?? '';
  if (w === 'no' && /^\d/.test(next)) return null; // « mail no 12 »
  if (NEG_WORDS.has(w) || NEG_STEMS.test(w)) return 'neg';
  if (NEG_BEFORE_DE.test(w) && (next === 'de' || next === 'd')) return 'neg';
  if (EN_T_AUX.has(w) && next === 't' && !ignored[k + 1]) return 'neg';
  if (w === 'dont' && EN_DONT_NEXT.has(next)) return 'neg';
  if (w === 'plus' && (next === 'besoin' || (next === 'la' && words[k + 2] === 'peine'))) return 'neg';
  if (w === 'ne' || (w === 'n' && next !== '' && !/^\d/.test(next))) return 'ne';
  if (HYP_WORDS.has(w) || COND_OR_IMPERFECT.test(w)) return 'hyp';
  for (const seq of HYP_SEQUENCES) {
    if (startsSequence(words, k, seq) && seq.every((_, j) => !ignored[k + j])) return 'hyp';
  }
  return null;
}

function partnerBetween(words: readonly string[], ignored: readonly boolean[], from: number, to: number): boolean {
  for (let j = from; j < Math.min(to, words.length); j++) {
    if (!ignored[j] && FR_NEG_PARTNERS.has(words[j] ?? '')) return true;
  }
  return false;
}

/**
 * Le verbe d'ordre en `p` (sur `m` mots) est-il nié, refusé ou hypothétique dans sa proposition ? Marqueur AVANT le
 * verbe (« pas de », « surtout pas », « sans », « évite de », « je me demande si », « do not want you to »),
 * « ne … pas » encadrant le verbe, verbe au conditionnel ou à l'imparfait, ou négation familière juste après
 * (« impute pas »).
 */
function isRefusedAt(words: readonly string[], ignored: readonly boolean[], p: number, m: number): boolean {
  for (let k = 0; k < p; k++) {
    const kind = markerAt(words, ignored, k);
    if (kind === 'neg' || kind === 'hyp') return true;
    if (kind === 'ne' && partnerBetween(words, ignored, k + 1, p + m + 3)) return true;
  }
  if (COND_OR_IMPERFECT.test(words[p] ?? '')) return true;
  let q = p + m;
  if (OBJECT_PRONOUNS.has(words[q] ?? '')) q++;
  return !ignored[q] && (words[q] === 'pas' || words[q] === 'jamais');
}

/** Premier marqueur de négation ou d'hypothèse d'une proposition (pour écarter ce qu'elle désigne). */
function clauseCut(words: readonly string[], ignored: readonly boolean[]): { at: number; kind: 'neg' | 'hyp' } | null {
  for (let k = 0; k < words.length; k++) {
    const kind = markerAt(words, ignored, k);
    if (kind === 'neg' || kind === 'hyp') return { at: k, kind };
    if (kind === 'ne' && partnerBetween(words, ignored, k + 1, words.length)) return { at: k, kind: 'neg' };
  }
  return null;
}

// --- Emplois qui ne demandent pas l'action ----------------------------------------------------------------

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
/** « presse-toi », « pressez-vous » : se dépêcher, pas une relance. */
const PRESS_REFLEXIVE_AFTER = new Set(['toi', 'vous', 'nous', 'te', 'moi']);
/**
 * Verbe d'imputation suivi d'un pronom de la 1re personne (« transmets-moi un résumé », « envoie-moi », « forward me ») :
 * l'utilisateur demande quelque chose POUR LUI, pas une imputation (qui attend un destinataire tiers).
 */
const SELF_RECIPIENT_AFTER = new Set(['moi', 'me', 'nous', 'us', 'm']);

function wordsAround(text: string, index: number, length: number): { before: string[]; word: string; next: string; after: string[] } {
  const before = text.slice(0, index).trim().split(' ').filter(Boolean);
  const rest = text.slice(index).trim().split(' ').filter(Boolean);
  const matchedWords = text.slice(index, index + length).trim().split(' ').filter(Boolean).length || 1;
  return { before, word: rest[0] ?? '', next: rest[1] ?? '', after: rest.slice(matchedWords) };
}

/** L'occurrence est-elle un constat (participe), un remerciement ou un emploi qui ne demande pas l'action ? */
function isNonOrderUse(tool: string, text: string, index: number, length: number): boolean {
  const { before, word, next: nextWord, after } = wordsAround(text, index, length);
  const prev1 = before[before.length - 1] ?? '';
  if (AUX_IMMEDIATE.has(prev1)) return true;
  // « merci pour la réponse », « thanks for the draft » : un remerciement n'est pas une demande.
  const window = before.slice(-4).join(' ');
  if (/\b(?:merci(?: beaucoup| bien)? pour|thanks? (?:you )?for)\b/.test(window)) return true;

  if (tool === AsstActionTool.ImputationCourrier) {
    if (SELF_RECIPIENT_AFTER.has(nextWord)) return true;
  }
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
    if (PRESS_WORD.test(word) && (PRESS_NOUN_BEFORE.has(prev1) || PRESS_REFLEXIVE_AFTER.has(nextWord))) return true;
  }
  return false;
}

/** Une proposition contient-elle un ordre (non nié, non hypothétique, hors constat ou remerciement) pour l'outil ? */
function clauseOrders(tool: string, clause: Clause): boolean {
  const patterns = INTENT_PATTERNS[tool];
  if (!patterns) return false;
  const text = clause.words.join(' ');
  const ignored = idiomMask(clause.words);
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, 'g');
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      const p = text.slice(0, m.index).split(' ').filter(Boolean).length;
      const len = m[0].trim().split(' ').filter(Boolean).length || 1;
      if (isRefusedAt(clause.words, ignored, p, len)) continue;
      if (isNonOrderUse(tool, text, m.index, m[0].length)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Un texte (replié ou normalisé) contient-il un ordre pour l'outil ? Analyse proposition par proposition : un même
 * texte peut contenir un ordre positif et un autre nié ; seul le positif compte.
 */
export function textOrders(tool: string, normalizedText: string): boolean {
  if (!INTENT_PATTERNS[tool]) return false;
  return clausesOfFolded(normalizedText).some((c) => clauseOrders(tool, c));
}

/** Formules de DEMANDE polie qui font d'une question un ordre (« peux-tu imputer… ? »). */
const REQUEST_MODALS =
  /\b(?:peux tu|pourrais tu|pouvez vous|pourriez vous|veux tu|voudrais tu|voulez vous|voudriez vous|tu peux|tu pourrais|vous pouvez|vous pourriez|merci de|can you|could you|would you|will you|please)\b/;

/** Phrases d'un texte de l'utilisateur (repliées et normalisées), avec leur nature interrogative. */
export function userSentences(text: string): Array<{ norm: string; folded: string; question: boolean }> {
  const folded = foldText(text);
  const out: Array<{ norm: string; folded: string; question: boolean }> = [];
  for (const m of folded.matchAll(/[^.!?;\n…]+[.!?;\n…]*/g)) {
    const chunk = m[0];
    const norm = normalizeWords(chunk);
    if (!norm) continue;
    out.push({ norm, folded: chunk, question: /\?/.test(chunk) });
  }
  return out;
}

/**
 * L'intention est-elle établie ? Les textes de l'utilisateur (bruts) doivent contenir un ordre cohérent avec l'outil.
 * Une QUESTION (« est-ce que ce courrier est imputé à la DAF ? ») n'est pas un ordre, sauf formule de demande
 * (« peux-tu imputer… ? »). Négation, refus, hypothèse, doute, conditionnel ne comptent pas (proposition par
 * proposition). Outil inconnu (dont la délégation) : toujours faux. Le CHOIX des textes (message courant seul, ou
 * réponse à une question de précision) revient à l'appelant (`intentHistory`, `liveUserTexts`).
 */
export function intentAllows(tool: string, userTexts: readonly string[]): boolean {
  if (!INTENT_PATTERNS[tool]) return false;
  return userTexts.some((t) =>
    userSentences(t).some((s) => (!s.question || REQUEST_MODALS.test(s.norm)) && textOrders(tool, s.folded)),
  );
}

// ---------------------------------------------------------------------------
// Polarité : ce que le texte DÉSIGNE positivement, ce qu'il EXCLUT, ce qu'il SUPPOSE
// ---------------------------------------------------------------------------

export interface UserTextPolarity {
  /** Texte replié privé des passages niés et hypothétiques (désignations, numéros, type, délai). */
  positive: string;
  /** Passages NIÉS ou refusés (« pas à la DRH », « sauf Awa ») : ce qu'ils désignent est EXCLU. */
  negated: string;
  /** Passages hypothétiques (« si … », conditionnel, doute) : ignorés. */
  hypothetical: string;
}

/**
 * Sépare un texte de l'utilisateur selon la polarité de ses propositions : dans chaque proposition, tout ce qui suit
 * le premier marqueur de négation (ou d'hypothèse) est retiré du texte positif. Exemple : « impute à la DAF mais pas
 * à la DRH » donne positif « impute à la DAF mais », nié « pas à la DRH ».
 */
export function splitPolarity(text: string): UserTextPolarity {
  const folded = foldText(text);
  const cuts: Array<{ s: number; e: number; kind: 'neg' | 'hyp' }> = [];
  for (const c of clausesOfFolded(folded)) {
    const cut = clauseCut(c.words, idiomMask(c.words));
    if (!cut) continue;
    cuts.push({ s: c.base + (c.tokens[cut.at]?.start ?? 0), e: c.base + c.folded.length, kind: cut.kind });
  }
  let positive = '';
  let last = 0;
  const negated: string[] = [];
  const hypothetical: string[] = [];
  for (const cut of cuts) {
    positive += `${folded.slice(last, cut.s)}\n`;
    (cut.kind === 'neg' ? negated : hypothetical).push(folded.slice(cut.s, cut.e));
    last = cut.e;
  }
  positive += folded.slice(last);
  return { positive, negated: negated.join('\n'), hypothetical: hypothetical.join('\n') };
}

/** Textes de l'utilisateur (message courant d'abord), normalisés en mots, privés des passages niés ou hypothétiques. */
export function normalizeUserTexts(current: string, previous: readonly string[]): string[] {
  return [current, ...previous].map((t) => normalizeWords(splitPolarity(t).positive)).filter((t) => t.length > 0);
}

/** Passages NIÉS des textes de l'utilisateur, normalisés (pour exclure ce qu'ils désignent). */
export function negatedUserTexts(current: string, previous: readonly string[]): string[] {
  return [current, ...previous].map((t) => normalizeWords(splitPolarity(t).negated)).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Historique : quels messages PRÉCÉDENTS portent encore l'intention
// ---------------------------------------------------------------------------

const CANCEL_PATTERNS: readonly RegExp[] = [
  /^(?:non|no|nope|nan|nah|stop)\b/,
  /\b(?:annul[a-z]*|cancel[a-z]*)\b/,
  /\b(?:laisse|laisses|laissez|laissons) tomber\b/,
  /\boublie[sz]?\b/,
  /\bfinalement\b/,
  /\b(?:stop|abandonne|abandonnez|abandonnons)\b/,
  /^(?:arrete|arretez|arretons)\b/,
  /\barret(?:e|ez|ons) tout\b/,
  /\b(?:je|j|on|nous) (?:ne |n )?(?:veux|veut|voulons|souhaite|souhaitons|desire) (?:pas|plus)\b/,
  /\bn en (?:veux|veut|voulons) (?:pas|plus)\b/,
  /\b(?:pas|plus) (?:besoin|la peine)\b/,
  /\binutile\b/,
  /\bne (?:fais|faites|fait) rien\b/,
  /\brien du tout\b/,
  /\b(?:never ?mind|nevermind|forget (?:it|that|about it)|scratch that|i don t want|i do not want|do not do|don t do|no need|not needed|no thanks|no thank you)\b/,
];
/** Message de pure politesse ou d'acquiescement (« merci », « ok merci ») : clôt l'échange en cours. */
const CLOSING_ONLY =
  /^(?:(?:ok|okay|d accord|daccord|merci|beaucoup|bien|tres|thanks|thank|you|thx|parfait|super|top|genial|cool|bonne|journee|soiree|au|revoir|bye|recu|c|est|note|entendu|great|perfect|nice|good|fine|alright|all|right)\s*)+$/;

/**
 * Le message ANNULE-t-il ce qui précède (« annule », « non », « laisse tomber », « finalement », « je ne veux pas… »,
 * « stop »), ou n'est-il qu'une formule de clôture (« merci ») ? Les expressions neutres (« n'oublie pas de ») ne
 * comptent pas.
 */
export function isCancellation(text: string): boolean {
  const words = normalizeWords(text).split(' ').filter(Boolean);
  if (words.length === 0) return false;
  const ignored = idiomMask(words);
  const kept = words.filter((_, i) => !ignored[i]).join(' ');
  if (CLOSING_ONLY.test(words.join(' '))) return true;
  return CANCEL_PATTERNS.some((re) => re.test(kept));
}

/** Nombre maximal d'allers-retours « question de précision / réponse » remontés dans l'historique. */
export const INTENT_HISTORY_MAX_ROUNDS = 4;

/**
 * Messages PRÉCÉDENTS de l'utilisateur qui portent encore l'intention (ordre chronologique). Règle : seul le message
 * COURANT établit l'intention, SAUF s'il répond à une question de précision : le dernier message de l'historique est
 * alors un message assistant portant le marqueur de question (`isClarificationContent`), et le message utilisateur
 * qui le précède compte (et ainsi de suite pour une chaîne de questions, bornée). Une annulation (message courant ou
 * message de la chaîne) rend caducs les ordres antérieurs ; dans tous les autres cas, rien n'est repris.
 */
export function intentHistory(
  history: ReadonlyArray<{ role: AsstMessageRole; content: string }>,
  current: string,
): string[] {
  if (isCancellation(current)) return [];
  const chain: string[] = [];
  let i = history.length - 1;
  for (let round = 0; round < INTENT_HISTORY_MAX_ROUNDS; round++) {
    const asked = history[i];
    const said = history[i - 1];
    if (!asked || asked.role !== AsstMessageRole.Assistant || !isClarificationContent(asked.content)) break;
    if (!said || said.role !== AsstMessageRole.User || typeof said.content !== 'string') break;
    chain.unshift(said.content);
    if (isCancellation(said.content)) break;
    i -= 2;
  }
  return chain;
}

/**
 * Défense en profondeur du validateur : messages précédents encore valides (ordre chronologique). Un message courant
 * d'annulation les rend tous caducs ; sinon, seuls la DERNIÈRE annulation de la liste et ce qui la suit restent.
 */
export function liveUserTexts(current: string, previous: readonly string[]): string[] {
  if (isCancellation(current)) return [];
  let from = 0;
  previous.forEach((t, i) => {
    if (isCancellation(t)) from = i;
  });
  return previous.slice(from);
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
 * Délai d'UN texte selon sa polarité : extrait des passages positifs ; un nombre de jours cité dans un passage nié ou
 * hypothétique (« pas sous 5 jours », « si c'est trop court, 5 jours ») rend le délai ambigu (jamais appliqué).
 */
function polarDelay(text: string): DelayExtraction & { excluded: boolean } {
  const pol = splitPolarity(text);
  const e = extractDelayCandidates(pol.positive);
  const x = extractDelayCandidates(`${pol.negated}\n${pol.hypothetical}`);
  return { ...e, excluded: x.days.length > 0 };
}

/**
 * Délai imposé par le CODE : message COURANT d'abord ; à défaut, l'historique (un seul délai distinct pour
 * l'ensemble des messages précédents). Plusieurs délais, délai non convertible ou hors 1..90, délai cité dans un
 * passage nié ou hypothétique : ambigu. Aucun délai évoqué : pas de délai (celui que le modèle aurait mis est écarté).
 */
export function decideDelay(current: string, previous: readonly string[]): DelayDecision {
  const cur = polarDelay(current);
  if (cur.excluded) return { status: 'ambiguous' };
  const first = decideOne(cur);
  if (first) return first;
  const merged: DelayExtraction = { days: [], vague: false };
  for (const t of previous) {
    const e = polarDelay(t);
    if (e.excluded) return { status: 'ambiguous' };
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
    const excluded: number[] = [];
    for (const t of texts) {
      // Type cité dans un passage nié ou hypothétique (« pas en copie ») : jamais appliqué, ni remplacé par le défaut.
      const pol = splitPolarity(t);
      const m = detectTypeMentions(pol.positive, activeTypes);
      const x = detectTypeMentions(`${pol.negated}\n${pol.hypothetical}`, activeTypes);
      for (const id of m.strong) if (!strong.includes(id)) strong.push(id);
      for (const id of m.weak) if (!weak.includes(id)) weak.push(id);
      for (const id of x.strong) if (!excluded.includes(id)) excluded.push(id);
    }
    if (excluded.length > 0) {
      const candidates = [...strong, ...excluded.filter((id) => !strong.includes(id))];
      return { status: 'ambiguous', candidates };
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
