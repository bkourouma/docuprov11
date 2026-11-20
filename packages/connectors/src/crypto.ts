// Chiffrement des identifiants des connecteurs de sources (lot 2a).
//
// Pourquoi AES-256-GCM et une enveloppe maison plutôt qu'une dépendance : `node:crypto` suffit, le
// format reste lisible par n'importe quel outil d'exploitation, et l'octet de version en tête
// d'enveloppe permet de changer d'algorithme plus tard sans casser les chiffrés existants.
//
// Règle transverse : AUCUN message d'erreur de ce fichier ne contient une clé, un identifiant en
// clair ni un fragment de texte clair. Ces messages remontent dans les journaux et dans l'API
// d'administration ; un secret qui y passe une fois est perdu.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ConnectorCredentials } from './types';

export interface KeyRing {
  activeKeyId: string;
  /** keyId -> clé AES-256 (32 octets). */
  keys: Record<string, Buffer>;
}

/** Erreur de chiffrement/déchiffrement/configuration des identifiants. Message sûr à journaliser. */
export class CredentialsCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsCryptoError';
  }
}

/** Version du format d'enveloppe : octet 0 du binaire décodé. */
const ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
/**
 * Bornes de taille : des identifiants (jeton OAuth, mot de passe IMAP) tiennent en quelques Ko. Une
 * borne évite qu'une colonne corrompue ou un JSON géant ne fasse exploser la mémoire du worker.
 */
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_ENVELOPE_CHARS = Math.ceil(((MAX_PLAINTEXT_BYTES + HEADER_BYTES) * 4) / 3) + 4;
/** Identifiant de clé : tient dans `credentials_key_id` (VarChar(100)), sans séparateur ambigu (`:` `,`). */
export const KEY_ID_REGEX = /^[A-Za-z0-9_-]{1,50}$/;
const DEFAULT_KEY_ID = 'k1';
/** Longueur minimale d'une valeur masquée par `redactSecrets` : en deçà, trop de faux positifs. */
const MIN_REDACT_LENGTH = 4;

/**
 * AAD (données authentifiées non chiffrées) : lie le chiffré à son identifiant de clé et à la
 * version du format. Sans ce lien, une ligne dont on aurait réécrit `credentials_key_id` pourrait
 * être déchiffrée sous une autre clé partageant les mêmes octets (même clé déclarée sous deux
 * noms) ; avec lui, toute substitution de l'identifiant fait échouer le tag. Le préfixe sépare ce
 * domaine de tout autre usage futur de la même clé.
 */
function aadFor(keyId: string): Buffer {
  return Buffer.from(
    `docupro-ged-connector-credentials\u0000v${ENVELOPE_VERSION}\u0000${keyId}`,
    'utf8',
  );
}

/**
 * Base64 STRICT. `Buffer.from(s, 'base64')` est permissif : il ignore les caractères invalides et
 * tronque en silence. Une clé saisie avec une coquille donnerait alors une autre clé, ou une clé
 * trop courte, sans alerte — d'où la vérification de l'alphabet, du remplissage et de l'aller-retour.
 */
function decodeStrictBase64(value: string): Buffer | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  if (buf.toString('base64') !== value) return null;
  return buf;
}

function parseKey(raw: string, label: string): Buffer {
  const buf = decodeStrictBase64(raw.trim());
  if (!buf) {
    throw new CredentialsCryptoError(
      `${label} : la clé doit être encodée en base64 standard (ex. « openssl rand -base64 32 »)`,
    );
  }
  if (buf.length !== KEY_BYTES) {
    // La taille réelle n'est pas donnée : « 32 octets attendus » suffit à corriger.
    throw new CredentialsCryptoError(
      `${label} : la clé doit faire exactement ${KEY_BYTES} octets (AES-256)`,
    );
  }
  return buf;
}

/**
 * Charge le trousseau depuis l'environnement :
 *  - `GED_CONNECTOR_KEY` : clé ACTIVE, base64 de 32 octets exactement (chiffre et déchiffre) ;
 *  - `GED_CONNECTOR_KEY_ID` : son identifiant (défaut `k1`), stocké à côté de chaque chiffré ;
 *  - `GED_CONNECTOR_KEY_PREVIOUS` : anciennes clés `id1:base64,id2:base64`, en DÉCHIFFREMENT
 *    seulement, le temps de rechiffrer les lignes existantes (rotation).
 */
export function loadKeyRing(env: NodeJS.ProcessEnv): KeyRing {
  const rawKey = env.GED_CONNECTOR_KEY;
  if (rawKey == null || rawKey.trim() === '') {
    throw new CredentialsCryptoError(
      'GED_CONNECTOR_KEY absente : impossible de chiffrer les identifiants des connecteurs',
    );
  }
  const activeKeyId = (env.GED_CONNECTOR_KEY_ID ?? '').trim() || DEFAULT_KEY_ID;
  if (!KEY_ID_REGEX.test(activeKeyId)) {
    throw new CredentialsCryptoError(
      'GED_CONNECTOR_KEY_ID invalide : 1 à 50 caractères parmi lettres, chiffres, « _ » et « - »',
    );
  }

  // Objet sans prototype : un identifiant `__proto__` ou `constructor` ne peut ni polluer ni
  // masquer une entrée héritée.
  const keys = Object.create(null) as Record<string, Buffer>;
  keys[activeKeyId] = parseKey(rawKey, 'GED_CONNECTOR_KEY');

  const previous = (env.GED_CONNECTOR_KEY_PREVIOUS ?? '').trim();
  if (previous !== '') {
    previous.split(',').forEach((item, index) => {
      const pos = `GED_CONNECTOR_KEY_PREVIOUS (entrée n° ${index + 1})`;
      const sep = item.indexOf(':');
      if (sep <= 0) {
        throw new CredentialsCryptoError(`${pos} : format attendu « identifiant:clé_base64 »`);
      }
      const id = item.slice(0, sep).trim();
      if (!KEY_ID_REGEX.test(id)) {
        throw new CredentialsCryptoError(
          `${pos} : identifiant invalide (1 à 50 caractères parmi lettres, chiffres, « _ » et « - »)`,
        );
      }
      if (Object.hasOwn(keys, id)) {
        // Deux clés sous le même nom : laquelle déchiffre ? On refuse plutôt que de choisir.
        throw new CredentialsCryptoError(`${pos} : identifiant de clé en double`);
      }
      keys[id] = parseKey(item.slice(sep + 1), pos);
    });
  }

  return { activeKeyId, keys };
}

/**
 * Valide un objet d'identifiants « nom → chaîne ». Partagé par le chiffrement, le déchiffrement et
 * la résolution par référence : les trois doivent produire exactement la même forme.
 * Le message ne cite jamais de valeur, ni même de nom de champ (qui peut être parlant).
 */
function toCredentials(value: unknown, context: string): ConnectorCredentials {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CredentialsCryptoError(`${context} : objet « nom → valeur » attendu`);
  }
  const out: ConnectorCredentials = {};
  for (const key of Object.keys(value)) {
    // `__proto__` issu d'un JSON.parse est une clé PROPRE ; l'affecter sur un objet ordinaire
    // changerait son prototype au lieu de créer un champ. On le refuse franchement.
    if (key === '__proto__') {
      throw new CredentialsCryptoError(`${context} : nom de champ interdit`);
    }
    const v = (value as Record<string, unknown>)[key];
    if (typeof v !== 'string') {
      throw new CredentialsCryptoError(`${context} : toutes les valeurs doivent être des chaînes`);
    }
    out[key] = v;
  }
  return out;
}

function getKey(ring: KeyRing, keyId: string): Buffer | null {
  if (!ring || typeof ring !== 'object' || !ring.keys || typeof ring.keys !== 'object') return null;
  if (!Object.hasOwn(ring.keys, keyId)) return null;
  const key = ring.keys[keyId];
  return Buffer.isBuffer(key) && key.length === KEY_BYTES ? key : null;
}

/** Chiffre des identifiants avec la clé ACTIVE. Renvoie l'enveloppe base64 et l'identifiant de clé à stocker. */
export function encryptCredentials(
  creds: ConnectorCredentials,
  ring: KeyRing,
): { credentialsEnc: string; credentialsKeyId: string } {
  const valid = toCredentials(creds, 'Identifiants à chiffrer');
  const keyId = ring?.activeKeyId;
  const key = typeof keyId === 'string' && KEY_ID_REGEX.test(keyId) ? getKey(ring, keyId) : null;
  if (typeof keyId !== 'string' || !key) {
    throw new CredentialsCryptoError('Trousseau invalide : clé de chiffrement active introuvable');
  }
  const plaintext = Buffer.from(JSON.stringify(valid), 'utf8');
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new CredentialsCryptoError('Identifiants trop volumineux pour être chiffrés');
  }
  // IV aléatoire de 96 bits à CHAQUE chiffrement : en GCM, réutiliser un IV sous la même clé
  // révèle le XOR des clairs et permet de forger des tags. Le volume (quelques lignes par
  // connecteur) reste très loin de la borne de 2^32 chiffrements par clé.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(keyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, tag, ciphertext]);
  return { credentialsEnc: envelope.toString('base64'), credentialsKeyId: keyId };
}

/** Message unique pour toute enveloppe illisible : ne pas aider un attaquant à distinguer les cas. */
const GENERIC_DECRYPT_ERROR =
  'Déchiffrement des identifiants impossible (données altérées ou clé incorrecte)';

/**
 * Déchiffre des identifiants. `keyId` est l'identifiant stocké avec le chiffré ; une clé absente
 * du trousseau signale presque toujours une rotation mal menée (ancienne clé retirée trop tôt).
 */
export function decryptCredentials(
  enc: string,
  keyId: string | null,
  ring: KeyRing,
): ConnectorCredentials {
  if (typeof keyId !== 'string' || !KEY_ID_REGEX.test(keyId)) {
    // Pas de « clé par défaut » : deviner la clé reviendrait à déchiffrer sans lien avec
    // l'identifiant stocké, ce que l'AAD est justement là pour empêcher.
    throw new CredentialsCryptoError('Identifiant de clé de chiffrement manquant ou invalide');
  }
  const key = getKey(ring, keyId);
  if (!key) {
    throw new CredentialsCryptoError(
      'Clé de chiffrement inconnue (rotation ?) : remettez l’ancienne clé dans GED_CONNECTOR_KEY_PREVIOUS',
    );
  }
  if (typeof enc !== 'string' || enc.length > MAX_ENVELOPE_CHARS) {
    throw new CredentialsCryptoError(GENERIC_DECRYPT_ERROR);
  }
  const envelope = decodeStrictBase64(enc.trim());
  if (!envelope || envelope.length < HEADER_BYTES + 1 || envelope[0] !== ENVELOPE_VERSION) {
    throw new CredentialsCryptoError(GENERIC_DECRYPT_ERROR);
  }
  const iv = envelope.subarray(1, 1 + IV_BYTES);
  const tag = envelope.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES);

  let plaintext: Buffer;
  try {
    // `authTagLength` explicite : sans lui, Node accepterait un tag tronqué (4 octets), ce qui
    // rendrait la falsification envisageable.
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadFor(keyId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // L'erreur d'origine n'apporte rien à l'exploitant ; on ne propage aucun détail interne.
    throw new CredentialsCryptoError(GENERIC_DECRYPT_ERROR);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    // Tag valide mais contenu non JSON : chiffré produit par autre chose que ce module. Surtout
    // pas le message de `SyntaxError`, qui cite le début du clair.
    throw new CredentialsCryptoError(GENERIC_DECRYPT_ERROR);
  } finally {
    plaintext.fill(0);
  }
  return toCredentials(parsed, 'Identifiants déchiffrés');
}

/** Vrai si ce chiffré n'est pas sous la clé active et doit être rechiffré (rotation). */
export function needsReencryption(keyId: string | null, ring: KeyRing): boolean {
  return keyId !== ring.activeKeyId;
}

/**
 * Rotation : déchiffre avec la clé indiquée (ancienne ou active) et rechiffre avec la clé ACTIVE.
 * Toujours un nouvel IV, même si la clé n'a pas changé.
 */
export function reencryptCredentials(
  enc: string,
  keyId: string | null,
  ring: KeyRing,
): { credentialsEnc: string; credentialsKeyId: string } {
  return encryptCredentials(decryptCredentials(enc, keyId, ring), ring);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remplace par `***` toute valeur d'identifiant (≥ 4 caractères) présente dans `text`.
 *
 * Pourquoi : les bibliothèques réseau (IMAP, HTTP) recopient volontiers la commande fautive dans
 * leurs erreurs (`LOGIN user motdepasse`, URL avec jeton). Ce filtre est la dernière barrière avant
 * le journal, l'état « en erreur » du connecteur et la réponse API. On masque aussi les formes
 * encodées sous lesquelles la valeur réapparaît le plus souvent (URL, JSON, base64 de la valeur
 * seule). Limite connue : un base64 qui MÉLANGE plusieurs champs (ex. `AUTH PLAIN` = base64 de
 * « \0user\0motdepasse ») n'est pas reconnu — les connecteurs ne doivent pas journaliser le
 * dialogue protocolaire brut.
 */
export function redactSecrets(
  text: string,
  creds: ConnectorCredentials | null | undefined,
): string {
  if (typeof text !== 'string' || text === '' || !creds || typeof creds !== 'object') return text;
  const needles = new Set<string>();
  for (const key of Object.keys(creds)) {
    const value = (creds as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.length < MIN_REDACT_LENGTH) continue;
    needles.add(value);
    try {
      needles.add(encodeURIComponent(value));
    } catch {
      // Demi-caractère de substitution isolé : pas de forme URL, on garde la forme brute.
    }
    needles.add(JSON.stringify(value).slice(1, -1));
    needles.add(Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, ''));
  }
  // Les plus longues d'abord : si un secret en contient un autre, on masque le grand en entier
  // plutôt que d'en laisser dépasser des morceaux.
  const ordered = [...needles]
    .filter((n) => n.length >= MIN_REDACT_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return text;
  return text.replace(new RegExp(ordered.map(escapeRegExp).join('|'), 'g'), '***');
}

/** Nom de variable d'environnement acceptable comme `credentials_ref` (liste blanche, comme `api_key_ref` du socle IA). */
export const CREDENTIALS_REF_REGEX = /^GED_CONNECTOR_SECRET_[A-Z0-9][A-Z0-9_]{0,59}$/;
/** Résout `credentials_ref` : variable d'environnement contenant un JSON d'identifiants. Refuse tout nom hors liste blanche. */
export function resolveCredentialsRef(ref: string, env: NodeJS.ProcessEnv): ConnectorCredentials {
  // La liste blanche est la seule chose qui empêche un administrateur applicatif de faire lire au
  // connecteur `JWT_SECRET` ou `DATABASE_URL` puis d'en exfiltrer la valeur vers un serveur qu'il
  // contrôle (identifiants envoyés à « son » IMAP). Le nom refusé n'est pas recopié.
  if (typeof ref !== 'string' || !CREDENTIALS_REF_REGEX.test(ref)) {
    throw new CredentialsCryptoError(
      'Référence d’identifiants refusée : seules les variables GED_CONNECTOR_SECRET_… sont autorisées',
    );
  }
  const raw = env[ref];
  if (raw == null || raw.trim() === '') {
    // Le nom (déjà validé par la liste blanche) n'est pas un secret et aide l'exploitant.
    throw new CredentialsCryptoError(`Variable d’environnement ${ref} absente ou vide`);
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_PLAINTEXT_BYTES) {
    throw new CredentialsCryptoError(`Variable d’environnement ${ref} trop volumineuse`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Surtout pas le message de `SyntaxError` : il cite un extrait de la valeur.
    throw new CredentialsCryptoError(
      `Variable d’environnement ${ref} : JSON invalide (objet « nom → valeur » attendu)`,
    );
  }
  return toCredentials(parsed, `Variable d’environnement ${ref}`);
}
