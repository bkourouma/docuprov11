import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { generateSealingKeyPair, keyFingerprint, loadSealingKey } from './domain';

/** Clé de scellement résolue : de quoi signer, vérifier, et dire QUELLE clé a signé. */
export interface SealingKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  fingerprint: string;
}

/**
 * Emplacement de la clé de l'installation : `SEALING_KEY_PATH` s'il est renseigné, sinon
 * `<ARCHIVES_PATH>/.keys/sealing-ed25519.pem`.
 *
 * API et worker doivent impérativement résoudre le MÊME chemin : deux clés distinctes
 * produiraient des cachets que l'autre processus déclarerait « Clé inconnue ». D'où cette
 * résolution partagée plutôt que deux copies de la règle.
 */
export function resolveKeyPath(env: {
  SEALING_KEY_PATH?: string | undefined;
  ARCHIVES_PATH: string;
}): string {
  const configured = env.SEALING_KEY_PATH;
  if (configured && configured.trim() !== '') return configured;
  return join(env.ARCHIVES_PATH, '.keys', 'sealing-ed25519.pem');
}

/**
 * Charge la clé, en la créant au premier usage si elle est absente — un déploiement existant n'a
 * donc rien à préparer, et la fonction ne peut pas rester silencieusement inopérante faute de
 * configuration.
 *
 * ⚠ Limite assumée, affichée à l'écran : la clé privée vit sur le même serveur que les archives.
 * Quiconque y a accès peut re-sceller un document altéré. Le cachet vaut contre une altération du
 * COFFRE, pas contre l'exploitant lui-même — il faudrait pour cela sortir la clé du serveur (HSM)
 * ou faire attester la date par un tiers (jeton RFC 3161).
 *
 * `onGenerated` laisse l'appelant journaliser la création avec son propre logger : perdre cette
 * clé rend invérifiables tous les cachets déjà apposés, l'événement ne doit pas passer inaperçu.
 */
export async function loadOrCreateSealingKey(
  path: string,
  onGenerated?: (message: string) => void,
): Promise<SealingKey> {
  let pem: string;
  try {
    pem = await readFile(path, 'utf8');
  } catch {
    const generated = generateSealingKeyPair();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, generated.privateKeyPem, { mode: 0o600 });
    // Best-effort : sans effet sur Windows, mais indispensable là où le service tourne sous Unix.
    await chmod(path, 0o600).catch(() => undefined);
    pem = generated.privateKeyPem;
    onGenerated?.(
      `Clé de scellement absente : une nouvelle a été générée dans ${path}. ` +
        'Sauvegardez-la — sans elle, les cachets déjà apposés deviennent invérifiables.',
    );
  }

  const { privateKey, publicKey } = loadSealingKey(pem);
  return { privateKey, publicKey, fingerprint: keyFingerprint(publicKey) };
}

/** Clé publique au format PEM — de quoi vérifier un cachet HORS de l'application. */
export function publicKeyPem(key: SealingKey): string {
  return key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
}
