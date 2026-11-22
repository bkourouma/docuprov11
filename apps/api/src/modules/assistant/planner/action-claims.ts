import { sanitizeText } from '../../workflow-agents/injection/untrusted';
import { normalizeWords } from './intent-guards';

// Revendications d'ACTION dans un texte libre du modèle (réponse, question, choix).
//
// L'assistant n'applique RIEN pendant la planification : toute action est une proposition, appliquée seulement après
// la confirmation de l'utilisateur. Un texte du modèle qui affirme qu'une action est faite (« j'ai imputé… »,
// « c'est fait », « imputation effectuée », « I have assigned… », « courrier imputé à la DAF ») est donc FAUX, ou dicté
// par une injection pour faire croire à l'utilisateur qu'il n'a plus rien à vérifier : il est remplacé par une phrase
// fixe du code. Détection TOLÉRANTE (français et anglais, passé composé, passif, accents, casse, espaces, caractères
// invisibles) ; un faux positif ne coûte qu'une réponse moins riche (« Aucune action n'a été effectuée… »).

/** Phrase fixe qui remplace une réponse revendiquant une action. */
export const PLANNER_MSG_ACTION_CLAIM = "Aucune action n'a été effectuée ; une action n'est appliquée qu'après votre confirmation.";

/** Participes passés d'actions (sans accents), avec accord facultatif (« imputée », « imputés »…). */
const FR_PART =
  '(?:impute|relance|redige|cree|envoye|transmis|enregistre|supprime|affecte|attribue|assigne|applique|effectue|execute|depose|notifie|prevenu|valide|confirme|archive|modifie|programme|planifie|prepare|realise|ajoute|signe|delegue|ecrit|repondu|traite|rappele|transfere|expedie|soumis|confie|redirige)(?:e?s?)';
const FR_INF =
  '(?:imputer|relancer|rediger|creer|envoyer|transmettre|enregistrer|supprimer|affecter|attribuer|assigner|appliquer|effectuer|executer|deposer|notifier|prevenir|valider|confirmer|archiver|preparer|ecrire|repondre|traiter|rappeler|transferer|expedier|confier|deleguer)';
const EN_PART =
  '(?:assigned|forwarded|sent|reminded|drafted|created|written|wrote|saved|deleted|removed|transmitted|dispatched|applied|completed|executed|submitted|recorded|filed|notified|followed up|chased|nudged|updated|archived|allocated|handed over|replied|answered|scheduled|prepared|delegated)';
/** Noms d'action et participes d'achèvement (« imputation effectuée », « relance envoyée », « brouillon créé »). */
const FR_ACTION_NOUN =
  '(?:imputation|imputations|relance|relances|brouillon|brouillons|reponse|reponses|transmission|affectation|attribution|envoi|notification|suppression|enregistrement|action|actions|operation|operations|modification|creation|delegation)';
const FR_DONE_PART =
  '(?:effectue|fait|realise|termine|envoye|enregistre|cree|applique|execute|transmis|valide|confirme|reussi|accompli|programme|redige|depose|traite|prise en compte|pris en compte)(?:e?s?)';

/** Déterminants : « j'ai vu UNE relance » n'est pas « j'ai relancé ». */
const DETERMINERS = new Set(['un', 'une', 'des', 'la', 'le', 'les', 'l', 'du', 'de', 'd', 'ce', 'cet', 'cette', 'ces', 'son', 'sa', 'ses', 'leur', 'leurs', 'a', 'an', 'the']);

const FR_FIRST_PERSON = new RegExp(
  `\\b(?:j ai|jai|je l ai|je les ai|je lui ai|je leur ai|je vous ai|je t ai|j avais|nous avons|nous l avons|nous les avons|on a|on l a|l assistant a|l assistant l a)((?: [a-z0-9]+){0,3}?) ${FR_PART}\\b`,
  'g',
);
const FR_JUST_DID = new RegExp(
  `\\b(?:je viens|nous venons|on vient|l assistant vient) (?:de|d)(?: [a-z]+){0,2}? ${FR_INF}\\b`,
);
const DONE_PHRASES =
  /\b(?:c est fait|c est chose faite|voila qui est fait|c est regle|c est effectue|c est envoye|c est transmis|c est enregistre|done|all done|it s done|its done|that s done|task completed|completed successfully|successfully)\b/;
const FR_NOUN_DONE = new RegExp(
  `\\b${FR_ACTION_NOUN}((?: [a-z0-9]+){0,4}?) (?:(?:a ete|ont ete|est|sont|bien|deja|desormais) )*${FR_DONE_PART}\\b`,
  'g',
);
/** Mots qui font d'un constat d'achèvement une NÉGATION (« rien n'est envoyé », « aucune action n'a été faite »). */
const NEGATION_WORDS = new Set(['n', 'ne', 'pas', 'rien', 'aucun', 'aucune', 'jamais', 'not', 'never', 'no']);
/** Participes d'un passif d'action (sans « validé », « confirmé », « préparé » : souvent de simples adjectifs). */
const FR_PASSIVE_PART =
  '(?:impute|relance|redige|cree|envoye|transmis|enregistre|supprime|affecte|attribue|assigne|applique|effectue|execute|depose|notifie|archive|transfere|expedie|confie|delegue|redirige)(?:e?s?)';
const PASSIVE = new RegExp(
  `(?<!\\b(?:n|ne|not|pas) )\\b(?:a ete|ont ete|a bien ete|ont bien ete|est|sont|est bien|sont bien|vient d etre|viennent d etre|etait|has been|have been|was|were|is|are|is now|are now)(?: (?:bien|deja|desormais|maintenant|correctement|now|already|successfully))? (?:${FR_PASSIVE_PART}|${EN_PART})\\b`,
);
/** Sujet « courrier / mail … » suivi d'un participe et d'une destination (« courrier 4321 imputé à la DAF »). */
const SUBJECT_PART_TO = new RegExp(
  `\\b(?:courrier|courriers|mail|mails|lettre|lettres|dossier|dossiers|document|documents)(?: [a-z0-9]+){0,3}? ${FR_PART} (?:a|au|aux|vers|dans)\\b`,
);
const EN_FIRST_PERSON = new RegExp(
  `\\b(?:i|we|i ve|we ve|i have|we have|i just|we just|i ve just|i have just|i already|we already|the assistant has|i ve now)(?: [a-z]+){0,2}? ${EN_PART}\\b`,
);
const EN_SUBJECT_TO = /\b(?:mail|letter|it|this|request|document)(?: [a-z0-9]+){0,2}? (?:assigned|forwarded|sent|dispatched|allocated|transmitted) to\b/;

/**
 * Participe ACCENTUÉ suivi d'une destination (« imputé à la DAF », « transmise aux RH »), lu sur un texte qui garde
 * les accents : sans accent, « impute à » est un impératif.
 */
const ACCENTED_PART_TO =
  /(?<![\p{L}\p{N}])(?:imputé|relancé|transmis|affecté|attribué|assigné|envoyé|transféré|expédié|confié|redirigé|délégué)(?:e|s|es)?\s+(?:[\p{L}\p{N}']+\s+){0,3}?(?:à|au|aux|vers)(?![\p{L}\p{N}])/u;

function firstPersonClaim(norm: string): boolean {
  for (const m of norm.matchAll(FR_FIRST_PERSON)) {
    const between = (m[1] ?? '').trim().split(' ').filter(Boolean);
    const last = between[between.length - 1];
    if (last === undefined || !DETERMINERS.has(last)) return true;
  }
  return false;
}

function nounDoneClaim(norm: string): boolean {
  for (const m of norm.matchAll(FR_NOUN_DONE)) {
    const between = (m[1] ?? '').trim().split(' ').filter(Boolean);
    if (!between.some((w) => NEGATION_WORDS.has(w))) return true;
  }
  return false;
}

/** Le texte libre affirme-t-il qu'une action a été faite ? */
export function claimsActionDone(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const norm = ` ${normalizeWords(text)} `;
  if (
    firstPersonClaim(norm) ||
    FR_JUST_DID.test(norm) ||
    DONE_PHRASES.test(norm) ||
    nounDoneClaim(norm) ||
    PASSIVE.test(norm) ||
    SUBJECT_PART_TO.test(norm) ||
    EN_FIRST_PERSON.test(norm) ||
    EN_SUBJECT_TO.test(norm)
  ) {
    return true;
  }
  const accented = sanitizeText(text, 8_000)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’‛ʼ`´′]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ');
  return ACCENTED_PART_TO.test(accented);
}
