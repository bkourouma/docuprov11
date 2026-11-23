import { asstClarificationSchema, type AsstClarificationDto } from '@archivage/types';

// Format d'une question de précision dans `content` d'un message assistant (aucune table ne stocke `clarification` :
// elle est relue depuis ce texte par `parseClarificationContent`, côté conversations et côté planificateur).
//
// MARQUAGE VÉRIFIABLE (durcissement) : la seule forme « question, ligne vide, 1. choix, 2. choix… » ne suffit plus,
// car un texte libre du modèle (`answer`) peut l'imiter et faire apparaître des boutons au rechargement. Le contenu
// d'une vraie question de précision COMMENCE par un marqueur de 4 caractères invisibles (U+2061 à U+2064 : « application
// de fonction », « fois », « séparateur », « plus » invisibles), écrit SEULEMENT par `formatClarificationContent` (et
// `formatClarificationQuestion` pour une question sans choix). Pourquoi c'est infalsifiable :
//  - tout texte du modèle passe par `sanitizeText` (`planner-turn.ts`), qui RETIRE U+2060 à U+2064 ;
//  - le planificateur retire en plus explicitement ces caractères de TOUTE réponse qui n'est pas une question de
//    précision qu'il a lui-même construite (`stripClarificationMarker`) : réponse libre, repli, avertissement,
//    proposition ;
//  - les deux formateurs retirent ces caractères des textes qu'ils reçoivent (question, choix) : un seul marqueur, en
//    tête, jamais ailleurs ;
//  - les messages de l'UTILISATEUR ne sont jamais relus comme questions de précision (rôle vérifié par l'appelant).
// Affichage : ces caractères sont « ignorables par défaut » (rendus sans largeur) ; le texte reste lisible tel quel.
// Ils ne font pas partie des caractères signalés par la détection d'injection (`suspicion.ts`).

/** Alphabet du marqueur (aucun autre producteur que ce fichier ne peut le laisser dans une réponse). */
const MARKER_ALPHABET = /[⁡-⁤]/g;
const MARKER_ALPHABET_TEST = /[⁡-⁤]/;
/** Question de précision AVEC choix (boutons). */
const MARKER_CHOICES = '⁣⁤⁢⁣';
/** Question de précision SANS choix (aucun bouton, mais la réponse de l'utilisateur répond à cette question). */
const MARKER_QUESTION = '⁣⁤⁢⁤';

const CHOICE_LINE = /^(\d{1,2})\. (.+)$/;

/**
 * Ligne fixe ajoutée par le CODE à la fin de toute réponse libre du modèle (`answer`) et de toute question de
 * précision DU MODÈLE (`clarify`, avec ou sans choix) : rien n'est appliqué pendant la planification, quoi que dise le
 * texte. Jamais sur les messages construits par le code (questions du validateur, confirmation d'intention,
 * propositions). Réexportée par `action-claims.ts`.
 */
export const PLANNER_MSG_INFO_ONLY = "Information seulement : aucune action n'a été effectuée.";
/** Suffixe exact ajouté au contenu d'une question du modèle (ligne vide puis la ligne fixe). */
export const CLARIFICATION_INFO_SUFFIX = `\n\n${PLANNER_MSG_INFO_ONLY}`;

/** Contenu sans le suffixe d'information final (une seule occurrence exacte, en toute fin), ou tel quel. */
function withoutInfoSuffix(content: string): string {
  return content.endsWith(CLARIFICATION_INFO_SUFFIX) ? content.slice(0, -CLARIFICATION_INFO_SUFFIX.length) : content;
}

/** Retire tout caractère du marqueur (à appliquer à toute réponse qui n'est pas une question construite ici). */
export function stripClarificationMarker(text: string): string {
  return typeof text === 'string' ? text.replace(MARKER_ALPHABET, '') : '';
}

/** Texte affiché (et stocké) pour une question de précision avec choix, marqué. */
export function formatClarificationContent(question: string, choices: readonly string[]): string {
  const q = stripClarificationMarker(question).trim();
  const list = choices.map((c, i) => `${i + 1}. ${stripClarificationMarker(c).trim()}`).join('\n');
  return `${MARKER_CHOICES}${q}\n\n${list}`;
}

/** Texte affiché (et stocké) pour une question de précision SANS choix, marqué (aucun bouton à la relecture). */
export function formatClarificationQuestion(question: string): string {
  return `${MARKER_QUESTION}${stripClarificationMarker(question).trim()}`;
}

/** Le contenu porte-t-il un marqueur de question de précision valide (avec ou sans choix) ? */
export function isClarificationContent(content: string): boolean {
  if (typeof content !== 'string') return false;
  if (content.startsWith(MARKER_QUESTION)) {
    const rest = content.slice(MARKER_QUESTION.length);
    return rest.trim().length > 0 && !MARKER_ALPHABET_TEST.test(rest);
  }
  return parseClarificationContent(content) !== null;
}

/**
 * Relit la question de précision AVEC choix depuis `content` ; `null` si le contenu ne commence pas par le marqueur
 * valide, contient un autre caractère du marqueur, ou n'a pas exactement le format (question, ligne vide, liste
 * numérotée de 2 à 6 choix valides jusqu'à la fin du texte). Une question DU MODÈLE se termine par la ligne fixe
 * d'information (`CLARIFICATION_INFO_SUFFIX`) : elle est retirée avant la relecture et ne devient jamais un choix.
 */
export function parseClarificationContent(content: string): AsstClarificationDto | null {
  if (typeof content !== 'string' || !content.startsWith(MARKER_CHOICES)) return null;
  const body = withoutInfoSuffix(content.slice(MARKER_CHOICES.length));
  if (MARKER_ALPHABET_TEST.test(body)) return null;
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let start = lines.length;
  while (start > 0 && CHOICE_LINE.test(lines[start - 1] ?? '')) start--;
  const choiceLines = lines.slice(start);
  if (choiceLines.length < 2 || start < 2 || (lines[start - 1] ?? '') !== '') return null;
  const choices: string[] = [];
  for (let i = 0; i < choiceLines.length; i++) {
    const m = CHOICE_LINE.exec(choiceLines[i] ?? '');
    if (!m || Number(m[1]) !== i + 1) return null;
    choices.push((m[2] ?? '').trim());
  }
  const question = lines.slice(0, start - 1).join('\n').trim();
  const parsed = asstClarificationSchema.safeParse(question ? { question, choices } : { choices });
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------------------------
// Question de CONFIRMATION D'INTENTION (principe « échec fermé par question », `intent-guards.ts`)
// ---------------------------------------------------------------------------------------------
//
// Quand le message de l'utilisateur contient un ordre MAIS aussi une marque de refus, de report, de doute,
// d'hypothèse, de demande d'information ou de substitution, le validateur ne propose rien directement : il pose
// cette question, construite par le CODE (résumé de l'action recalculé depuis les arguments validés, jamais un texte
// du modèle), avec EXACTEMENT deux choix. Le résumé contenu dans la question est relu tel quel au tour suivant
// (`parseIntentConfirmation`) : il LIE la confirmation à ce qui a été montré (le validateur refuse si le résumé
// recalculé diffère).

/** Choix « oui » de la question de confirmation d'intention (libellé exact renvoyé par le bouton). */
export const INTENT_CONFIRM_YES = 'Oui, prépare cette action';
/** Choix « non » de la question de confirmation d'intention. */
export const INTENT_CONFIRM_NO = 'Non, ne fais rien';
/** Début fixe de la question de confirmation. */
export const INTENT_CONFIRM_PREFIX = 'Voulez-vous que je prépare :';
const INTENT_CONFIRM_SUFFIX = ' ?';
/** Longueur maximale du résumé inclus dans la question (la question entière tient dans 500 caractères). */
export const INTENT_CONFIRM_SUMMARY_MAX = 500 - INTENT_CONFIRM_PREFIX.length - 1 - INTENT_CONFIRM_SUFFIX.length;

/** Forme comparable d'un texte du modèle : sans caractères invisibles ni accents, minuscules, mots séparés d'une espace. */
function imitationKey(text: string): string {
  return (typeof text === 'string' ? text : '')
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}\p{Cc}]+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const IMITATION_PREFIX = imitationKey(INTENT_CONFIRM_PREFIX);
const IMITATION_CHOICES: ReadonlySet<string> = new Set([imitationKey(INTENT_CONFIRM_YES), imitationKey(INTENT_CONFIRM_NO)]);

/**
 * Une question DU MODÈLE imite-t-elle la question de confirmation d'intention du code ? Question qui commence par
 * « Voulez-vous que je prépare » (casse, accents, espaces, ponctuation et caractères invisibles ignorés), ou un choix
 * égal, après la même normalisation, à « Oui, prépare cette action » ou « Non, ne fais rien » (option prudente : un
 * seul choix suffit). Une telle question n'est jamais montrée : réponse neutre du code à la place.
 */
export function imitatesIntentConfirmation(question: string, choices: readonly string[]): boolean {
  const q = imitationKey(question);
  if (q === IMITATION_PREFIX || q.startsWith(`${IMITATION_PREFIX} `)) return true;
  return (Array.isArray(choices) ? choices : []).some((c) => IMITATION_CHOICES.has(imitationKey(c)));
}

/** Les choix sont-ils exactement ceux d'une question de confirmation d'intention ? */
export function isIntentConfirmationChoices(choices: readonly string[]): boolean {
  return choices.length === 2 && choices[0] === INTENT_CONFIRM_YES && choices[1] === INTENT_CONFIRM_NO;
}

/**
 * Contenu marqué de la question de confirmation pour un résumé construit par le code ; `null` si le résumé est vide,
 * trop long, ou si la relecture ne redonne pas exactement ce résumé (échec fermé).
 */
export function formatIntentConfirmation(summary: string): string | null {
  const s = stripClarificationMarker(summary).trim();
  if (s.length === 0 || Array.from(s).length > INTENT_CONFIRM_SUMMARY_MAX) return null;
  const question = `${INTENT_CONFIRM_PREFIX}${s.includes('\n') ? '\n' : ' '}${s}${INTENT_CONFIRM_SUFFIX}`;
  const content = formatClarificationContent(question, [INTENT_CONFIRM_YES, INTENT_CONFIRM_NO]);
  const reread = parseIntentConfirmation(content);
  return reread !== null && reread.summary === s ? content : null;
}

/**
 * Relit une question de confirmation d'intention MARQUÉE : le résumé qu'elle montrait, ou `null`. Une question qui
 * porte la ligne d'information vient du MODÈLE (jamais du code) : ce n'est jamais une confirmation d'intention.
 */
export function parseIntentConfirmation(content: string): { summary: string } | null {
  if (typeof content !== 'string' || content.endsWith(CLARIFICATION_INFO_SUFFIX)) return null;
  const parsed = parseClarificationContent(content);
  if (!parsed || !isIntentConfirmationChoices(parsed.choices)) return null;
  const q = parsed.question ?? '';
  if (!q.startsWith(INTENT_CONFIRM_PREFIX) || !q.endsWith(INTENT_CONFIRM_SUFFIX)) return null;
  const sep = q.charAt(INTENT_CONFIRM_PREFIX.length);
  if (sep !== ' ' && sep !== '\n') return null;
  const summary = q.slice(INTENT_CONFIRM_PREFIX.length + 1, q.length - INTENT_CONFIRM_SUFFIX.length);
  if (summary.trim() !== summary || summary.length === 0) return null;
  return { summary };
}
