import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { KeyObject } from 'node:crypto';
import { generateSealingKeyPair, keyFingerprint, loadSealingKey } from './domain/sealing';

/**
 * Clé de scellement de l'installation (Ed25519), utilisée pour signer et horodater les documents.
 *
 * Emplacement : `SEALING_KEY_PATH`, à défaut `<ARCHIVES_PATH>/.keys/sealing-ed25519.pem`.
 * Générée au premier usage si absente — un déploiement existant n'a donc rien à préparer, et la
 * fonction ne peut pas rester silencieusement inopérante faute de configuration.
 *
 * ⚠ Limite assumée, et signalée à l'écran : la clé privée vit sur le même serveur que les
 * archives. Quiconque y a accès peut re-sceller un document altéré. Le cachet vaut donc contre une
 * altération du COFFRE (fichier remplacé hors application), pas contre l'exploitant lui-même. Pour
 * cela il faut sortir la clé du serveur (HSM) ou faire attester la date par un tiers (RFC 3161).
 */
@Injectable()
export class SealingKeyService {
  private readonly logger = new Logger(SealingKeyService.name);
  private cached: { privateKey: KeyObject; publicKey: KeyObject; fingerprint: string } | null = null;

  constructor(private readonly config: ConfigService) {}

  private get keyPath(): string {
    const configured = this.config.get<string>('SEALING_KEY_PATH');
    if (configured && configured.trim() !== '') return configured;
    return join(this.config.getOrThrow<string>('ARCHIVES_PATH'), '.keys', 'sealing-ed25519.pem');
  }

  /** Charge la clé (et la crée au besoin). Mise en cache : la lecture disque n'a lieu qu'une fois. */
  async get(): Promise<{ privateKey: KeyObject; publicKey: KeyObject; fingerprint: string }> {
    if (this.cached) return this.cached;

    const path = this.keyPath;
    let pem: string;
    try {
      pem = await readFile(path, 'utf8');
    } catch {
      const generated = generateSealingKeyPair();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, generated.privateKeyPem, { mode: 0o600 });
      // Best-effort : sans effet sur Windows, mais indispensable là où l'API tourne sous Unix.
      await chmod(path, 0o600).catch(() => undefined);
      pem = generated.privateKeyPem;
      this.logger.warn(
        `Clé de scellement absente : une nouvelle a été générée dans ${path}. ` +
          'Sauvegardez-la — sans elle, les cachets déjà apposés deviennent invérifiables.',
      );
    }

    const { privateKey, publicKey } = loadSealingKey(pem);
    this.cached = { privateKey, publicKey, fingerprint: keyFingerprint(publicKey) };
    return this.cached;
  }

  /** Clé publique au format PEM — de quoi vérifier un cachet hors de l'application. */
  async publicKeyPem(): Promise<string> {
    const { publicKey } = await this.get();
    return publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }
}
