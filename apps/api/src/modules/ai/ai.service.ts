import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  clampConfidence,
  decideAiStatus,
  GED_AI_DEFAULT_CLOUD_EMBEDDING_MODEL,
  GED_AI_DEFAULT_LOCAL_EMBEDDING_MODEL,
  GED_AI_DISABLED_MESSAGE,
  GED_EMBEDDING_DIMENSION,
  GedAiDecisionStatus,
  GedAiMode,
} from '@archivage/types';
import { AiDecisionService } from './ai-decision.service';
import { AiMaskingService } from './ai-masking.service';
import { createProvider } from './ai-provider.factory';
import type { AiProviderDeps } from './ai-provider.factory';
import { AiSettingsService } from './ai-settings.service';
import {
  AiMaskingRequiredError,
  AiProviderError,
  AiUnsupportedInputError,
} from './ai.types';
import type {
  AiCompletionRequest,
  AiEffectiveConfig,
  AiEmbedResult,
  AiModelProvider,
  AiRunOptions,
  AiRunResult,
  AiStatus,
} from './ai.types';

const ERROR_MESSAGE_MAX = 500;

/**
 * SEUL point d'entrée des appelants de l'IA. Il impose, dans cet ordre : mode désactivé = réponse
 * `disabled` sans erreur ; cloud = masquage obligatoire (jamais de binaire joint) ; local = pièce
 * jointe seulement sur demande explicite si le masquage est actif ; appel du fournisseur ; journal de la décision (texte envoyé = texte MASQUÉ).
 *
 * Ni clé, ni texte de document ne sortent dans les logs.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  /** Dépendances de la fabrique ; surchargeables en test (`fetchImpl` simulé, env fictif). */
  providerDeps: AiProviderDeps = { env: process.env };

  constructor(
    private readonly settings: AiSettingsService,
    private readonly masking: AiMaskingService,
    private readonly decisions: AiDecisionService,
  ) {}

  getEffectiveConfig(): Promise<AiEffectiveConfig> {
    return this.settings.getEffective();
  }

  async status(): Promise<AiStatus> {
    const config = await this.settings.getEffective();
    const enabled = config.mode !== GedAiMode.Desactivee;
    return enabled
      ? { enabled, mode: config.mode }
      : { enabled, mode: config.mode, message: GED_AI_DISABLED_MESSAGE };
  }

  async run<T>(opts: AiRunOptions<T>): Promise<AiRunResult<T>> {
    const config = await this.settings.getEffective();
    if (config.mode === GedAiMode.Desactivee) {
      return { disabled: true, message: GED_AI_DISABLED_MESSAGE };
    }
    const cloud = config.mode === GedAiMode.Cloud;
    const mode: 1 | 2 = cloud ? 2 : 1;
    const attachments = opts.request.attachments ?? [];

    if (cloud) {
      this.assertCloudMasking(config);
      // Un binaire ne peut pas être masqué : jamais envoyé tel quel au cloud, sans exception.
      if (attachments.length > 0) {
        throw new AiMaskingRequiredError(
          'Envoi cloud refusé : une pièce jointe binaire ne peut pas être masquée.',
        );
      }
    } else if (attachments.length > 0 && config.maskingEnabled && opts.allowLocalAttachments !== true) {
      throw new AiMaskingRequiredError(
        'Envoi de la pièce jointe refusé : le masquage est actif et un binaire ne peut pas être masqué. ' +
          'L’appelant doit demander explicitement l’envoi local (allowLocalAttachments).',
      );
    }

    const masked = await this.masking.mask(opts.request.text, {
      cloud,
      maskingEnabled: config.maskingEnabled,
    });
    const request: AiCompletionRequest = { ...opts.request, text: masked.text };
    const attachmentHashes = attachments.map((a) => createHash('sha256').update(a.data).digest('hex'));

    // Une configuration inexploitable est détectée avant tout appel : rien à journaliser.
    // Délai effectif : le plancher de l'appelant ne peut qu'allonger le délai configuré.
    const effective: AiEffectiveConfig = {
      ...config,
      timeoutSeconds: Math.max(config.timeoutSeconds, opts.minTimeoutSeconds ?? 0),
    };
    const provider = createProvider(effective, this.providerDeps);

    const startedAt = Date.now();
    const journalBase = {
      task: opts.task,
      mode,
      provider: provider.name,
      model: provider.model,
      promptVersion: opts.promptVersion ?? null,
      inputText: masked.text,
      attachmentHashes,
      // Vrai seulement si le texte est masqué ET qu'aucun binaire (non masquable) ne part.
      inputMasked: masked.masked && attachments.length === 0,
      documentId: opts.documentId ?? null,
      sourceItemId: opts.sourceItemId ?? null,
      requestedBy: opts.requestedBy ?? null,
    };

    let completion;
    try {
      completion = await provider.complete(request);
    } catch (e) {
      // Aucun appel n'a eu lieu : pas de journal.
      if (e instanceof AiMaskingRequiredError || e instanceof AiUnsupportedInputError) throw e;
      const error = e instanceof AiProviderError ? e : new AiProviderError('Échec de l’appel au fournisseur IA.');
      await this.recordError(journalBase, error.message, Date.now() - startedAt);
      throw error;
    }

    let data: T;
    let confidence: number | null;
    try {
      data = opts.parse(completion.text);
      confidence = clampConfidence(opts.confidence ? opts.confidence(data) : null);
    } catch (e) {
      // Le message d'une erreur de parse peut citer la réponse du modèle : on n'en journalise que le type.
      const kind = e instanceof Error ? e.name : 'Error';
      await this.recordError(
        { ...journalBase, model: completion.model },
        `Réponse du modèle inexploitable (${kind}).`,
        Date.now() - startedAt,
      );
      throw e;
    }

    const status = decideAiStatus(confidence, config.autoApplyThreshold, opts.autoApply !== false);
    const durationMs = Date.now() - startedAt;

    let decisionId: bigint | null = null;
    try {
      decisionId = await this.decisions.record({
        ...journalBase,
        model: completion.model,
        output: data,
        confidence,
        status,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        durationMs,
      });
    } catch (e) {
      // Le journal ne doit jamais faire échouer un appel qui a réussi.
      this.logger.warn(
        `Écriture du journal IA impossible (${e instanceof Error ? e.name : 'erreur inconnue'}).`,
      );
    }

    return {
      disabled: false,
      data,
      decisionId,
      status,
      confidence,
      provider: provider.name,
      model: completion.model,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
    };
  }

  async embed(texts: string[]): Promise<AiEmbedResult> {
    const config = await this.settings.getEffective();
    if (config.mode === GedAiMode.Desactivee) {
      return { disabled: true, message: GED_AI_DISABLED_MESSAGE };
    }
    const cloud = config.mode === GedAiMode.Cloud;
    if (cloud) this.assertCloudMasking(config);

    const maskedTexts: string[] = [];
    for (const text of texts) {
      const m = await this.masking.mask(text, { cloud, maskingEnabled: config.maskingEnabled });
      maskedTexts.push(m.text);
    }

    const provider: AiModelProvider = createProvider(config, this.providerDeps);
    const vectors = await provider.embed(maskedTexts);
    if (
      vectors.length !== maskedTexts.length ||
      vectors.some((v) => v.length !== GED_EMBEDDING_DIMENSION)
    ) {
      throw new AiProviderError(
        `Embeddings invalides : ${GED_EMBEDDING_DIMENSION} composantes attendues par vecteur.`,
      );
    }
    return {
      disabled: false,
      vectors,
      model:
        config.embeddingModel ??
        (cloud ? GED_AI_DEFAULT_CLOUD_EMBEDDING_MODEL : GED_AI_DEFAULT_LOCAL_EMBEDDING_MODEL),
      dimension: GED_EMBEDDING_DIMENSION,
    };
  }

  /** En cloud le masquage n'est pas optionnel : réglage coupé = refus, sans appel. */
  private assertCloudMasking(config: AiEffectiveConfig): void {
    if (!config.maskingEnabled) {
      throw new AiMaskingRequiredError('Envoi cloud refusé : le masquage des données est désactivé.');
    }
  }

  /** Décision « Erreur » : sortie nulle, message sans clé ni contenu. Un échec du journal n'aggrave pas l'erreur. */
  private async recordError(
    base: {
      task: AiRunOptions<unknown>['task'];
      mode: 1 | 2;
      provider: string;
      model: string;
      promptVersion: string | null;
      inputText: string;
      attachmentHashes: string[];
      inputMasked: boolean;
      documentId: number | null;
      sourceItemId: number | null;
      requestedBy: number | null;
    },
    message: string,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.decisions.record({
        ...base,
        output: null,
        confidence: null,
        status: GedAiDecisionStatus.Erreur,
        durationMs,
        errorMessage: message.slice(0, ERROR_MESSAGE_MAX),
      });
    } catch (e) {
      this.logger.warn(
        `Écriture du journal IA impossible (${e instanceof Error ? e.name : 'erreur inconnue'}).`,
      );
    }
  }
}
