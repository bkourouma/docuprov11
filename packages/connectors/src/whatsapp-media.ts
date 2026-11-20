// Lot 2c — WhatsApp Business : validation des adresses de médias et du contenu reçu.
//
// Menace : le worker télécharge, avec le jeton d'accès Meta, une URL que lui renvoie l'API Graph
// (ou une redirection). Si cette URL pouvait désigner un autre hôte, le jeton partirait chez un
// tiers et le worker deviendrait un relais vers le réseau interne. D'où une liste FIXE d'hôtes
// officiels, une correspondance stricte (jamais un simple `endsWith`) et un refus de tout ce qui
// n'est pas `https://<nom officiel>/` sur le port 443.
//
// Côté contenu : un expéditeur WhatsApp est une personne extérieure. Le nom de fichier annoncé, le
// type MIME annoncé et l'empreinte annoncée sont des données non fiables : on les assainit, on les
// recoupe avec les octets reçus (signature binaire) et on refuse au moindre doute. AUCUN contenu
// n'est exécuté, interprété ni rendu ici.
//
// Règle transverse : les messages d'erreur sont en français, génériques, et ne contiennent jamais
// l'URL (elle est signée), le jeton, le nom de fichier ni un extrait du contenu.
import { createHash } from 'node:crypto';
import { GED_CONNECTOR_ALLOWED_EXTENSIONS } from '@archivage/types';
import { extensionOf } from './limits';
import { ConnectorItemRejectedError } from './types';

// ---------------------------------------------------------------------------
// Hôtes officiels
// ---------------------------------------------------------------------------

/**
 * Hôtes officiels Meta d'où le worker accepte de télécharger un média (et auxquels il envoie le
 * jeton). Une entrée `*.x` désigne les sous-domaines STRICTS de `x` (pas `x` lui-même) ; une entrée
 * sans `*` désigne exactement cet hôte.
 *
 * Cette liste est du code, pas de la configuration : ni l'administrateur applicatif ni l'exploitant
 * ne peuvent l'élargir (aucune variable d'environnement, aucun champ de configuration). L'élargir
 * suppose une modification relue de ce fichier.
 */
export const WHATSAPP_OFFICIAL_HOST_SUFFIXES: readonly string[] = Object.freeze([
  'graph.facebook.com',
  'lookaside.fbsbx.com',
  '*.fbsbx.com',
  '*.fbcdn.net',
  '*.whatsapp.net',
  '*.whatsapp.com',
  '*.facebook.com',
]);

/** Longueur maximale acceptée pour une URL de média (les URL signées de Meta en sont très loin). */
const MAX_URL_LENGTH = 4096;
/** Label DNS : lettres/chiffres/tirets, sans tiret en tête ni en queue. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const URL_REFUSED = 'Adresse du média refusée : hôte non officiel ou forme non autorisée.';

function rejectUrl(): never {
  throw new ConnectorItemRejectedError(URL_REFUSED);
}

/** Vrai si `host` (déjà normalisé : minuscules, sans point final) est un hôte officiel Meta. */
export function isOfficialWhatsappHost(host: string): boolean {
  return WHATSAPP_OFFICIAL_HOST_SUFFIXES.some((entry) => {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // « .fbcdn.net » : le point est la frontière obligatoire
      return host.length > suffix.length && host.endsWith(suffix);
    }
    return host === entry;
  });
}

/**
 * Valide une URL de média WhatsApp et la renvoie normalisée (hôte en minuscules, sans point final,
 * sans fragment). Lève `ConnectorItemRejectedError` — message générique, sans l'URL — si :
 * schéma autre que `https:`, identifiants (`user:pass@`), port autre que 443, hôte IP littéral
 * (y compris notations décimale/octale/hexadécimale, que l'analyseur WHATWG convertit en IPv4),
 * hôte internationalisé (punycode `xn--`) ou hors de `WHATSAPP_OFFICIAL_HOST_SUFFIXES`.
 *
 * L'appelant doit ensuite utiliser l'objet `URL` RENVOYÉ, jamais la chaîne d'origine : c'est la
 * seule façon d'être sûr que l'hôte contacté est celui qui a été vérifié.
 */
export function assertOfficialMediaUrl(rawUrl: string): URL {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    rejectUrl();
  }
  // ASCII imprimable uniquement : refuse espaces, caractères de contrôle et tout caractère Unicode
  // (un hôte accentué serait converti en punycode par l'analyseur ; on ne lui en laisse pas l'occasion).
  if (/[^\x21-\x7e]/.test(rawUrl)) rejectUrl();

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    rejectUrl();
  }
  if (url.protocol !== 'https:') rejectUrl();
  if (url.username !== '' || url.password !== '') rejectUrl();
  // L'analyseur WHATWG ramène « :443 » à '' pour https : tout autre port est explicite.
  if (url.port !== '') rejectUrl();

  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) rejectUrl();
  // IPv6 littérale (entre crochets) ou IPv4 (y compris les formes exotiques déjà converties).
  if (host.startsWith('[') || host.includes(':')) rejectUrl();
  const labels = host.split('.');
  if (labels.length < 2) rejectUrl();
  if (/^(?:0x[0-9a-f]*|[0-9]+)$/.test(labels[labels.length - 1] as string)) rejectUrl();
  if (!labels.every((l) => DNS_LABEL.test(l))) rejectUrl();
  // Aucun hôte officiel n'est internationalisé : tout label punycode est un leurre potentiel.
  if (labels.some((l) => l.startsWith('xn--'))) rejectUrl();
  if (!isOfficialWhatsappHost(host)) rejectUrl();

  url.hostname = host;
  url.hash = '';
  return url;
}

// ---------------------------------------------------------------------------
// Types MIME et signatures
// ---------------------------------------------------------------------------

/** Type MIME → extensions cohérentes (la première est l'extension par défaut d'un nom généré). */
const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/jpg': ['.jpg', '.jpeg'],
  'image/pjpeg': ['.jpg', '.jpeg'],
  'image/tiff': ['.tif', '.tiff'],
  'text/plain': ['.txt', '.md', '.csv'],
  'text/csv': ['.csv'],
  'application/csv': ['.csv'],
  'text/comma-separated-values': ['.csv'],
  'text/markdown': ['.md'],
  'text/x-markdown': ['.md'],
  'text/html': ['.html', '.htm'],
  'application/rtf': ['.rtf'],
  'text/rtf': ['.rtf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  // Windows annonce souvent les CSV sous ce type : toléré, le contenu reste contrôlé comme du texte.
  'application/vnd.ms-excel': ['.xls', '.csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-powerpoint': ['.ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/vnd.oasis.opendocument.text': ['.odt'],
  'application/vnd.oasis.opendocument.spreadsheet': ['.ods'],
  'application/vnd.oasis.opendocument.presentation': ['.odp'],
  'message/rfc822': ['.eml'],
  'application/vnd.ms-outlook': ['.msg'],
});

const OCTET_STREAM = 'application/octet-stream';

const SIG_PDF = Buffer.from('%PDF-', 'latin1');
const SIG_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SIG_JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const SIG_TIFF = [
  Buffer.from([0x49, 0x49, 0x2a, 0x00]), // « II* » petit-boutiste
  Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), // « MM*» gros-boutiste
  Buffer.from([0x49, 0x49, 0x2b, 0x00]), // BigTIFF
  Buffer.from([0x4d, 0x4d, 0x00, 0x2b]),
];
const SIG_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const SIG_OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const SIG_RTF = Buffer.from('{\\rtf', 'latin1');

const startsWith = (buf: Buffer, sig: Buffer): boolean =>
  buf.length >= sig.length && buf.subarray(0, sig.length).equals(sig);

interface ContentRule {
  /** Type MIME canonique, renvoyé quand le type annoncé est absent ou générique. */
  mime: string;
  /** Signature binaire attendue en tête de fichier ; absente pour les formats texte. */
  signature?: (buf: Buffer) => boolean;
}

const zip = (mime: string): ContentRule => ({ mime, signature: (b) => startsWith(b, SIG_ZIP) });
const ole = (mime: string): ContentRule => ({ mime, signature: (b) => startsWith(b, SIG_OLE) });

/** Règle de contenu par extension. Couvre toute la liste globale `GED_CONNECTOR_ALLOWED_EXTENSIONS`. */
const CONTENT_RULES: Readonly<Record<string, ContentRule>> = Object.freeze({
  '.pdf': { mime: 'application/pdf', signature: (b) => startsWith(b, SIG_PDF) },
  '.png': { mime: 'image/png', signature: (b) => startsWith(b, SIG_PNG) },
  '.jpg': { mime: 'image/jpeg', signature: (b) => startsWith(b, SIG_JPEG) },
  '.jpeg': { mime: 'image/jpeg', signature: (b) => startsWith(b, SIG_JPEG) },
  '.tif': { mime: 'image/tiff', signature: (b) => SIG_TIFF.some((s) => startsWith(b, s)) },
  '.tiff': { mime: 'image/tiff', signature: (b) => SIG_TIFF.some((s) => startsWith(b, s)) },
  '.txt': { mime: 'text/plain' },
  '.csv': { mime: 'text/csv' },
  '.md': { mime: 'text/markdown' },
  '.html': { mime: 'text/html' },
  '.htm': { mime: 'text/html' },
  '.eml': { mime: 'message/rfc822' },
  '.rtf': { mime: 'application/rtf', signature: (b) => startsWith(b, SIG_RTF) },
  '.doc': ole('application/msword'),
  '.xls': ole('application/vnd.ms-excel'),
  '.ppt': ole('application/vnd.ms-powerpoint'),
  '.msg': ole('application/vnd.ms-outlook'),
  '.docx': zip('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  '.xlsx': zip('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  '.pptx': zip('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  '.odt': zip('application/vnd.oasis.opendocument.text'),
  '.ods': zip('application/vnd.oasis.opendocument.spreadsheet'),
  '.odp': zip('application/vnd.oasis.opendocument.presentation'),
});

const MIME_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * Type MIME normalisé (minuscules, sans paramètres). `''` si absent ; `null` si présent mais
 * syntaxiquement invalide (traité comme une incohérence par la validation).
 */
function normalizeMime(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return null;
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === '') return '';
  return MIME_TOKEN.test(base) ? base : null;
}

// ---------------------------------------------------------------------------
// Nom de fichier
// ---------------------------------------------------------------------------

/** Longueur maximale d'un nom de fichier assaini (extension comprise), en caractères. */
export const WHATSAPP_MAX_FILENAME_CHARS = 120;
const EXTENSION_TOKEN = /^[a-z0-9]{1,10}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function utcStamp(now: Date): string {
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date(0);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

/** Retire espaces et points de tête et de queue (Windows ignore les seconds, piège classique). */
function trimDotsAndSpaces(s: string): string {
  return s.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '');
}

/**
 * Nom de fichier sûr à partir du nom annoncé par l'expéditeur :
 *  - normalisation NFC ; suppression des chemins (`/`, `\` : seul le dernier segment est gardé) ;
 *  - suppression des caractères de contrôle, des caractères de mise en forme Unicode (dont les
 *    marques bidi U+200E/F, U+202A–E, U+2066–9 qui permettent d'afficher `fdp.exe` comme `exe.pdf`),
 *    des séparateurs de ligne/paragraphe, des demi-substituts isolés et de `: * ? " < > |` ;
 *  - espaces et points de tête/queue retirés ; noms réservés Windows (CON, NUL, COM1…) préfixés `_` ;
 *  - UNE seule extension (la dernière, `[a-z0-9]{1,10}`, mise en minuscules) : les points
 *    intermédiaires deviennent `_` (`a.exe.pdf` → `a_exe.pdf`) ;
 *  - extension déduite du type MIME si le nom n'en a pas ;
 *  - 120 caractères au plus, extension préservée.
 * Nom absent ou inexploitable (les photos WhatsApp n'en ont pas) : `photo-AAAAMMJJ-HHMMSS.<ext>` ou
 * `document-AAAAMMJJ-HHMMSS.<ext>` (heure UTC), extension déduite du type MIME.
 *
 * L'extension n'est PAS contrôlée ici (liste autorisée, cohérence) : c'est le rôle de
 * `validateWhatsappMedia`, qui doit toujours suivre.
 */
export function sanitizeWhatsappFileName(
  declared: string | undefined,
  opts: { mimeType?: string; messageType: 'document' | 'image'; now: Date },
): string {
  const mime = normalizeMime(opts.mimeType);
  const mimeExt = mime ? (MIME_EXTENSIONS[mime]?.[0] ?? '') : '';

  let name = typeof declared === 'string' ? declared.slice(0, 1024) : '';
  name = name.normalize('NFC');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '')
    .replace(/[:*?"<>|]/g, '')
    .replace(/\s+/gu, ' ');
  name = trimDotsAndSpaces(name);

  let stem = name;
  let ext = '';
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const candidate = name.slice(dot + 1).toLowerCase();
    if (EXTENSION_TOKEN.test(candidate)) {
      stem = name.slice(0, dot);
      ext = `.${candidate}`;
    }
  }
  // Une seule extension finale : `facture.exe.pdf` → `facture_exe.pdf`.
  stem = trimDotsAndSpaces(stem.replace(/\./g, '_'));
  if (ext === '') ext = mimeExt;

  if (stem === '') {
    const prefix = opts.messageType === 'image' ? 'photo' : 'document';
    return `${prefix}-${utcStamp(opts.now)}${mimeExt || ext}`;
  }
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;

  // Bornage en points de code (jamais au milieu d'une paire de substitution).
  const room = WHATSAPP_MAX_FILENAME_CHARS - ext.length;
  const chars = Array.from(stem);
  if (chars.length > room) stem = trimDotsAndSpaces(chars.slice(0, room).join(''));
  if (stem === '') {
    const prefix = opts.messageType === 'image' ? 'photo' : 'document';
    return `${prefix}-${utcStamp(opts.now)}${mimeExt || ext}`;
  }
  return `${stem}${ext}`;
}

// ---------------------------------------------------------------------------
// Validation du contenu
// ---------------------------------------------------------------------------

export interface WhatsappMediaValidationInput {
  bytes: Buffer;
  /** Nom DÉJÀ assaini par `sanitizeWhatsappFileName`. */
  fileName: string;
  /** Type MIME annoncé par Meta. */
  mimeType?: string;
  maxBytes: number;
  /** Extensions autorisées par la configuration ; intersectées avec la liste globale. */
  allowedExtensions: readonly string[];
  /** Empreinte SHA-256 annoncée par Meta (hexadécimal ou base64). */
  declaredSha256?: string;
}

export interface WhatsappMediaValidationResult {
  fileName: string;
  /** Extension en minuscules, point inclus. */
  extension: string;
  /** Type MIME retenu : celui annoncé s'il est précis et cohérent, sinon le type canonique de l'extension. */
  mimeType: string;
  /** SHA-256 calculé sur les octets reçus, hexadécimal minuscule. */
  sha256: string;
}

const MSG = {
  empty: 'Fichier vide : document non pris en compte.',
  tooLarge: 'Fichier trop volumineux : document non pris en compte.',
  badName: 'Nom de fichier invalide : document non pris en compte.',
  type: 'Type de fichier non pris en charge.',
  mismatch: 'Type de fichier incohérent avec son extension.',
  undetermined: 'Type de fichier indéterminé : document non pris en compte.',
  signature: 'Contenu du fichier incohérent avec son type.',
  hashUnreadable: 'Empreinte annoncée illisible : document non pris en compte.',
  hash: 'Empreinte inattendue : le fichier reçu ne correspond pas à celui annoncé.',
} as const;

/** Empreinte annoncée → 32 octets. Hexadécimal (64 caractères) ou base64 standard/URL ; sinon `null`. */
function decodeDeclaredSha256(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/]{43}=?$/.test(s) || /^[A-Za-z0-9_-]{43}=?$/.test(s)) {
    const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buf.length === 32 ? buf : null;
  }
  return null;
}

/**
 * Valide un média téléchargé AVANT toute ingestion. Lève `ConnectorItemRejectedError` (message
 * générique en français) si : taille nulle ou supérieure à `maxBytes` ; extension absente ou hors
 * de `allowedExtensions ∩ GED_CONNECTOR_ALLOWED_EXTENSIONS` ; type MIME annoncé incohérent avec
 * l'extension ; signature binaire incohérente (ou octet NUL dans un format texte) ; empreinte
 * annoncée différente de l'empreinte calculée.
 *
 * `application/octet-stream` (ou un type absent) n'est toléré que pour une extension dotée d'une
 * signature binaire vérifiable : un « texte » de type inconnu est refusé.
 *
 * Ne lit que les premiers octets (signature) et calcule l'empreinte : aucun rendu, aucune analyse.
 */
export function validateWhatsappMedia(
  input: WhatsappMediaValidationInput,
): WhatsappMediaValidationResult {
  const { bytes, fileName, maxBytes } = input;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new ConnectorItemRejectedError(MSG.empty);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || bytes.length > maxBytes) {
    throw new ConnectorItemRejectedError(MSG.tooLarge);
  }
  if (
    typeof fileName !== 'string' ||
    fileName.length === 0 ||
    fileName.length > 255 ||
    /[\\/\p{Cc}\p{Cf}]/u.test(fileName)
  ) {
    throw new ConnectorItemRejectedError(MSG.badName);
  }

  const extension = extensionOf(fileName);
  const global: readonly string[] = GED_CONNECTOR_ALLOWED_EXTENSIONS;
  const allowed = new Set(
    (Array.isArray(input.allowedExtensions) ? input.allowedExtensions : [])
      .filter((e): e is string => typeof e === 'string')
      .map((e) => e.toLowerCase())
      .filter((e) => global.includes(e)),
  );
  if (extension === '' || !allowed.has(extension)) throw new ConnectorItemRejectedError(MSG.type);
  const rule = Object.hasOwn(CONTENT_RULES, extension) ? CONTENT_RULES[extension] : undefined;
  if (!rule) throw new ConnectorItemRejectedError(MSG.type);

  const mime = normalizeMime(input.mimeType);
  if (mime === null) throw new ConnectorItemRejectedError(MSG.mismatch);
  const generic = mime === '' || mime === OCTET_STREAM;
  if (generic) {
    if (!rule.signature) throw new ConnectorItemRejectedError(MSG.undetermined);
  } else {
    const exts = Object.hasOwn(MIME_EXTENSIONS, mime) ? MIME_EXTENSIONS[mime] : undefined;
    if (!exts || !exts.includes(extension)) throw new ConnectorItemRejectedError(MSG.mismatch);
  }

  if (rule.signature) {
    if (!rule.signature(bytes)) throw new ConnectorItemRejectedError(MSG.signature);
  } else if (bytes.includes(0)) {
    // Un octet NUL n'a rien à faire dans un texte : binaire déguisé (ou UTF-16, non pris en charge).
    throw new ConnectorItemRejectedError(MSG.signature);
  }

  const digest = createHash('sha256').update(bytes).digest();
  if (input.declaredSha256 !== undefined && input.declaredSha256 !== null) {
    if (typeof input.declaredSha256 !== 'string') {
      throw new ConnectorItemRejectedError(MSG.hashUnreadable);
    }
    const declared = decodeDeclaredSha256(input.declaredSha256);
    if (!declared) throw new ConnectorItemRejectedError(MSG.hashUnreadable);
    if (!declared.equals(digest)) throw new ConnectorItemRejectedError(MSG.hash);
  }

  return {
    fileName,
    extension,
    mimeType: generic ? rule.mime : mime,
    sha256: digest.toString('hex'),
  };
}
