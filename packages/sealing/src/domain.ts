// Domaine PUR du cachet serveur (signature + horodatage) — aucune dépendance NestJS/Prisma.
//
// Le cachet répond à deux questions que l'empreinte seule ne couvre pas : QUI atteste ce document,
// et À QUELLE DATE. La date étant incluse dans la charge signée, la retoucher invalide la
// signature — c'est ce qui distingue un horodatage d'une simple colonne date.
//
// ⚠ Portée juridique : signature et horodatage sont produits par la clé de l'INSTALLATION. Ils
// prouvent qu'un document n'a pas changé depuis son scellement, et que le scellement vient de
// cette installation. Ils ne valent PAS horodatage qualifié eIDAS : seule une autorité tierce
// (jeton RFC 3161) peut attester une date face à l'exploitant lui-même, qui détient ici la clé.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

/** Un binaire scellé : son identifiant et son empreinte au moment du scellement. */
export interface SealedFile {
  fileId: number;
  hash: string;
}

export interface SealInput {
  documentId: number;
  files: SealedFile[];
  sealedAt: Date;
}

export const SEAL_ALGORITHM = 'Ed25519';

/**
 * Instant de scellement, tronqué À LA SECONDE.
 *
 * `document_seal.sealed_at` est un `TIMESTAMPTZ(0)` : les millisecondes n'y survivent pas. Signer
 * une date au millième produirait une charge que la relecture ne saurait PLUS reconstruire — le
 * cachet se déclarerait alors « contenu modifié » dès la seconde qui suit son apposition. On aligne
 * donc la précision signée sur celle qui est réellement conservée.
 */
export function sealTimestamp(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 1000) * 1000);
}

/**
 * Charge signée, sous forme CANONIQUE et lisible.
 *
 * Format explicite plutôt que du JSON : deux sérialisations JSON du même objet peuvent différer
 * (ordre des clés, espaces) et produiraient deux signatures incomparables. Ici l'ordre est imposé
 * — fichiers triés par identifiant — donc deux scellements du même contenu donnent la même charge.
 * Le préfixe de version permettra d'en changer sans rendre les anciens cachets invérifiables.
 */
export function canonicalSealPayload(input: SealInput): string {
  const files = [...input.files]
    .sort((a, b) => a.fileId - b.fileId)
    .map((f) => `${f.fileId}:${f.hash}`)
    .join(',');
  return `v1|document:${input.documentId}|sealedAt:${input.sealedAt.toISOString()}|files:${files}`;
}

/**
 * Relit une charge scellée. La date qu'elle contient FAIT FOI : la colonne `sealed_at` n'existe
 * que pour trier et afficher, et rien n'empêche de la retoucher en base — alors que celle-ci est
 * couverte par la signature. Les comparer permet justement de détecter une date trafiquée.
 *
 * Renvoie `null` sur une charge illisible : une charge corrompue est un cachet à déclarer
 * invalide, pas une exception qui ferait tomber l'écran.
 */
export function parseSealPayload(payload: string): SealInput | null {
  const m = /^v1\|document:(\d+)\|sealedAt:([^|]+)\|files:(.*)$/.exec(payload);
  if (!m) return null;
  const sealedAt = new Date(m[2]!);
  if (Number.isNaN(sealedAt.getTime())) return null;
  const files = m[3]!
    .split(',')
    .filter((s) => s.length > 0)
    .map((part) => {
      const [id, hash] = part.split(':');
      return { fileId: Number(id), hash: hash ?? '' };
    });
  if (files.some((f) => !Number.isInteger(f.fileId) || !/^[0-9a-f]{64}$/.test(f.hash))) return null;
  return { documentId: Number(m[1]), files, sealedAt };
}

/** Signature Ed25519 de la charge, en base64. Ed25519 ne prend pas de fonction de hachage : `null`. */
export function signPayload(payload: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

/** Vérifie une signature. Toute erreur de format vaut « invalide », jamais une exception. */
export function verifyPayload(payload: string, signature: string, publicKey: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Empreinte de la clé publique (SHA-256 de son DER, hexadécimal). Sert à savoir QUELLE clé a
 * signé : après une rotation, un cachet dont l'empreinte ne correspond plus à la clé courante est
 * déclaré invérifiable — et non « invalide », qui laisserait croire à une falsification.
 */
export function keyFingerprint(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

/** Paire de clés de scellement, au format PEM (PKCS#8 / SPKI). */
export function generateSealingKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Recharge une clé privée PEM et en dérive la clé publique (une seule source de vérité sur disque). */
export function loadSealingKey(privateKeyPem: string): { privateKey: KeyObject; publicKey: KeyObject } {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Clé de scellement inattendue : ${privateKey.asymmetricKeyType ?? 'inconnue'} (Ed25519 requis)`);
  }
  return { privateKey, publicKey: createPublicKey(privateKey) };
}
