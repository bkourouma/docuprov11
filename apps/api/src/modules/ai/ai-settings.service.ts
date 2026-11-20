import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GedAiSetting } from '@prisma/client';
import {
  GED_AI_API_KEY_REF_REGEX,
  GED_AI_DEFAULT_CLOUD_EMBEDDING_MODEL,
  GED_AI_DEFAULT_CLOUD_ENDPOINT,
  GED_AI_DEFAULT_CLOUD_MODEL,
  GED_AI_DEFAULT_CLOUD_PROVIDER,
  GED_EMBEDDING_DIMENSION,
  GedAiMode,
} from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { AiEffectiveConfig } from './ai.types';
import type { AiSettingsView, UpdateAiSettingsDto } from './ai-settings.dto';

/** Identifiant constant de la ligne unique `ged_ai_setting` (CHECK SQL : id = 1). */
const SETTING_ID = 1;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 600;
/** Hôtes pour lesquels le HTTP en clair reste toléré, même en cloud (passerelle locale, tests). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Paramétrage du socle IA : ligne unique `ged_ai_setting` (id = 1).
 *
 * Les règles vérifiées ici sont le MIROIR des CHECK SQL, mais avec un message explicite : on refuse
 * avant l'écriture plutôt que de laisser remonter une erreur de contrainte opaque. La base reste le
 * dernier garde-fou. Aucune méthode ne renvoie ni ne journalise la valeur d'une clé d'API : on ne
 * manipule que le NOM de la variable d'environnement qui la porte.
 */
@Injectable()
export class AiSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Ligne brute, ou `null` si elle n'a jamais été écrite (IA alors considérée désactivée). */
  getRow(): Promise<GedAiSetting | null> {
    return this.prisma.gedAiSetting.findUnique({ where: { gedAiSettingId: SETTING_ID } });
  }

  /**
   * Configuration effective consommée par `AiService`. Une ligne absente ou le mode 0 = IA
   * désactivée, sans autre repli : aucune variable d'environnement ne « devine » un mode.
   */
  async getEffective(): Promise<AiEffectiveConfig> {
    const row = await this.getRow();
    const mode = (row?.mode ?? GedAiMode.Desactivee) as GedAiMode;

    return {
      mode,
      provider: row?.provider ?? null,
      model: row?.model ?? null,
      embeddingModel: row?.embeddingModel ?? null,
      embeddingDimension: row?.embeddingDimension ?? GED_EMBEDDING_DIMENSION,
      endpoint:
        row?.endpoint ?? (mode === GedAiMode.Locale ? this.envValue('GED_AI_LOCAL_ENDPOINT') : null),
      apiKeyRef: row?.apiKeyRef ?? null,
      maskingEnabled: row?.maskingEnabled ?? true,
      autoApplyThreshold: this.thresholdOf(row, mode),
      timeoutSeconds: row?.timeoutSeconds ?? 60,
    };
  }

  /** Seuil d'application automatique : `null` sans ligne ou en mode 0 (cohérent avec le worker). */
  private thresholdOf(row: GedAiSetting | null, mode: GedAiMode): number | null {
    if (!row || mode === GedAiMode.Desactivee) return null;
    return row.autoApplyThreshold ? row.autoApplyThreshold.toNumber() : null;
  }

  /**
   * La clé est-elle résoluble ? Reflète EXACTEMENT `resolveApiKey` de la fabrique : une référence
   * hors liste blanche, ou `OPENAI_API_KEY` hors cloud + `openai` + `api.openai.com` (https), est une
   * ERREUR de configuration (=> false) ; sinon variable référencée présente, ou `GED_AI_API_KEY`, ou
   * `OPENAI_API_KEY` uniquement dans ce cloud OpenAI.
   */
  private isApiKeyConfigured(row: GedAiSetting | null): boolean {
    const apiKeyRef = row?.apiKeyRef ?? null;
    if (apiKeyRef) {
      if (!GED_AI_API_KEY_REF_REGEX.test(apiKeyRef)) return false;
      if (apiKeyRef === 'OPENAI_API_KEY' && !this.openAiKeyUsable(row)) return false;
      if (this.envValue(apiKeyRef) !== null) return true;
    }
    if (this.envValue('GED_AI_API_KEY') !== null) return true;
    return this.openAiKeyUsable(row) && this.envValue('OPENAI_API_KEY') !== null;
  }

  /** Cloud + fournisseur `openai` + endpoint `https://api.openai.com` (valeurs par défaut comprises). */
  private openAiKeyUsable(row: GedAiSetting | null): boolean {
    if (!row || row.mode !== GedAiMode.Cloud) return false;
    if ((row.provider ?? GED_AI_DEFAULT_CLOUD_PROVIDER) !== GED_AI_DEFAULT_CLOUD_PROVIDER) return false;
    try {
      const url = new URL(row.endpoint ?? GED_AI_DEFAULT_CLOUD_ENDPOINT);
      return url.protocol === 'https:' && url.hostname === 'api.openai.com';
    } catch {
      return false;
    }
  }

  /** Vue pour l'administration : tous les champs, plus l'état de la clé — JAMAIS sa valeur. */
  async getView(): Promise<AiSettingsView> {
    const row = await this.getRow();
    const apiKeyRef = row?.apiKeyRef ?? null;
    const apiKeyConfigured = this.isApiKeyConfigured(row);
    return {
      mode: (row?.mode ?? GedAiMode.Desactivee) as 0 | 1 | 2,
      provider: row?.provider ?? null,
      model: row?.model ?? null,
      embeddingModel: row?.embeddingModel ?? null,
      embeddingDimension: row?.embeddingDimension ?? GED_EMBEDDING_DIMENSION,
      endpoint: row?.endpoint ?? null,
      apiKeyRef,
      maskingEnabled: row?.maskingEnabled ?? true,
      // La vue montre la valeur stockée (l'administrateur la modifie même IA coupée).
      autoApplyThreshold: row?.autoApplyThreshold ? row.autoApplyThreshold.toNumber() : null,
      timeoutSeconds: row?.timeoutSeconds ?? 60,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      apiKeyConfigured,
    };
  }

  /** Règles de masquage configurées, en lecture seule (la gestion passe par un lot ultérieur). */
  listMaskingRules() {
    return this.prisma.gedAiMaskingRule.findMany({
      orderBy: [{ sortOrder: 'asc' }, { gedAiMaskingRuleId: 'asc' }],
    });
  }

  /** Mise à jour partielle, validée sur l'état résultant, puis écrite en upsert sur la ligne 1. */
  async update(dto: UpdateAiSettingsDto, actor: AuthUser): Promise<AiSettingsView> {
    const current = await this.getRow();
    const data = this.buildData(dto, current);
    await this.prisma.gedAiSetting.upsert({
      where: { gedAiSettingId: SETTING_ID },
      create: { gedAiSettingId: SETTING_ID, ...data, updatedBy: actor.userGroupId },
      update: { ...data, updatedBy: actor.userGroupId },
    });
    return this.getView();
  }

  /**
   * Valide la requête contre l'état résultant et renvoie les seuls champs à écrire. Lève 400 sur
   * la première règle violée.
   */
  private buildData(dto: UpdateAiSettingsDto, current: GedAiSetting | null) {
    const data: Partial<
      Pick<
        GedAiSetting,
        | 'mode'
        | 'provider'
        | 'model'
        | 'embeddingModel'
        | 'embeddingDimension'
        | 'endpoint'
        | 'apiKeyRef'
        | 'maskingEnabled'
        | 'timeoutSeconds'
      >
    > & { autoApplyThreshold?: number | null } = {};

    const mode = dto.mode ?? current?.mode ?? GedAiMode.Desactivee;
    const maskingEnabled = dto.maskingEnabled ?? current?.maskingEnabled ?? true;

    if (dto.mode !== undefined) data.mode = dto.mode;
    if (dto.maskingEnabled !== undefined) data.maskingEnabled = dto.maskingEnabled;

    // Miroir de ck_ged_ai_setting_cloud_masking : le masquage est inamovible en cloud.
    if (mode === GedAiMode.Cloud && !maskingEnabled) {
      throw new BadRequestException(
        'Le masquage des données est obligatoire en mode cloud : désactivez-le seulement hors cloud.',
      );
    }

    if (dto.apiKeyRef !== undefined) {
      // Liste blanche : une référence libre permettrait d'exfiltrer `JWT_SECRET` ou `DATABASE_URL`.
      if (dto.apiKeyRef !== null && !GED_AI_API_KEY_REF_REGEX.test(dto.apiKeyRef)) {
        throw new BadRequestException(
          'La référence de clé doit être le NOM d\'une variable d\'environnement (OPENAI_API_KEY ou GED_AI_*), jamais la clé elle-même.',
        );
      }
      data.apiKeyRef = dto.apiKeyRef;
    }

    if (dto.embeddingDimension !== undefined) {
      if (dto.embeddingDimension !== GED_EMBEDDING_DIMENSION) {
        throw new BadRequestException(
          `La dimension des embeddings est fixée à ${GED_EMBEDDING_DIMENSION} : la changer demande une migration, pas une configuration.`,
        );
      }
      data.embeddingDimension = dto.embeddingDimension;
    }

    if (dto.autoApplyThreshold !== undefined) {
      const t = dto.autoApplyThreshold;
      if (t !== null && (!Number.isFinite(t) || t < 0 || t > 1)) {
        throw new BadRequestException('Le seuil d\'application automatique doit être entre 0 et 1.');
      }
      data.autoApplyThreshold = t;
    }

    if (dto.timeoutSeconds !== undefined) {
      if (dto.timeoutSeconds < MIN_TIMEOUT_SECONDS || dto.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
        throw new BadRequestException(
          `Le délai d'expiration doit être compris entre ${MIN_TIMEOUT_SECONDS} et ${MAX_TIMEOUT_SECONDS} secondes.`,
        );
      }
      data.timeoutSeconds = dto.timeoutSeconds;
    }

    for (const key of ['provider', 'model', 'embeddingModel'] as const) {
      if (dto[key] !== undefined) data[key] = dto[key];
    }

    // Endpoint : validé s'il est fourni, ou s'il conditionne le mode résultant.
    let endpoint = dto.endpoint !== undefined ? dto.endpoint : (current?.endpoint ?? null);
    if (mode === GedAiMode.Cloud) {
      // Valeurs par défaut du fournisseur cloud quand rien n'est renseigné.
      if (!endpoint) endpoint = GED_AI_DEFAULT_CLOUD_ENDPOINT;
      const provider = dto.provider !== undefined ? dto.provider : (current?.provider ?? null);
      const model = dto.model !== undefined ? dto.model : (current?.model ?? null);
      const embeddingModel =
        dto.embeddingModel !== undefined ? dto.embeddingModel : (current?.embeddingModel ?? null);
      if (!provider) data.provider = GED_AI_DEFAULT_CLOUD_PROVIDER;
      if (!model) data.model = GED_AI_DEFAULT_CLOUD_MODEL;
      if (!embeddingModel) data.embeddingModel = GED_AI_DEFAULT_CLOUD_EMBEDDING_MODEL;
    }
    if (mode === GedAiMode.Locale && !endpoint) {
      throw new BadRequestException('Le mode local exige l\'endpoint du modèle (URL http ou https).');
    }
    if (endpoint) {
      this.assertEndpoint(endpoint, mode === GedAiMode.Cloud);
      if (dto.endpoint !== undefined || endpoint !== (current?.endpoint ?? null)) {
        data.endpoint = endpoint;
      }
    } else if (dto.endpoint !== undefined) {
      data.endpoint = null;
    }

    return data;
  }

  /** URL http(s) valide ; en cloud, https obligatoire sauf boucle locale. */
  private assertEndpoint(endpoint: string, cloud: boolean): void {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new BadRequestException('L\'endpoint doit être une URL valide (http ou https).');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('L\'endpoint doit être une URL http ou https.');
    }
    if (url.username || url.password) {
      throw new BadRequestException("L'endpoint ne doit pas contenir d'identifiants (utilisez une référence de clé).");
    }
    if (cloud && url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new BadRequestException('En mode cloud, l\'endpoint doit utiliser https.');
    }
  }

  /** Valeur d'une variable d'environnement si elle existe et n'est pas vide, sinon `null`. */
  private envValue(name: string): string | null {
    const v = this.config.get<string>(name);
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  }
}
