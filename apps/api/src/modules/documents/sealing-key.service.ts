import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  loadOrCreateSealingKey,
  publicKeyPem,
  resolveKeyPath,
  type SealingKey,
} from '@archivage/sealing';

/**
 * Clé de scellement de l'installation (Ed25519), côté API.
 *
 * Depuis le 2026-09-15, la résolution du chemin, le chargement et la génération vivent dans
 * `@archivage/sealing` : le worker scelle lui aussi les documents dès leur ingestion, et les deux
 * processus doivent impérativement aboutir à la MÊME clé. Il ne reste ici que l'enveloppe Nest —
 * l'injection de la configuration, le cache mémoire et le logger.
 *
 * ⚠ Limite assumée, signalée à l'écran : la clé privée vit sur le même serveur que les archives.
 * Le cachet vaut donc contre une altération du COFFRE, pas contre l'exploitant lui-même.
 */
@Injectable()
export class SealingKeyService {
  private readonly logger = new Logger(SealingKeyService.name);
  private cached: SealingKey | null = null;

  constructor(private readonly config: ConfigService) {}

  private get keyPath(): string {
    return resolveKeyPath({
      SEALING_KEY_PATH: this.config.get<string>('SEALING_KEY_PATH'),
      ARCHIVES_PATH: this.config.getOrThrow<string>('ARCHIVES_PATH'),
    });
  }

  /** Charge la clé (et la crée au besoin). Mise en cache : la lecture disque n'a lieu qu'une fois. */
  async get(): Promise<SealingKey> {
    this.cached ??= await loadOrCreateSealingKey(this.keyPath, (msg: string) => this.logger.warn(msg));
    return this.cached;
  }

  /** Clé publique au format PEM — de quoi vérifier un cachet hors de l'application. */
  async publicKeyPem(): Promise<string> {
    return publicKeyPem(await this.get());
  }
}
