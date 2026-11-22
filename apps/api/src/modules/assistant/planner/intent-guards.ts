import { AsstActionTool, AsstMessageRole } from '@archivage/types';
import { MAIL_INPUTATION_TYPE_IDS } from '../../workflow-agent-catalog/catalog.contracts';
import { sanitizeText } from '../../workflow-agents/injection/untrusted';
import {
  INTENT_CONFIRM_NO,
  INTENT_CONFIRM_YES,
  isClarificationContent,
  parseClarificationContent,
  parseIntentConfirmation,
} from './clarification-format';
import type { PlannerInputationTypeView } from './planner.types';

// Gardes d'INTENTION du validateur d'actions (fonctions pures, sans accès aux données).
//
// Le message de l'utilisateur est la SEULE source d'intention : ces fonctions lisent exclusivement les textes de
// l'utilisateur (message courant et messages précédents de l'échange), jamais un texte de courrier, un nom d'acteur
// ou une sortie du modèle. Elles sont TOLÉRANTES (casse, accents, conjugaisons usuelles, français et anglais) mais
// l'échec reste fermé : en cas de doute, le validateur pose une question ou refuse.
//
// PRINCIPE « LISTE BLANCHE » (tour de correction X3, remplace la décision par liste noire du tour X2). Une liste de
// mots de réserve ne peut pas rattraper toutes les formulations libres (échec OUVERT pour l'inconnu) ; la décision
// se fait donc en TROIS contrôles, et seule leur conjonction donne une proposition DIRECTE :
//  1. `intentAllows` : existe-t-il un ordre POSITIF pour l'outil (analyse par propositions, négations et hypothèses
//     écartées) ? Non : refus `intent_not_established` (rien du tout) ;
//  2. `directForm` (LISTE BLANCHE, section en fin de fichier) : le message a-t-il la FORME d'un ordre simple, dont
//     TOUS les mots sont connus ? Non (mot ou structure inconnus) : AUCUNE proposition directe, le validateur pose la
//     question de confirmation construite par le code (« Voulez-vous que je prépare : … ? », deux choix) ;
//  3. `intentMarks` (CEINTURE, liste noire conservée) : le message ENTIER (aucun découpage) porte-t-il une MARQUE de
//     refus, d'annulation, de report, de doute, d'hypothèse, de demande d'information, de substitution, de citation,
//     de simulation, d'ironie ou de parole d'un tiers ? Oui : question de confirmation, même si la forme est admise.
//
// Règles de forme (`directForm`, textes repliés : sans accents, casse ignorée, apostrophes et tirets = espaces) :
//
//   | Élément              | Admis                                                                                |
//   | -------------------- | ------------------------------------------------------------------------------------ |
//   | Caractères           | lettres, chiffres, espaces, apostrophe, `, . ! ? ; : - — – ° #`, `/` entre deux       |
//   |                      | caractères alphanumériques (référence « CE/2026/0042 »). Tout le reste (guillemets,   |
//   |                      | parenthèses, `>`, `…`, `...`, ` /s`, autres écritures) : structure refusée            |
//   | Phrases, segments    | phrases séparées par `. ! ? ; saut de ligne` ; segments par `, :` et tiret espacé ;   |
//   |                      | « et », « puis », « mais », « and », « then » suivis d'un verbe d'ordre ouvrent un    |
//   |                      | nouvel ordre. `?` seulement avec une formule polie (« peux-tu », « can you »…)        |
//   | Segment de clôture   | merci (beaucoup, bien), svp, stp, please, thanks, bonjour, bonsoir, salut, hello, ok, |
//   |                      | vite, allez (y), vas-y, go ahead, fais-le, do it, urgent, c'est (très, assez) urgent, |
//   |                      | dès que possible, au plus vite, asap, pas de souci, sans tarder, « c'est la deuxième  |
//   |                      | fois que je le demande » ; admis partout                                              |
//   | Préfixe d'ordre      | interjections (bonjour, please, svp, stp, vite, allez, vas-y, s'il te plaît) puis au  |
//   |                      | plus une formule : peux-tu, pouvez-vous, pourrais-tu, pourriez-vous, tu peux, vous    |
//   |                      | pouvez, merci de, pense(z) à, n'oublie(z) pas de, ne pas oublier de, n'hésite(z) pas  |
//   |                      | à, veuillez, il faut (que tu/vous), je veux (que tu/vous), je souhaite (que tu/vous), |
//   |                      | j'ai besoin de / que tu, commence(z) par, aide(z)-moi à, je te/vous demande de, tu,   |
//   |                      | vous, on, can you, could you, please, i need you to, i want you to, go ahead and ;   |
//   |                      | passif voulu : « je veux / je souhaite / il faut que ce courrier (n) soit », « ce     |
//   |                      | courrier (n) doit être » + participe ; puis pronoms (le, la, l', les, lui, leur, me)  |
//   | Tête (verbe d'ordre) | imputer, affecter, attribuer, assigner, transmettre, confier, envoyer, donner,        |
//   |                      | mettre, allouer, dispatcher, diriger, passer, faire passer, assign, forward, send,    |
//   |                      | give, route, share, allocate, hand ; relancer, rappeler, presser, pousser, remind,    |
//   |                      | chase, nudge, follow up ; préparer, rédiger, écrire, générer, créer, répondre,        |
//   |                      | prepare, draft, write, create, generate, compose, reply, respond, answer ; faire (+   |
//   |                      | objet : une relance, un rappel, un brouillon…) ; nominal en tête : imputation,        |
//   |                      | affectation, attribution, assignation, transmission, relance, brouillon, projet       |
//   | Queue (après la tête)| déterminants et pronoms, connecteurs (à, au, aux, pour, de, du, des, en, avec, et     |
//   |                      | entre cibles, vers, chez, sur, dans, sous, par, concernant, to, for, the, a, this,    |
//   |                      | with, in, within, under, about, on, of, and…), noms du domaine (courrier, mail,       |
//   |                      | lettre, dossier, retard, délai, copie, suivi, validation, information, traitement,    |
//   |                      | bureau, charge, espace, modèle…), adverbes (maintenant, immédiatement, tout de suite, |
//   |                      | aussi, now…), politesse (merci, svp, please, s'il te plaît), « à titre               |
//   |                      | d'information », « ne pas oublier », types (libellés actifs et alias), DÉSIGNATIONS   |
//   |                      | CONNUES (acteurs et groupes renvoyés par les outils, espaces, modèles, références et  |
//   |                      | recherches de courrier qui l'établissent : `DirectFormLexicon` ; jamais le filtre de  |
//   |                      | recherche du modèle ; un désignateur qui porte une marque, un verbe d'ordre ou que    |
//   |                      | des chiffres est écarté) ; « moi » juste après « impute », un verbe de brouillon ou   |
//   |                      | « fais » (« impute-moi ce courrier », « fais-moi un brouillon ») ; « l'imputé » après |
//   |                      | un déterminant ; qualificatifs d'une réponse (polie, courte, formelle, short…) ; noms |
//   |                      | d'action seulement en objet du bon verbe (« relance l'imputation », « fais une        |
//   |                      | relance », « prépare un brouillon »)                                                  |
//   | Nombres              | après courrier / mail / n° / numéro / réf. ; ou nombre + unité (jours, semaines,      |
//   |                      | mois ; heures après sous / en / within / under) précédé de sous, dans, en, d'ici,     |
//   |                      | délai (de), within, in, under ; « pour demain », « d'ici demain »                    |
//   | Texte sans ordre     | admis seulement comme RÉPONSE (texte d'historique) : numéro de choix, valeur seule,   |
//   |                      | désignations connues ; un complément AVANT le premier ordre est refusé (« Un jour,    |
//   |                      | impute… », « Dans une heure, impute… »)                                               |
//
// Tout le reste (mot inconnu : « lol », « songe », « historique », « Paul » non renvoyé par un outil… ; verbe d'ordre
// hors de la tête : « rappelle-moi d'imputer », « passe sur l'imputation » ; structure : citation, question sans
// formule polie) donne la question de confirmation, JAMAIS une proposition directe. `directForm` renvoie la raison du
// rejet (diagnostic des tests seulement : jamais journalisée ni montrée à l'utilisateur).
//
// Marques de la CEINTURE (`intentMarks`). La liste est volontairement LARGE (un mot douteux est une marque) : un faux
// positif ne coûte qu'une question. Marques reconnues (repliées : sans accents, casse ignorée, pleine chasse ramenée,
// invisibles retirés) :
//  - négation, refus : « ne » / « n' » devant un mot, pas, jamais, plus (« plus tard », « plus besoin », « plus la
//    peine », « plus jamais »), aucun(e)(s), sans, rien, ni, non, nul(le), inutile, interdit…, impossible…, refus…,
//    contre, oppos… (« m'oppose »), évit…, annul…, supprim…, désactiv…, arrêt…, cess…, stop, bad, mauvais(e), idée ;
//    not, never, no (sauf « no 12 »), without, nothing, none, nobody, nor, neither, cannot, refrain, avoid…, cancel…,
//    « don't / won't / can't… » (et « dont » devant un verbe anglais) ;
//  - report : attend…, patient…, wait…, hold, tard (« plus tard »), later, avant (« avant de »), report…, différ…,
//    postpone…, defer…, suspend… (« pas maintenant », « pas encore », « pas tout de suite », « ne bouge pas » via
//    « pas » / « ne ») ;
//  - substitution : plutôt, lieu (« au lieu de »), place (« à la place »), instead, rather, sauf, except…, excepté,
//    hormis, excluding, autre(s), ou, or, otherwise, sinon ;
//  - hypothèse, doute : si, « s'il », if, whether, « faut-il », « dois-je », « doit-on », devr…(conditionnel),
//    faudrait, faudra, supposons, imaginons, admettons, suppose, imagine, hypothèse…, wonder…, maybe, perhaps,
//    « peut-être », éventuel…, probablement, probably, possibly, should, would, might, could, shall, croi… (« je crois
//    que »), pens… (sauf « pense à »), think, believe, guess, doute…, doubt, hésit…, hesitate, réfléchi…, réflexion,
//    tant (« tant que »), quand, lorsque, « me demande » / « se demande », demandais ; conditionnel (mot en -rais,
//    -rait, -rions, -riez, -raient : « j'imputerais », « que se passerait-il », « ça donnerait ») ; imparfait d'un
//    verbe d'ordre (« si j'imputais ») ;
//  - demande d'information : comment, pourquoi, quoi (« c'est quoi »), « qu'est-ce », « est-ce que », quel(le)(s),
//    lequel…, combien, statut, status, liste…, list…, expliqu…, explain…, montr…, affich…, display…, vérifi…,
//    check…, consult…, résum…, summar…, « dis-moi », « tell me », how, why, what, which, who, whom, whose, when,
//    where, show, fyi, « qui » en tête de phrase ; et toute phrase qui contient « ? » sans formule polie de demande
//    (« peux-tu », « pouvez-vous », « pourrais-tu », « pourriez-vous », « can you », « could you ») ;
//  - annulation (formes de `CANCEL_PATTERNS`, tour X3) : finalement, laisse(z) (tomber), oubli… (hors « n'oublie pas
//    de »), forget, never mind, scratch that, abandon…, renonc…, absten…, ignor…, omet…, bloqu…, empêch…, révoqu…,
//    rejet…, déclin…, écart…, épargn…, dispens…, gel…, skip, drop, ditch, scrap, abort…, undo, revert…, veto,
//    disregard…, pause, snooze, mute, zéro ; report : repouss…, ultérieur…, prochain…, soir ; doute : song…,
//    envisag…, verr… (« on verra »), voir, tenté(e), bof, enfin ;
//  - citation : guillemets (« », " “ ”), exemple…, example, citation, cite(r), quote…, tradui…, traduction,
//    translat…, reformul…, rephras…, répét…, repeat…, phrase(s), consigne…, dit, disent, dis, dites, écrit, says,
//    said, told, tells, wrote, writes, « m'a dit », « m'a écrit » ;
//  - simulation : simul…, test…, essai…, pretend…, « dry run », « à blanc », « pour voir », « as if », « comme si » ;
//  - ironie : lol, mdr, ptdr, jk, haha, rigole, plaisant…, blague, sarcas…, ironi…, kidding, joke…, évidemment,
//    « bien sûr », « yeah right », « /s » ;
//  - parole d'un TIERS : veut, veulent, souhaite(nt), exige(nt), insiste(nt), demande(nt), indique(nt), affirme(nt),
//    répondu, wants, asks, asked, insists, requests, requested, dont le sujet n'est ni « je », ni « tu », ni « nous »,
//    ni « vous », ni « on » (pronoms compléments sautés ; en tête de phrase : impératif « demande à Paul de ») ;
//    « m'a demandé », « il paraît », apparemment, selon, « d'après ».
// Idiomes NEUTRES (ne sont pas des marques) : « s'il te plaît », « s'il vous plaît », please, « n'hésite pas (à) »,
// « n'oublie pas (de) », « ne pas oublier (de) », « ne pas hésiter », « don't forget », « don't hesitate »,
// « sans tarder », « pas de souci(s) », merci ; et les formules polies ci-dessus (ni conditionnel ni question).
// Un ordre légitime qui porte une marque (« impute à la DAF mais pas à la DRH », « si possible, impute… ») ou un mot
// hors liste blanche passe donc par la question de confirmation : c'est voulu. Ses passages niés restent EXCLUS
// (partition `splitPolarity`), même après confirmation.

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
  /\bhand\b(\s+[a-z0-9]+){0,3}?\s+over\b/,
  // Verbes d'ordre courants, CIBLE EXPLICITE exigée (« donne ce courrier à la DAF », « pass this mail to Awa »).
  /\bdonne(s|z|r)?\b(\s+[a-z0-9]+){0,4}?\s+(a|au|aux)\b/,
  /\bmet(s|tez|tre|tons)?\b(?!\s+a\s+jour)(\s+[a-z0-9]+){0,5}?\s+(a|au|aux|sur\s+le\s+bureau|en\s+copie|en\s+charge)\b/,
  /\bdirig(e|es|ez|er|eons)\b(\s+[a-z0-9]+){0,4}?\s+vers\b/,
  /\balloue(s|z|r)?\b(\s+[a-z0-9]+){0,4}?\s+(a|au|aux)\b/,
  /\bpass\s+(it|this|that|the)\b(\s+[a-z0-9]+){0,3}?\s+to\b/,
  /\bgive\b(\s+[a-z0-9]+){0,4}?\s+to\b/,
  /\broute\b(\s+[a-z0-9]+){0,4}?\s+to\b/,
  /\bshare\b(\s+[a-z0-9]+){0,4}?\s+with\b/,
];

const RELANCE_PATTERNS: readonly RegExp[] = [
  /\brelanc[a-z]*\b/,
  /\brappel[a-z]*\b/,
  /\bpress(e|er|ez|es|ons)\b/,
  /\bremind[a-z]*\b/,
  /\bchase[a-z]*\b/,
  /\bfollow\s+up\b/,
  /\bnudge[a-z]*\b/,
  // « pousse Awa à traiter ce courrier » : relance (cible puis « à traiter » exigés).
  /\bpouss(e|es|ez|er|ons)\b(\s+[a-z0-9]+){1,4}?\s+a\s+traiter\b/,
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

/**
 * Verbe d'ordre (tous outils) : « et » / « and » suivi, dans les 3 mots, d'un tel verbe ouvre une NOUVELLE proposition
 * (« ne l'impute pas à la DRH et impute-le à la DAF »). Sans risque depuis le principe de confirmation : la négation
 * qui précède reste une MARQUE du message (question de confirmation), et ce découpage ne fait qu'empêcher une
 * négation de déborder sur l'ordre suivant (et d'en EXCLURE la cible). « et à la DRH » (sans verbe) ne coupe pas.
 */
const ORDER_VERB_WORD =
  /^(?:imput|affect|attribu|assign|transm|confi|envoi|envoy|pass|donne|mets|met|alloue|allocat|dispatch|dirig|forward|send|give|route|share|hand|relanc|rappel|remind|chase|press|pouss|redig|redact|prepar|draft|repond|reply|respond|answer|ecri|write|gener|create|fais|faites|faire)/;

function startsOrderAfterAnd(words: readonly string[], i: number): boolean {
  const w = words[i];
  if (w !== 'et' && w !== 'and') return false;
  for (let k = i + 1; k <= i + 3 && k < words.length; k++) {
    if (ORDER_VERB_WORD.test(words[k] ?? '')) return true;
  }
  return false;
}

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
      if (BOUNDARY_SEQUENCES.some((seq) => startsSequence(words, i, seq)) || startsOrderAfterAnd(words, i)) {
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
  'excluding', 'refrain', 'non', 'nul', 'nulle', 'contre', 'nobody',
]);
/**
 * Familles de verbes de refus ou d'opposition (« évite d'imputer », « annule la relance », « je refuse d'imputer »,
 * « il est interdit de », « impossible de », « je m'oppose à », « désactive l'imputation »).
 */
const NEG_STEMS = /^(?:evit|annul|supprim|cancel|avoid|refus|interdi|impossib|oppos|desactiv)[a-z]*$/;
/** Substitution (« plutôt que d'imputer », « au lieu de relancer », « instead of »), hors de question : refus. */
const NEG_SEQUENCES: readonly (readonly string[])[] = [
  ['plutot', 'que'], ['plutot', 'qu'], ['au', 'lieu'], ['instead', 'of'], ['rather', 'than'], ['a', 'la', 'place', 'de'],
  ['a', 'la', 'place', 'd'], ['hors', 'de', 'question'],
];
/**
 * Demande d'information et report AVANT le verbe (« dis-moi comment imputer », « montre-moi l'imputation »,
 * « attends avant d'imputer ») : pas un ordre (classés « hypothèse » : ils retirent, sans exclure).
 */
const INFO_OR_DEFER_WORDS: ReadonlySet<string> = new Set([
  'comment', 'pourquoi', 'how', 'why', 'statut', 'status', 'hold', 'later', 'wait', 'waiting',
]);
const INFO_OR_DEFER_STEMS = /^(?:expliqu|explain|montr|affich|display|attend|patient)[a-z]*$|^list(?:e|es|ez|er|ing)?$/;
const INFO_OR_DEFER_SEQUENCES: readonly (readonly string[])[] = [
  ['dis', 'moi'], ['dites', 'moi'], ['tell', 'me'], ['c', 'est', 'quoi'], ['qu', 'est', 'ce'], ['plus', 'tard'], ['avant', 'de'],
  ['avant', 'd'],
];
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
  for (const seq of NEG_SEQUENCES) {
    if (startsSequence(words, k, seq) && seq.every((_, j) => !ignored[k + j])) return 'neg';
  }
  if (INFO_OR_DEFER_WORDS.has(w) || INFO_OR_DEFER_STEMS.test(w)) return 'hyp';
  for (const seq of INFO_OR_DEFER_SEQUENCES) {
    if (startsSequence(words, k, seq) && seq.every((_, j) => !ignored[k + j])) return 'hyp';
  }
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

/** Noms d'action toujours nominaux. */
const NOMINAL_ALWAYS =
  /^(?:imputations?|affectations?|attributions?|assignments?|assignations?|transmissions?|brouillons?|reponses?|responses?|reminders?|rappels?|redactions?)$/;
/** Formes nominales seulement après un déterminant (« la relance », « a draft », « the reply »). */
const NOMINAL_AFTER_DETERMINER = /^(?:relances?|drafts?|repl(?:y|ies)|answers?|envois?|forwards?)$/;
const DETERMINERS_BEFORE: ReadonlySet<string> = new Set([
  'la', 'le', 'les', 'l', 'une', 'un', 'des', 'du', 'de', 'd', 'cette', 'ce', 'ces', 'ma', 'mon', 'mes', 'sa', 'son', 'ses',
  'ta', 'ton', 'tes', 'votre', 'vos', 'notre', 'nos', 'leur', 'leurs', 'aucune', 'aucun', 'the', 'a', 'an', 'any', 'no', 'this',
  'that', 'my', 'your',
]);
/** Infinitifs des verbes d'ordre. */
const ORDER_INFINITIVE =
  /^(?:imputer|affecter|attribuer|assigner|transmettre|confier|envoyer|relancer|rappeler|presser|rediger|repondre|preparer|ecrire|donner|mettre|passer|allouer|dispatcher)$/;

function isWideScope(words: readonly string[], p: number): boolean {
  const w = words[p] ?? '';
  const prev = words[p - 1] ?? '';
  if (NOMINAL_ALWAYS.test(w) || ORDER_INFINITIVE.test(w) || /ing$/.test(w) || prev === 'to') return true;
  return NOMINAL_AFTER_DETERMINER.test(w) && DETERMINERS_BEFORE.has(prev);
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
  // Nom d'action, infinitif ou gérondif (« l'imputation à la DAF est inutile », « relancer Awa serait inutile ») :
  // la marque peut SUIVRE le mot ; elle compte alors n'importe où dans la proposition.
  const wide = isWideScope(words, p);
  for (let k = 0; k < (wide ? words.length : p); k++) {
    if (wide && k >= p && k < p + m) continue;
    const kind = markerAt(words, ignored, k);
    if (kind === 'neg' || kind === 'hyp') return true;
    if (kind === 'ne' && partnerBetween(words, ignored, k + 1, wide ? words.length : p + m + 3)) return true;
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

/** Noms anglais après l'article « a » / « an » (« send a reminder », « write a reply », « create a draft »). */
const EN_NOUN_AFTER_ARTICLE: ReadonlySet<string> = new Set([
  'reminder', 'reminders', 'draft', 'drafts', 'reply', 'replies', 'response', 'responses', 'answer', 'answers', 'follow', 'nudge',
  'forward',
]);
/** « est à imputer », « reste à relancer » : constat d'un état, pas un ordre. */
const STATE_BEFORE_A: ReadonlySet<string> = new Set(['est', 'sont', 'reste', 'restent', 'etait', 'etaient', 'is', 'are']);

/**
 * Le mot qui précède n'est PAS un auxiliaire malgré les apparences (lecture d'AVANT le repli « à » -> « a ») :
 *  - « a » devant un INFINITIF est la préposition « à » (« pense à relancer », « n'hésite pas à imputer », « aide-moi
 *    à imputer ») ; l'auxiliaire « a » précède un participe (« Awa a relancé »), jamais un infinitif ;
 *  - « a » devant un nom anglais est l'article (« send a reminder », « write a reply ») ;
 *  - « doit être imputé » exprime un ordre (passif d'obligation), pas un constat.
 */
function auxiliaryExempt(prev1: string, prev2: string, word: string): boolean {
  if (prev1 === 'a') {
    if (STATE_BEFORE_A.has(prev2)) return false;
    return ORDER_INFINITIVE.test(word) || EN_NOUN_AFTER_ARTICLE.has(word);
  }
  if (prev1 === 'etre') return prev2 === 'doit' || prev2 === 'doivent';
  return false;
}

function wordsAround(text: string, index: number, length: number): { before: string[]; word: string; next: string; after: string[] } {
  const before = text.slice(0, index).trim().split(' ').filter(Boolean);
  const rest = text.slice(index).trim().split(' ').filter(Boolean);
  const matchedWords = text.slice(index, index + length).trim().split(' ').filter(Boolean).length || 1;
  return { before, word: rest[0] ?? '', next: rest[1] ?? '', after: rest.slice(matchedWords) };
}

/** Une cible « à / au / aux <mot> » suit-elle, où <mot> n'est pas un infinitif (« à la DAF », pas « à lire ») ? */
function hasThirdPartyTarget(after: readonly string[]): boolean {
  for (let j = 0; j < after.length - 1; j++) {
    const w = after[j] ?? '';
    const nextW = after[j + 1] ?? '';
    if ((w === 'a' || w === 'au' || w === 'aux') && !/(?:er|ir|re)$/.test(nextW)) return true;
  }
  return false;
}

/** L'occurrence est-elle un constat (participe), un remerciement ou un emploi qui ne demande pas l'action ? */
function isNonOrderUse(tool: string, text: string, index: number, length: number): boolean {
  const { before, word, next: nextWord, after } = wordsAround(text, index, length);
  const prev1 = before[before.length - 1] ?? '';
  if (AUX_IMMEDIATE.has(prev1) && !auxiliaryExempt(prev1, before[before.length - 2] ?? '', word)) return true;
  // « merci pour la réponse », « thanks for the draft » : un remerciement n'est pas une demande.
  const window = before.slice(-4).join(' ');
  if (/\b(?:merci(?: beaucoup| bien)? pour|thanks? (?:you )?for)\b/.test(window)) return true;

  if (tool === AsstActionTool.ImputationCourrier) {
    // « impute-moi ce courrier à la DAF » (tour X3) : « moi » est un datif éthique quand une cible tierce suit
    // (« à la DAF », jamais un infinitif : « transmets-moi un résumé à lire » reste une demande pour soi).
    if (SELF_RECIPIENT_AFTER.has(nextWord) && !(/^imput/.test(word) && hasThirdPartyTarget(after))) return true;
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
// Marques de réserve sur le message ENTIER (niveau 2 du principe, voir l'en-tête)
// ---------------------------------------------------------------------------

export type IntentMarkKind =
  | 'negation'
  | 'report'
  | 'substitution'
  | 'hypothese'
  | 'information'
  | 'question'
  | 'annulation'
  | 'citation'
  | 'simulation'
  | 'ironie'
  | 'tiers';

/** Idiomes neutres pour les MARQUES (liste courte : tout le reste compte). */
const MARK_NEUTRAL_IDIOMS: readonly (readonly string[])[] = [
  ['s', 'il', 'te', 'plait'], ['s', 'il', 'vous', 'plait'], ['n', 'hesite', 'pas'], ['n', 'hesitez', 'pas'],
  ['n', 'hesitons', 'pas'], ['ne', 'pas', 'hesiter'], ['n', 'oublie', 'pas'], ['n', 'oubliez', 'pas'], ['n', 'oublions', 'pas'],
  ['ne', 'pas', 'oublier'], ['don', 't', 'forget'], ['do', 'not', 'forget'], ['don', 't', 'hesitate'], ['do', 'not', 'hesitate'],
  ['sans', 'tarder'], ['pas', 'de', 'souci'], ['pas', 'de', 'soucis'],
];
/** Formules polies de DEMANDE d'ordre : ni conditionnel (« pourrais »), ni question (« ? »). */
const POLITE_REQUESTS: readonly (readonly string[])[] = [
  ['peux', 'tu'], ['pouvez', 'vous'], ['pourrais', 'tu'], ['pourriez', 'vous'], ['can', 'you'], ['could', 'you'],
];
const POLITE_REQUEST_RE = /\b(?:peux tu|pouvez vous|pourrais tu|pourriez vous|can you|could you)\b/;

const MARK_WORDS: ReadonlyMap<string, IntentMarkKind> = new Map<string, IntentMarkKind>([
  ...[
    'ne', 'pas', 'jamais', 'aucun', 'aucune', 'aucuns', 'aucunes', 'sans', 'rien', 'ni', 'non', 'nul', 'nulle', 'inutile',
    'inutiles', 'contre', 'stop', 'bad', 'mauvais', 'mauvaise', 'idee', 'idea', 'not', 'never', 'without', 'nothing', 'none',
    'nobody', 'nor', 'neither', 'cannot', 'refrain',
  ].map((w) => [w, 'negation'] as const),
  ...['hold', 'tard', 'later', 'avant', 'patience'].map((w) => [w, 'report'] as const),
  ...[
    'plutot', 'lieu', 'place', 'instead', 'rather', 'sauf', 'excepte', 'exceptee', 'exceptes', 'hormis', 'excluding', 'autre',
    'autres', 'ou', 'or', 'otherwise', 'sinon',
  ].map((w) => [w, 'substitution'] as const),
  ...[
    'si', 'if', 'whether', 'faudrait', 'faudra', 'supposons', 'imaginons', 'admettons', 'suppose', 'imagine', 'hypothese',
    'hypotheses', 'hypothetiquement', 'hypothetically', 'maybe', 'perhaps', 'probablement', 'probably', 'possibly',
    'should', 'would', 'might', 'could', 'shall', 'think', 'believe', 'guess', 'doubt', 'hesitate', 'reflexion', 'tant',
    'quand', 'lorsque', 'demandais', 'demandait',
  ].map((w) => [w, 'hypothese'] as const),
  ...[
    'comment', 'pourquoi', 'quoi', 'quel', 'quelle', 'quels', 'quelles', 'lequel', 'laquelle', 'lesquels', 'lesquelles',
    'combien', 'statut', 'statuts', 'status', 'how', 'why', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'show',
    'fyi',
  ].map((w) => [w, 'information'] as const),
  // Tour X3 : ceinture de la liste blanche (formes d'annulation, citation, simulation, ironie).
  ...['zero'].map((w) => [w, 'negation'] as const),
  ...[
    'finalement', 'nevermind', 'forget', 'skip', 'skipped', 'drop', 'ditch', 'scrap', 'undo', 'veto', 'pause', 'snooze', 'mute',
  ].map((w) => [w, 'annulation'] as const),
  ...['soir'].map((w) => [w, 'report'] as const),
  ...['voir', 'tente', 'tentee', 'tentes', 'bof', 'enfin'].map((w) => [w, 'hypothese'] as const),
  ...[
    'phrase', 'phrases', 'dit', 'disent', 'dis', 'dites', 'ecrit', 'says', 'said', 'told', 'tells', 'wrote', 'writes', 'cite',
    'citer', 'citez', 'citation', 'citations',
  ].map((w) => [w, 'citation'] as const),
  ...[
    'lol', 'mdr', 'ptdr', 'jk', 'haha', 'hahaha', 'rigole', 'blague', 'blagues', 'kidding', 'evidemment', 'joke', 'joking',
  ].map((w) => [w, 'ironie'] as const),
  ...['apparemment', 'selon'].map((w) => [w, 'tiers'] as const),
]);
const MARK_STEMS: ReadonlyArray<[RegExp, IntentMarkKind]> = [
  [/^(?:evit|annul|supprim|desactiv|arret|cess|refus|interdi|impossib|oppos|cancel|avoid)[a-z]*$/, 'negation'],
  [/^(?:attend|patient|wait|report(?:e|es|ez|er|ons)$|differ|postpon|defer|suspend)[a-z]*$/, 'report'],
  [/^(?:except)[a-z]*$/, 'substitution'],
  [/^(?:eventuel|croi|croy|doute|hesit|reflechi|wonder)[a-z]*$/, 'hypothese'],
  [/^(?:expliqu|explain|montr|affich|display|verifi|check|consult|resum|summar|list)[a-z]*$/, 'information'],
  // Tour X3 (ceinture) : annulation, report, doute, citation, simulation, ironie.
  [
    /^(?:abandon|renon|absten|abstien|ignor|omet|omis|bloqu|empech|revoqu|rejet|rejett|declin|ecart|epargn|dispens|abort|revert|disregard|oubli)[a-z]*$/,
    'annulation',
  ],
  [/^(?:laiss(?:e|es|ez|er|ons)|gel(?:e|es|ez|er|ons))$/, 'annulation'],
  [/^(?:repouss|ulterieur|prochain)[a-z]*$/, 'report'],
  [/^(?:song|envisag|verr(?:a|ai|as|ons|ez|ont))[a-z]*$/, 'hypothese'],
  [/^(?:exempl|example|tradui|traduc|translat|reformul|rephras|repet|repeat|consigne)[a-z]*$|^quot(?:e|es|ed|ing)$/, 'citation'],
  [/^(?:simul|test|essai|pretend)[a-z]*$/, 'simulation'],
  [/^(?:plaisant|sarcas|ironi)[a-z]*$/, 'ironie'],
  // Conditionnel (« j'imputerais », « que se passerait-il », « ça donnerait », « devrait », « serait »).
  [/^[a-z]{2,}(?:rais|rait|rions|riez|raient)$/, 'hypothese'],
  [COND_OR_IMPERFECT, 'hypothese'],
];
const MARK_SEQUENCES: ReadonlyArray<[readonly string[], IntentMarkKind]> = [
  [['peut', 'etre'], 'hypothese'], [['faut', 'il'], 'hypothese'], [['dois', 'je'], 'hypothese'], [['doit', 'on'], 'hypothese'],
  [['me', 'demande'], 'hypothese'], [['se', 'demande'], 'hypothese'], [['m', 'demande'], 'hypothese'],
  [['dis', 'moi'], 'information'], [['dites', 'moi'], 'information'], [['dis', 'nous'], 'information'],
  [['tell', 'me'], 'information'], [['tell', 'us'], 'information'], [['qu', 'est', 'ce'], 'information'],
  [['est', 'ce', 'que'], 'information'], [['est', 'ce', 'qu'], 'information'],
  // Tour X3 (ceinture de la liste blanche).
  [['never', 'mind'], 'annulation'], [['scratch', 'that'], 'annulation'], [['dry', 'run'], 'simulation'],
  [['a', 'blanc'], 'simulation'], [['as', 'if'], 'simulation'], [['comme', 'si'], 'simulation'],
  [['bien', 'sur'], 'ironie'], [['yeah', 'right'], 'ironie'], [['m', 'a', 'dit'], 'citation'], [['m', 'a', 'ecrit'], 'citation'],
  [['m', 'a', 'demande'], 'tiers'], [['il', 'parait'], 'tiers'], [['d', 'apres'], 'tiers'],
];

/** Verbes de parole ou de volonté d'un TIERS (« Paul veut que… », « le DG exige… », « ma directrice demande… »). */
const THIRD_PARTY_VERBS: ReadonlySet<string> = new Set([
  'veut', 'veulent', 'souhaite', 'souhaitent', 'exige', 'exigent', 'insiste', 'insistent', 'demande', 'demandent', 'indique',
  'indiquent', 'affirme', 'affirment', 'repondu', 'wants', 'asks', 'asked', 'insists', 'requests', 'requested',
]);
/** Sujets qui font de ces verbes une demande de l'utilisateur lui-même (« je souhaite que », « je te demande de »). */
const SELF_SUBJECTS: ReadonlySet<string> = new Set(['je', 'j', 'tu', 'nous', 'vous', 'on', 'i', 'you', 'we']);
/** Pronoms compléments et négation sautés pour retrouver le sujet (« je le demande », « je vous demande »). */
const SUBJECT_SKIPPED: ReadonlySet<string> = new Set(['le', 'la', 'l', 'les', 'lui', 'leur', 'me', 'm', 'te', 't', 'en', 'y', 'ne', 'n']);

/** Le verbe en `k` a-t-il un sujet tiers (ou est-il un impératif de relais en tête : « demande à Paul de… ») ? */
function thirdPartySubject(words: readonly string[], k: number): boolean {
  let j = k - 1;
  while (j >= 0 && SUBJECT_SKIPPED.has(words[j] ?? '')) j--;
  if (j < 0) return true;
  return !SELF_SUBJECTS.has(words[j] ?? '');
}

function markMask(words: readonly string[]): boolean[] {
  const mask = words.map(() => false);
  for (let i = 0; i < words.length; i++) {
    for (const seq of [...MARK_NEUTRAL_IDIOMS, ...POLITE_REQUESTS]) {
      if (startsSequence(words, i, seq)) for (let k = 0; k < seq.length; k++) mask[i + k] = true;
    }
  }
  return mask;
}

/** Marque portée par le mot `k` (mots neutralisés ignorés), ou `null`. */
function markAt(words: readonly string[], ignored: readonly boolean[], k: number): IntentMarkKind | null {
  if (ignored[k]) return null;
  const w = words[k] ?? '';
  const next = words[k + 1] ?? '';
  if ((w === 'no' || w === 'n') && /^\d/.test(next)) return null; // « mail no 12 », « n°12 »
  if (w === 'no' || w === 'n') return next === '' && w === 'n' ? null : 'negation';
  if (w === 't' && EN_T_AUX.has(words[k - 1] ?? '')) return 'negation'; // don't, won't, can't…
  if (w === 'dont' && EN_DONT_NEXT.has(next)) return 'negation';
  if (w === 's' && (next === 'il' || next === 'ils')) return 'hypothese';
  if (w === 'plus' && ['tard', 'besoin', 'la', 'jamais'].includes(next)) return next === 'tard' ? 'report' : 'negation';
  // « pense à relancer » est un ordre ; « je pense que », « penses-tu » sont des doutes.
  if (/^pens(?:e|es|ez|ons|er|ait|ais)$/.test(w)) {
    const after = next === 'bien' ? (words[k + 2] ?? '') : next;
    return after === 'a' || after === 'au' || after === 'aux' ? null : 'hypothese';
  }
  if (w === 'qui' && k === 0) return 'information';
  if (THIRD_PARTY_VERBS.has(w) && thirdPartySubject(words, k)) return 'tiers';
  const direct = MARK_WORDS.get(w);
  if (direct) return direct;
  for (const [seq, kind] of MARK_SEQUENCES) {
    if (startsSequence(words, k, seq) && seq.every((_, j) => !ignored[k + j])) return kind;
  }
  for (const [re, kind] of MARK_STEMS) if (re.test(w)) return kind;
  return null;
}

/**
 * Marques de réserve d'UN texte de l'utilisateur, sur le message ENTIER (types distincts, dans l'ordre). Vide = le
 * message est un ordre « net ». Voir l'en-tête du fichier pour la liste complète et les idiomes neutres.
 */
export function intentMarks(text: string): IntentMarkKind[] {
  const out: IntentMarkKind[] = [];
  const add = (k: IntentMarkKind): void => {
    if (!out.includes(k)) out.push(k);
  };
  for (const s of userSentences(typeof text === 'string' ? text : '')) {
    const words = s.norm.split(' ').filter(Boolean);
    const ignored = markMask(words);
    if (s.question && !POLITE_REQUEST_RE.test(s.norm)) add('question');
    // Citation : guillemets autour d'un ordre (« impute… », "assign…") ; ironie : « /s ».
    if (/[«»"“”]/.test(s.folded)) add('citation');
    if (/(?:^|\s)\/s(?![a-z0-9])/.test(s.folded)) add('ironie');
    for (let k = 0; k < words.length; k++) {
      const kind = markAt(words, ignored, k);
      if (kind) add(kind);
    }
  }
  return out;
}

/** Le texte porte-t-il au moins une marque de réserve ? */
export function hasIntentMark(text: string): boolean {
  return intentMarks(text).length > 0;
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
 * Index du choix que le texte (déjà normalisé) désigne EXACTEMENT, ou `null` : libellé complet (casse, accents et
 * ponctuation ignorés), numéro de choix (« 1 », « le 2 », « n°1 », « choix 2 »), ou — si `names` — un nom proposé
 * (segment du libellé « Nom — Groupe » ou mot du nom) porté par UN SEUL choix.
 */
export function designatedChoiceIndex(norm: string, choices: readonly string[], opts: { names: boolean }): number | null {
  if (!norm) return null;
  const labels = choices.map((c) => normalizeWords(c, 400));
  const exact = labels.flatMap((l, i) => (l === norm ? [i] : []));
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1) return null;
  const num = /^(?:(?:le|la|l|choix|option|numero|num|n|no|number)\s+)?(\d{1,2})$/.exec(norm);
  if (num) {
    const n = Number(num[1]);
    return n >= 1 && n <= choices.length ? n - 1 : null;
  }
  if (!opts.names) return null;
  const hits = choices.flatMap((c, i) => (labelDesignators(c).includes(norm) ? [i] : []));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/**
 * Réponse à une question SANS choix : seulement une VALEUR (délai « 3 jours », numéro de courrier « courrier 4321 »,
 * nombre seul, type « pour suivi »), rien d'autre dans le message.
 */
function isAnswerValue(norm: string): boolean {
  if (!norm) return false;
  if (/^(?:(?:le|du|au)\s+)?(?:courrier|mail|lettre|letter)?\s*(?:n|no|numero|num|number)?\s*\d{1,10}$/.test(norm)) return true;
  const delay = new RegExp(
    `^(?:(?:sous|dans|en|d ici|within|in|under|delai de|delai|de)\\s+)?(?:${NUM}\\s*(?:${DAY_UNIT}|${WEEK_UNIT}|${MONTH_UNIT})|demain|apres demain|tomorrow)$`,
  );
  if (delay.test(norm)) return true;
  return TYPE_ALIASES.some((a) => a.strong && a.phrase === norm);
}

/**
 * Le message courant RÉPOND-il à la question marquée `assistantContent` ? Il ne doit porter AUCUNE marque de réserve
 * (`intentMarks`) ni annuler, et : question AVEC choix -> désigner exactement un choix (libellé, numéro ou nom proposé ;
 * libellé ou numéro seulement pour la question de confirmation d'intention) ; question SANS choix -> n'être qu'une
 * valeur (`isAnswerValue`). « non », « plus tard », « attends », « je réfléchis », « tant pis »… ne répondent pas.
 */
export function answersClarification(current: string, assistantContent: string): boolean {
  if (typeof current !== 'string' || typeof assistantContent !== 'string') return false;
  if (hasIntentMark(current) || isCancellation(current)) return false;
  const norm = normalizeWords(current);
  const parsed = parseClarificationContent(assistantContent);
  // Question de confirmation d'intention construite par le CODE (jamais une question du modèle qui l'imiterait).
  const confirmation = parseIntentConfirmation(assistantContent) !== null;
  // « oui » / « yes » SEULS (tour X3) : choix 1 de la question de confirmation d'intention UNIQUEMENT ; pour toute
  // autre question de précision, ils ne désignent rien (même si un choix du modèle s'intitule « Oui »).
  if (BARE_YES.test(norm)) return confirmation;
  if (parsed) return designatedChoiceIndex(norm, parsed.choices, { names: !confirmation }) !== null;
  return isClarificationContent(assistantContent) && isAnswerValue(norm);
}

/** « oui » ou « yes » SEUL (casse, accents, ponctuation finale tolérés ; aucun autre mot). */
const BARE_YES = /^(?:oui|yes)$/;

/**
 * Réponse à la question de CONFIRMATION D'INTENTION : `yes` = libellé exact « Oui, prépare cette action », « 1 », ou
 * « oui » / « yes » SEUL (tour X3), sans aucune marque ; `no` = libellé « Non, ne fais rien », « 2 », ou toute
 * annulation (« non », « no » seuls compris) ; `null` sinon (autre demande : « oui mais plus tard », « oui, à la DRH »).
 * À n'appeler que si le dernier message de l'assistant EST une question de confirmation d'intention.
 */
export function confirmationAnswer(current: string): 'yes' | 'no' | null {
  if (typeof current !== 'string') return null;
  const norm = normalizeWords(current);
  if (BARE_YES.test(norm)) return hasIntentMark(current) ? null : 'yes';
  const choices = [INTENT_CONFIRM_YES, INTENT_CONFIRM_NO];
  const idx = designatedChoiceIndex(norm, choices, { names: false });
  if (idx === 0) return hasIntentMark(current) ? null : 'yes';
  if (idx === 1 || isCancellation(current)) return 'no';
  return null;
}

/**
 * Messages PRÉCÉDENTS de l'utilisateur qui portent encore l'intention (ordre chronologique). Règle : seul le message
 * COURANT établit l'intention, SAUF s'il RÉPOND à la question de précision marquée qui le précède
 * (`answersClarification` : choix désigné exactement, ou valeur pour une question sans choix, et AUCUNE marque) ; le
 * message utilisateur qui a provoqué la question compte alors (et ainsi de suite pour une chaîne de questions, bornée,
 * chaque maillon devant lui-même répondre à la question qui le précède). Dans tous les autres cas (annulation,
 * réponse dilatoire, autre demande), rien n'est repris.
 */
export function intentHistory(
  history: ReadonlyArray<{ role: AsstMessageRole; content: string }>,
  current: string,
): string[] {
  if (isCancellation(current)) return [];
  const chain: string[] = [];
  let i = history.length - 1;
  let answer = current;
  for (let round = 0; round < INTENT_HISTORY_MAX_ROUNDS; round++) {
    const asked = history[i];
    const said = history[i - 1];
    if (!asked || asked.role !== AsstMessageRole.Assistant || typeof asked.content !== 'string') break;
    if (!isClarificationContent(asked.content) || !answersClarification(answer, asked.content)) break;
    if (!said || said.role !== AsstMessageRole.User || typeof said.content !== 'string') break;
    chain.unshift(said.content);
    answer = said.content;
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

// ---------------------------------------------------------------------------
// Forme d'ORDRE SIMPLE : LISTE BLANCHE (table des règles en tête de fichier)
// ---------------------------------------------------------------------------

/**
 * Désignations CONNUES admises dans la queue d'un ordre simple, fournies par l'appelant (validateur) à partir des
 * DONNÉES de référence renvoyées par les outils de lecture, jamais d'un texte du modèle : libellés, rôles et unités
 * des acteurs renvoyés, acteurs des imputations vues, espaces, modèles et types retenus, références de courrier.
 * Libellés bruts, normalisés ici (`labelDesignators`).
 */
export interface DirectFormLexicon {
  readonly labels: readonly string[];
}

export const EMPTY_DIRECT_FORM_LEXICON: DirectFormLexicon = { labels: [] };

/**
 * Verdict de forme. `reason` décrit le rejet (« mot inconnu « lol » », « structure : … ») pour le DIAGNOSTIC des tests
 * seulement : il cite le texte de l'utilisateur, il n'est donc JAMAIS journalisé ni montré à l'utilisateur.
 */
export type DirectFormVerdict = { direct: true } | { direct: false; reason: string };

type HeadFamily =
  | 'imputation'
  | 'envoi'
  | 'relance'
  | 'brouillon'
  | 'reponse'
  | 'faire'
  | 'nom-imputation'
  | 'nom-relance'
  | 'nom-brouillon';

interface FormHead {
  family: HeadFamily;
  word: string;
  len: number;
}

type FormMode = 'libre' | 'infinitif' | 'conjugue' | 'passif';

const HEAD_IMPUTATION =
  /^(?:imput(?:e|es|ez|er|ons)|affect(?:e|es|ez|er|ons)|attribu(?:e|es|ez|er|ons)|assign(?:e|es|ez|er|ons|s)?|transmet(?:s|tez|tre|tons)?|confi(?:e|es|ez|er|ons)|donn(?:e|es|ez|er|ons)|met(?:s|tez|tre|tons)|allou(?:e|es|ez|er|ons)|dispatch(?:e|es|ez|er)?|dirig(?:e|es|ez|er|eons)|pass(?:e|es|ez|er|ons)?|forwards?|give|route|share|allocate|hand)$/;
const HEAD_ENVOI = /^(?:envoi(?:e|es)|envoy(?:ez|er|ons)|send)$/;
const HEAD_RELANCE =
  /^(?:relanc(?:e|es|ez|er|ons)|rappel(?:le|les|lez|er|ons)|press(?:e|es|ez|er|ons)|pouss(?:e|es|ez|er|ons)|remind|chase|nudge)$/;
const HEAD_BROUILLON =
  /^(?:prepar(?:e|es|ez|er|ons)|redig(?:e|es|ez|er)|redigeons|ecri(?:s|vez|re|vons)|gener(?:e|es|ez|er|ons)|cre(?:e|es|ez|er|ons)|prepare|draft|write|create|generate|compose)$/;
const HEAD_REPONSE = /^(?:repond(?:s|ez|re|ons)|reply|respond|answer)$/;
const HEAD_FAIRE = /^(?:fais|faites|faire)$/;
/** Noms d'action admis EN TÊTE (« Imputation à Awa, pour suivi », « Relance d'Awa », « Brouillon de réponse »). */
const HEAD_NOMINAL: ReadonlyArray<readonly [RegExp, HeadFamily]> = [
  [/^(?:imputation|affectation|attribution|assignation|transmission)$/, 'nom-imputation'],
  [/^relance$/, 'nom-relance'],
  [/^(?:brouillon|projet)$/, 'nom-brouillon'],
];
/** Participe d'un passif voulu (« ce courrier doit être imputé », « je veux que ce courrier soit transmis »). */
const HEAD_PARTICIPLE =
  /^(?:(?:impute|affecte|attribue|assigne|confie|envoye|relance|dispatche|alloue)(?:e|s|es)?|transmise?s?)$/;

/** « l'imputé », « les imputés » : la personne imputée, admise seulement après un déterminant. */
const NOUN_ASSIGNEE = /^(?:impute|imputee|imputes|imputees)$/;
const ASSIGNEE_DETERMINERS: ReadonlySet<string> = new Set(['l', 'le', 'la', 'les', 'chaque', 'son', 'sa', 'ses', 'leur', 'leurs', 'cet', 'cette', 'ce', 'ces']);
/** Noms d'action : admis dans la queue seulement en objet du bon verbe (« relance l'imputation », « fais une relance »). */
const NOUN_IMPUTATION = /^(?:imputations?|affectations?|attributions?|assignments?|assignations?|transmissions?)$/;
const NOUN_RELANCE = /^(?:relances?|rappels?|reminders?)$/;
const NOUN_BROUILLON = /^(?:brouillons?|reponses?|projets?|drafts?|repl(?:y|ies)|responses?|answers?)$/;
const NOUNS_AFTER: Record<HeadFamily, readonly RegExp[]> = {
  imputation: [],
  envoi: [NOUN_RELANCE],
  relance: [NOUN_IMPUTATION],
  brouillon: [NOUN_BROUILLON],
  reponse: [NOUN_BROUILLON],
  faire: [NOUN_IMPUTATION, NOUN_RELANCE, NOUN_BROUILLON],
  'nom-imputation': [],
  'nom-relance': [],
  'nom-brouillon': [NOUN_BROUILLON],
};

/** Interjections admises en tête d'un segment, avant la formule et le verbe. */
const FORM_INTERJECTIONS: readonly (readonly string[])[] = [
  ['bonjour'], ['bonsoir'], ['salut'], ['hello'], ['hi'], ['please'], ['svp'], ['stp'], ['s', 'il', 'te', 'plait'],
  ['s', 'il', 'vous', 'plait'], ['vite'], ['allez', 'y'], ['allez'], ['vas', 'y'], ['ok'], ['okay'], ['aussi'],
  ['egalement'], ['also'],
];

const PREFIXES_INFINITIVE: readonly (readonly string[])[] = [
  ['peux', 'tu'], ['pouvez', 'vous'], ['pourrais', 'tu'], ['pourriez', 'vous'], ['tu', 'peux'], ['vous', 'pouvez'],
  ['merci', 'de'], ['merci', 'd'], ['pense', 'a'], ['pensez', 'a'], ['n', 'oublie', 'pas', 'de'], ['n', 'oublie', 'pas', 'd'],
  ['n', 'oubliez', 'pas', 'de'], ['n', 'oubliez', 'pas', 'd'], ['ne', 'pas', 'oublier', 'de'], ['ne', 'pas', 'oublier', 'd'],
  ['n', 'hesite', 'pas', 'a'], ['n', 'hesitez', 'pas', 'a'], ['veuillez'], ['il', 'faut'], ['je', 'veux'], ['je', 'souhaite'],
  ['j', 'ai', 'besoin', 'de'], ['j', 'ai', 'besoin', 'd'], ['commence', 'par'], ['commencez', 'par'], ['aide', 'moi', 'a'],
  ['aidez', 'moi', 'a'], ['je', 'te', 'demande', 'de'], ['je', 'te', 'demande', 'd'], ['je', 'vous', 'demande', 'de'],
  ['je', 'vous', 'demande', 'd'], ['can', 'you'], ['could', 'you'], ['i', 'need', 'you', 'to'], ['i', 'want', 'you', 'to'],
  ['go', 'ahead', 'and'],
];
const PREFIXES_CONJUGATED: readonly (readonly string[])[] = [
  ['il', 'faut', 'que', 'tu'], ['il', 'faut', 'que', 'vous'], ['j', 'ai', 'besoin', 'que', 'tu'],
  ['j', 'ai', 'besoin', 'que', 'vous'], ['je', 'veux', 'que', 'tu'], ['je', 'veux', 'que', 'vous'],
  ['je', 'souhaite', 'que', 'tu'], ['je', 'souhaite', 'que', 'vous'], ['tu'], ['vous'], ['on'],
];
/** Formules de demande avant le verbe d'ordre (au plus une), suivies d'un infinitif ou d'une forme conjuguée. */
const FORM_PREFIXES: ReadonlyArray<readonly [readonly string[], FormMode]> = [
  ...PREFIXES_INFINITIVE.map((s) => [s, 'infinitif'] as const),
  ...PREFIXES_CONJUGATED.map((s) => [s, 'conjugue'] as const),
];
/** Pronoms compléments entre la formule et le verbe (« peux-tu l'imputer », « peux-tu me préparer »). */
const FORM_CLITICS: ReadonlySet<string> = new Set(['le', 'la', 'l', 'les', 'lui', 'leur', 'me', 'm']);
const PASSIVE_INTROS: readonly (readonly string[])[] = [
  ['je', 'veux', 'que'], ['je', 'souhaite', 'que'], ['il', 'faut', 'que'], ['j', 'ai', 'besoin', 'que'], [],
];

/** Segments entiers de clôture ou d'insistance, admis partout. */
const FORM_CLOSING =
  /^(?:merci(?: beaucoup| bien| d avance)?|svp|stp|please|thanks?(?: you)?(?: very much)?|thx|bonjour|bonsoir|salut|hello|hi|ok|okay|d accord|vite|allez(?: y)?|vas y|go ahead|s il te plait|s il vous plait|fais le|faites le|do it|(?:c est )?(?:tres |assez )?urgent|des que possible|au plus vite|au plus tot|asap|pas de soucis?|sans tarder|c est la (?:deuxieme|troisieme|seconde|2e|3e|enieme|nieme) fois que je (?:le |te le |vous le )?(?:demande|redemande))$/;

/** Mots admis dans la queue d'un ordre (voir la table en tête de fichier). */
const FORM_TAIL_WORDS: ReadonlySet<string> = new Set([
  // Déterminants, pronoms, connecteurs.
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'au', 'aux', 'a', 'ce', 'cet', 'cette', 'ces', 'ci', 'mon', 'ma',
  'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leur', 'leurs', 'lui', 'elle', 'elles', 'eux',
  'y', 'en', 'pour', 'avec', 'et', 'vers', 'chez', 'sur', 'dans', 'sous', 'par', 'concernant', 'tout', 'toute', 'tous',
  'toutes',
  'the', 'an', 'this', 'these', 'that', 'those', 'it', 'them', 'my', 'his', 'her', 'our', 'your', 'their', 'its', 'him', 'to',
  'for', 'with', 'in', 'within', 'under', 'about', 'on', 'of', 'and', 'regarding', 'over', 'up',
  // Domaine.
  'courrier', 'courriers', 'mail', 'mails', 'email', 'emails', 'lettre', 'lettres', 'letter', 'letters', 'dossier', 'dossiers',
  'numero', 'num', 'n', 'no', 'number', 'ref', 'reference', 'retard', 'retards', 'late', 'overdue', 'delai', 'delais',
  'traitement', 'information', 'info', 'avis', 'action', 'signature', 'validation', 'suivi', 'copie', 'copy', 'cc', 'visa',
  'follow', 'direction', 'directeur', 'directrice', 'generale', 'general', 'dg', 'service', 'services', 'bureau', 'charge',
  'titre', 'espace', 'space', 'modele', 'template', 'urgent', 'urgente', 'urgence', 'prioritaire', 'destinataire',
  'destinataires', 'acteur', 'acteurs', 'assignee', 'assignees',
  // Qualificatifs d'une réponse (consigne de rédaction, sans effet sur les autres actions).
  'polie', 'poli', 'courte', 'court', 'breve', 'bref', 'simple', 'formelle', 'formel', 'courtoise', 'courtois', 'polite',
  'short', 'brief', 'formal',
  // Adverbes et politesse.
  'maintenant', 'immediatement', 'directement', 'rapidement', 'vite', 'aussi', 'egalement', 'now', 'immediately', 'also',
  'too', 'asap', 'merci', 'svp', 'stp', 'please', 'thanks', 'beaucoup',
]);
/** Expressions admises dans la queue (en plus des alias de types et des désignations connues). */
const FORM_TAIL_PHRASES: readonly string[] = [
  's il te plait', 's il vous plait', 'tout de suite', 'right away', 'right now', 'sans tarder', 'sans delai', 'au plus vite',
  'au plus tot', 'des que possible', 'a titre d information', 'a titre d info', 'a titre informatif', 'ne pas oublier',
  'n oublie pas', 'n oubliez pas', 'd ici', 'en charge', 'en retard', 'follow up', 'pour demain', 'd ici demain',
  'pour apres demain', 'by tomorrow', 'a traiter', 'aujourd hui', 'merci beaucoup', 'thank you',
];

const FORM_DAY_UNITS: ReadonlySet<string> = new Set([
  'jours', 'jour', 'jrs', 'jr', 'j', 'days', 'day', 'semaines', 'semaine', 'sem', 'weeks', 'week', 'wk', 'mois', 'months', 'month',
]);
const FORM_HOUR_UNITS: ReadonlySet<string> = new Set(['heures', 'heure', 'h', 'hours', 'hour', 'hrs', 'hr']);
const FORM_DELAY_PREPS: ReadonlySet<string> = new Set(['sous', 'dans', 'en', 'ici', 'within', 'in', 'under', 'delai', 'delais']);
const FORM_HOUR_PREPS: ReadonlySet<string> = new Set(['sous', 'en', 'within', 'under']);
const FORM_MAIL_NUMBER_BEFORE: ReadonlySet<string> = new Set([
  'courrier', 'courriers', 'mail', 'mails', 'lettre', 'lettres', 'letter', 'letters', 'email', 'n', 'no', 'numero', 'num',
  'number', 'ref', 'reference', 'imputation',
]);
/** « et », « puis », « mais »… suivis d'un verbe d'ordre : nouvel ordre (« impute à la DAF et relance Awa »). */
const FORM_ORDER_SPLITTERS: ReadonlySet<string> = new Set(['et', 'and', 'puis', 'ensuite', 'then', 'mais', 'but']);

let formStaticPhrases: string[][] | null = null;

function staticFormPhrases(): string[][] {
  formStaticPhrases ??= [...FORM_TAIL_PHRASES, ...TYPE_ALIASES.map((a) => a.phrase)].map((p) => p.split(' '));
  return formStaticPhrases;
}

/** Phrases connues (désignations du lexique + expressions de la queue), en mots, les plus longues d'abord. */
function formPhrases(lexicon: DirectFormLexicon): string[][] {
  const set = new Set<string>();
  const labels: readonly unknown[] = Array.isArray(lexicon.labels) ? lexicon.labels : [];
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    // Un libellé est une DONNÉE (un nom d'acteur peut être piégé) : un désignateur qui porte une marque de réserve ou
    // un verbe d'ordre n'élargit jamais la liste blanche ; un segment fait de chiffres seuls non plus (les nombres
    // suivent leurs propres règles de contexte).
    for (const d of labelDesignators(label)) {
      if (!/^[\d ]+$/.test(d) && !hasIntentMark(d) && !d.split(' ').some(isHeadVerbWord)) set.add(d);
    }
  }
  const dynamic = [...set].map((p) => p.split(' ').filter(Boolean));
  return [...staticFormPhrases(), ...dynamic].filter((p) => p.length > 0).sort((x, y) => y.length - x.length);
}

function phraseLength(words: readonly string[], i: number, phrases: readonly (readonly string[])[]): number {
  for (const p of phrases) if (startsSequence(words, i, p)) return p.length;
  return 0;
}

function seqLength(words: readonly string[], i: number, seqs: readonly (readonly string[])[]): number {
  let best = 0;
  for (const s of seqs) if (s.length > best && startsSequence(words, i, s)) best = s.length;
  return best;
}

function isHeadVerbWord(w: string): boolean {
  return (
    HEAD_IMPUTATION.test(w) ||
    HEAD_ENVOI.test(w) ||
    HEAD_RELANCE.test(w) ||
    HEAD_BROUILLON.test(w) ||
    HEAD_REPONSE.test(w) ||
    HEAD_FAIRE.test(w) ||
    HEAD_PARTICIPLE.test(w) ||
    ORDER_INFINITIVE.test(w)
  );
}

/** Verbe d'ordre (ou nom d'action en tête, en mode libre) au mot `i`. */
function headAt(words: readonly string[], i: number, mode: FormMode): FormHead | null {
  const w = words[i];
  if (!w) return null;
  if (mode === 'passif') {
    if (!HEAD_PARTICIPLE.test(w)) return null;
    return { family: /^relance/.test(w) ? 'relance' : 'imputation', word: w, len: 1 };
  }
  if (HEAD_FAIRE.test(w) && words[i + 1] === 'passer') return { family: 'imputation', word: 'passer', len: 2 };
  if (w === 'follow' && words[i + 1] === 'up') return { family: 'relance', word: w, len: 2 };
  if (HEAD_ENVOI.test(w)) return { family: 'envoi', word: w, len: 1 };
  if (HEAD_IMPUTATION.test(w)) return { family: 'imputation', word: w, len: 1 };
  if (HEAD_RELANCE.test(w)) return { family: 'relance', word: w, len: 1 };
  if (HEAD_BROUILLON.test(w)) return { family: 'brouillon', word: w, len: 1 };
  if (HEAD_REPONSE.test(w)) return { family: 'reponse', word: w, len: 1 };
  if (HEAD_FAIRE.test(w)) return { family: 'faire', word: w, len: 1 };
  if (mode === 'libre') {
    for (const [re, family] of HEAD_NOMINAL) if (re.test(w)) return { family, word: w, len: 1 };
  }
  return null;
}

/** Longueur du nombre au mot `i` (chiffres, « 3j », « 48h », nombre en lettres, « dix sept »), 0 sinon. */
function numberLength(words: readonly string[], i: number): number {
  const w = words[i] ?? '';
  if (/^\d{1,10}$/.test(w) || /^\d{1,4}(?:j|jr|jrs|h|d)$/.test(w)) return 1;
  if (NUMBER_WORDS[w] === undefined) return 0;
  return NUMBER_WORDS[`${w} ${words[i + 1] ?? ''}`] !== undefined ? 2 : 1;
}

/** Longueur consommée par un nombre EN CONTEXTE (numéro de courrier, délai), 0 s'il est hors contexte. */
function numberUse(words: readonly string[], i: number, n: number): number {
  const w = words[i] ?? '';
  if (/^\d+$/.test(w) && FORM_MAIL_NUMBER_BEFORE.has(words[i - 1] ?? '')) return n;
  const fused = /^\d{1,4}(j|jr|jrs|h|d)$/.exec(w);
  let unit = 0;
  let hours = false;
  if (fused) {
    hours = fused[1] === 'h';
  } else {
    const u = words[i + n] ?? '';
    if (FORM_DAY_UNITS.has(u)) unit = 1;
    else if (FORM_HOUR_UNITS.has(u)) {
      unit = 1;
      hours = true;
    } else return 0;
  }
  for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
    const p = words[k] ?? '';
    if (hours ? FORM_HOUR_PREPS.has(p) : FORM_DELAY_PREPS.has(p)) return n + unit;
  }
  return 0;
}

/** Contrôle de la queue `words[from..]` : `null` si tous les mots sont connus, sinon la raison du rejet. */
function formTailRejection(
  words: readonly string[],
  from: number,
  head: FormHead | null,
  phrases: readonly (readonly string[])[],
): string | null {
  const nouns = head ? NOUNS_AFTER[head.family] : [];
  const dative =
    head !== null &&
    (head.family === 'brouillon' || head.family === 'faire' || (head.family === 'imputation' && /^imput/.test(head.word)));
  for (let i = from; i < words.length; ) {
    const w = words[i] ?? '';
    if (i === from && dative && (w === 'moi' || w === 'me')) {
      i++;
      continue;
    }
    const p = phraseLength(words, i, phrases);
    if (p > 0) {
      i += p;
      continue;
    }
    const n = numberLength(words, i);
    if (n > 0) {
      const used = numberUse(words, i, n);
      if (used > 0) {
        i += used;
        continue;
      }
      if (w === 'un' || w === 'une') {
        i++;
        continue;
      }
      return `nombre hors contexte « ${w} »`;
    }
    const assignee = NOUN_ASSIGNEE.test(w) && i > from && ASSIGNEE_DETERMINERS.has(words[i - 1] ?? '');
    if (assignee || nouns.some((re) => re.test(w)) || FORM_TAIL_WORDS.has(w)) {
      i++;
      continue;
    }
    if (isHeadVerbWord(w) || NOUN_IMPUTATION.test(w) || NOUN_RELANCE.test(w) || NOUN_BROUILLON.test(w)) {
      return `verbe ou nom d'action hors de la tête « ${w} »`;
    }
    return `mot inconnu « ${w} »`;
  }
  return null;
}

/** Passif voulu au mot `i` (« je veux que ce courrier soit », « ce courrier n°12 doit être ») : longueur, 0 sinon. */
function passiveLength(words: readonly string[], i: number): number {
  for (const intro of PASSIVE_INTROS) {
    if (!startsSequence(words, i, intro)) continue;
    let k = i + intro.length;
    if (!['ce', 'cet', 'cette', 'le', 'la'].includes(words[k] ?? '')) continue;
    k++;
    if (!['courrier', 'mail', 'lettre', 'dossier'].includes(words[k] ?? '')) continue;
    k++;
    if (['n', 'no', 'numero', 'num'].includes(words[k] ?? '') && /^\d+$/.test(words[k + 1] ?? '')) k += 2;
    else if (/^\d+$/.test(words[k] ?? '')) k++;
    if (intro.length > 0 && words[k] === 'soit') return k + 1 - i;
    if (intro.length === 0 && words[k] === 'doit' && words[k + 1] === 'etre') return k + 2 - i;
  }
  return 0;
}

/**
 * Segment d'ORDRE : interjections, formule (au plus une), pronoms, verbe d'ordre en tête, queue connue. `true` si
 * c'est un ordre simple ; une raison si une formule ou une tête est là mais la suite est refusée ; `null` sans tête.
 */
function formOrderClause(words: readonly string[], phrases: readonly (readonly string[])[]): true | string | null {
  let i = 0;
  for (let n = seqLength(words, i, FORM_INTERJECTIONS); n > 0; n = seqLength(words, i, FORM_INTERJECTIONS)) i += n;
  let mode: FormMode = 'libre';
  const passive = passiveLength(words, i);
  if (passive > 0) {
    i += passive;
    mode = 'passif';
  } else {
    let best = 0;
    for (const [seq, m] of FORM_PREFIXES) {
      if (seq.length > best && startsSequence(words, i, seq)) {
        best = seq.length;
        mode = m;
      }
    }
    i += best;
    for (let c = 0; c < 2 && best > 0 && FORM_CLITICS.has(words[i] ?? ''); c++) i++;
  }
  const head = headAt(words, i, mode);
  if (!head) return mode === 'libre' ? null : "structure : formule de demande sans verbe d'ordre";
  return formTailRejection(words, i + head.len, head, phrases) ?? true;
}

/** Découpe un segment en ordres successifs (« impute à la DAF et relance Awa »). */
function splitFormOrders(words: readonly string[]): string[][] {
  const out: string[][] = [];
  let from = 0;
  for (let j = 1; j < words.length; j++) {
    if (!FORM_ORDER_SPLITTERS.has(words[j] ?? '')) continue;
    let k = j + 1;
    if (['aussi', 'egalement', 'also'].includes(words[k] ?? '')) k++;
    while (FORM_CLITICS.has(words[k] ?? '') && k < j + 4) k++;
    if (headAt(words, k, 'conjugue') === null) continue;
    out.push(words.slice(from, j));
    from = j + 1;
  }
  out.push(words.slice(from));
  return out.filter((c) => c.length > 0);
}

/** Réponse seule (texte d'historique) : numéro de choix ou valeur (délai, numéro de courrier, type fort). */
function isPureFormAnswer(norm: string): boolean {
  return /^(?:(?:le|la|l|choix|option|numero|num|n|no|number)\s+)?\d{1,2}$/.test(norm) || isAnswerValue(norm);
}

/** Analyse d'UN texte : nombre d'ordres simples (0 pour un texte sans ordre admis), ou la raison du rejet. */
function formTextAnalysis(text: string, phrases: readonly (readonly string[])[]): number | string {
  const folded = foldText(text).replace(/#\s*(?=\d)/g, ' numero ');
  if (!normalizeWords(folded)) return 'texte vide';
  if (/\.{2,}/.test(folded)) return 'structure : points de suspension';
  if (/(?:^|[^a-z0-9])\/|\/(?:$|[^a-z0-9])/.test(folded)) return 'structure : barre oblique';
  const bad = /[^a-z0-9\s',.!?;:\-—–°/]/.exec(folded);
  if (bad) return `structure : caractère « ${bad[0]} »`;
  if (isPureFormAnswer(normalizeWords(folded))) return 0;
  const kinds: Array<'ordre' | 'complement'> = [];
  for (const m of folded.matchAll(/[^.!?;\n]+[.!?;\n]*/g)) {
    const sentence = m[0];
    const sNorm = normalizeWords(sentence);
    if (!sNorm) continue;
    if (sentence.includes('?') && !POLITE_REQUEST_RE.test(sNorm)) return 'structure : question sans formule de demande';
    for (const piece of sentence.split(/[,:]|\s-\s|[—–]/)) {
      const words = normalizeWords(piece).split(' ').filter(Boolean);
      for (const clause of splitFormOrders(words)) {
        if (FORM_CLOSING.test(clause.join(' '))) continue;
        const order = formOrderClause(clause, phrases);
        if (order === true) {
          kinds.push('ordre');
          continue;
        }
        if (typeof order === 'string') return order;
        const tail = formTailRejection(clause, 0, null, phrases);
        if (tail) return tail;
        kinds.push('complement');
      }
    }
  }
  const first = kinds.indexOf('ordre');
  if (first < 0) return 0;
  if (kinds.slice(0, first).includes('complement')) return "structure : complément avant l'ordre";
  return kinds.filter((k) => k === 'ordre').length;
}

/**
 * Les textes retenus (message courant, puis réponses de la chaîne de précision) ont-ils la FORME d'un ordre simple ?
 * Chaque texte doit être fait d'ordres simples, de segments de clôture et de compléments connus (un texte sans ordre
 * n'est admis que comme réponse) ; au moins un ordre simple au total. Sinon : jamais de proposition directe (question
 * de confirmation). Pure, sans accès aux données : les désignations connues viennent de `lexicon`.
 */
export function directForm(
  texts: readonly string[],
  lexicon: DirectFormLexicon = EMPTY_DIRECT_FORM_LEXICON,
): DirectFormVerdict {
  const phrases = formPhrases(lexicon);
  let orders = 0;
  const list: readonly unknown[] = Array.isArray(texts) ? texts : [];
  for (const t of list) {
    const r = formTextAnalysis(typeof t === 'string' ? t : '', phrases);
    if (typeof r === 'string') return { direct: false, reason: r };
    orders += r;
  }
  return orders > 0 ? { direct: true } : { direct: false, reason: 'aucun ordre simple' };
}
