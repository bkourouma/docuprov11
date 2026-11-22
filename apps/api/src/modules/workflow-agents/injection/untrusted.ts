import { randomBytes } from 'node:crypto';

/**
 * Neutralisation du texte NON FIABLE (courrier, document, OCR, formulaire, résultat d'outil) avant son
 * insertion dans le prompt d'un agent. Ce texte est de la DONNÉE : il ne doit ni fermer un bloc, ni imiter
 * une balise, ni cacher du texte au relecteur humain.
 *
 * Adapté de `drafting/drafting-prompt.ts` (copié, jamais importé : les deux modules évoluent séparément).
 */

/** Alphabet du jeton : lettres majuscules sans I ni O (lisibles, aucun chiffre). */
export const NONCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const NONCE_LENGTH = 20;

/** Plafond de lecture AVANT normalisation (unités UTF-16) : borne le coût de NFKC sur une entrée géante. */
const PRE_CUT_FACTOR = 4;
const PRE_CUT_MARGIN = 1024;

/**
 * Jeton aléatoire (crypto) : un NOUVEAU jeton par appel au modèle. Le contenu ne peut ni le deviner ni le
 * reproduire (il en est retiré s'il y figurait).
 */
export function generateNonce(): string {
  // Échantillonnage par rejet : aucun biais modulo (256 n'est pas un multiple de 24).
  const limit = 256 - (256 % NONCE_ALPHABET.length);
  let out = '';
  while (out.length < NONCE_LENGTH) {
    for (const b of randomBytes(NONCE_LENGTH * 2)) {
      if (b >= limit) continue;
      out += NONCE_ALPHABET[b % NONCE_ALPHABET.length];
      if (out.length === NONCE_LENGTH) break;
    }
  }
  return out;
}

// Caractères de contrôle (hors tabulation et saut de ligne).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Familles invisibles ou « blanches » : trait d'union conditionnel, marques et contrôles bidirectionnels,
// jointeurs et espaces de largeur nulle, remplisseurs (U+034F, U+115F/1160, U+17B4/17B5, U+3164, U+FFA0,
// braille vide U+2800), séparateurs mongols, sélecteurs de variation, caractères « tag » U+E0000-E007F
// (contrebande ASCII : texte caché mais lisible par un modèle) et annotations interlinéaires U+FFF9-FFFB.
const INVISIBLE_CHARS =
  // eslint-disable-next-line no-misleading-character-class
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
// Séparateurs de ligne/paragraphe Unicode : traités comme un saut de ligne.
const LINE_SEPARATORS = /[\u2028\u2029\u0085]/g;
// Demi-paires de substitution isolées (texte mal formé) : remplacées par U+FFFD.
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Chevrons et leurs sosies. NFKC ramène déjà les formes pleine chasse (U+FF1C/FF1E) et petites (U+FE64/FE65)
// à `<`/`>` ; les autres sosies (crochets angulaires CJK et mathématiques, « \u226A \u226B ») sont traités ici.
const OPEN_ANGLES = /[<\u2329\u27E8\u3008\uFF1C\uFE64]/g;
const CLOSE_ANGLES = /[>\u232A\u27E9\u3009\uFF1E\uFE65]/g;
const DOUBLE_OPEN_ANGLES = /[\u226A\u27EA\u300A]/g;
const DOUBLE_CLOSE_ANGLES = /[\u226B\u27EB\u300B]/g;

/** Remplacement visible du jeton s'il apparaissait dans le contenu. */
export const NONCE_PLACEHOLDER = '[jeton retiré]';

/**
 * Nettoyage commun (sans neutralisation des chevrons) : demi-paires réparées, forme NFKC (pleine chasse
 * ramenée à l'ASCII), fins de ligne unifiées, contrôles et invisibles retirés.
 */
export function sanitizeText(input: unknown, preCut?: number): string {
  let raw = typeof input === 'string' ? input : input === null || input === undefined ? '' : String(input);
  if (preCut !== undefined && raw.length > preCut) raw = raw.slice(0, preCut);
  return raw
    .replace(LONE_SURROGATES, '\uFFFD')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(LINE_SEPARATORS, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '');
}

/** Longueur en points de code (jamais en unités UTF-16). */
export function charLength(text: string): number {
  let n = 0;
  for (const _c of text) n++;
  return n;
}

/** Tronque à `max` points de code sans jamais couper une paire de substitution. */
export function truncateSafe(text: string, max: number, ellipsis = '…'): string {
  if (!Number.isFinite(max) || max <= 0) return '';
  if (text.length <= max) return text; // longueur UTF-16 >= nombre de points de code
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const room = Math.max(0, max - charLength(ellipsis));
  return chars.slice(0, room).join('') + (room < max ? ellipsis : '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Retire toute occurrence (casse ignorée) du jeton de la requête. */
export function stripNonce(text: string, nonce: string): string {
  if (!nonce) return text;
  return text.replace(new RegExp(escapeRegExp(nonce), 'gi'), NONCE_PLACEHOLDER);
}

/** Remplace chevrons ASCII, pleine chasse et sosies par `‹` / `›` : aucune balise ne peut être écrite. */
export function replaceAngles(text: string): string {
  return text
    .replace(DOUBLE_OPEN_ANGLES, '‹‹')
    .replace(DOUBLE_CLOSE_ANGLES, '››')
    .replace(OPEN_ANGLES, '‹')
    .replace(CLOSE_ANGLES, '›');
}

/**
 * Rend un texte tiers INERTE dans le prompt :
 *  - NFKC, contrôles, invisibles et marques bidirectionnelles retirés ;
 *  - aucun chevron ne subsiste (impossible d'écrire `<<FIN_DONNEES …>>`, `</data>`, `<|im_start|>`…) ;
 *  - le jeton de la requête est retiré ;
 *  - espaces de fin de ligne et lignes vides multiples réduits ;
 *  - troncature sûre à `max` points de code (avec « … »).
 */
export function neutralizeUntrusted(text: unknown, nonce: string, max: number): string {
  const preCut = Math.max(0, Math.floor(max)) * PRE_CUT_FACTOR + PRE_CUT_MARGIN;
  let out = replaceAngles(sanitizeText(text, preCut));
  out = stripNonce(out, nonce);
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return truncateSafe(out.trim(), max);
}

/** Variante sur une seule ligne (libellés, noms) : tout blanc ramené à une espace. */
export function neutralizeLine(text: unknown, nonce: string, max: number): string {
  const preCut = Math.max(0, Math.floor(max)) * PRE_CUT_FACTOR + PRE_CUT_MARGIN;
  const out = stripNonce(replaceAngles(sanitizeText(text, preCut)), nonce).replace(/\s+/g, ' ');
  return truncateSafe(out.trim(), max);
}

/** Vrai si le texte (une fois nettoyé) contient le jeton : un tiers aurait-il deviné ou reçu le jeton ? */
export function containsNonce(text: unknown, nonce: string): boolean {
  if (!nonce) return false;
  return sanitizeText(text).toUpperCase().includes(nonce.toUpperCase());
}
