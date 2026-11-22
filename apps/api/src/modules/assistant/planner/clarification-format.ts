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
 * numérotée de 2 à 6 choix valides jusqu'à la fin du texte).
 */
export function parseClarificationContent(content: string): AsstClarificationDto | null {
  if (typeof content !== 'string' || !content.startsWith(MARKER_CHOICES)) return null;
  const body = content.slice(MARKER_CHOICES.length);
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
