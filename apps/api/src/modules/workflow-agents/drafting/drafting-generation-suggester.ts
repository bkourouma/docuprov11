import { Inject, Injectable, Logger } from '@nestjs/common';
import { gedDraftRequestSchema, type GedDraftRequest } from '@archivage/types';
import { DraftingService } from '../../drafting/drafting.service';
import type { WfGenerationSuggester, WfGenerationSuggestion } from '../../workflows/extension/generation-suggester';
import {
  WF_AGENT_GATE,
  WF_AGENT_IDENTITY,
  type AgentReservation,
  type AgentUsage,
  type WfAgentGate,
  type WfAgentIdentityPort,
} from '../agent.contracts';

/** Estimation réservée avant l'appel (jetons), réglée à l'identique ensuite : l'usage réel n'est pas exposé. */
const ESTIMATE_PROMPT_TOKENS = 4000;
const ESTIMATE_COMPLETION_TOKENS = 3000;

/** Erreur claire (sans contenu) : l'exécuteur de génération laisse alors la tâche à l'humain. */
export class DraftingSuggestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftingSuggestionError';
  }
}

type SuggestInput = Parameters<WfGenerationSuggester['suggest']>[0];

/**
 * Suggestion de rédaction pour une étape 'generation' : appelle la rédaction assistée existante avec les
 * droits du LANCEUR. Le résultat est TOUJOURS une proposition (kind 1) relue par un humain.
 * Les paramètres viennent du contexte de l'instance (écrit par le concepteur/le lanceur), jamais d'un
 * contenu de document. Aucun contenu ni identifiant interne dans les logs.
 */
@Injectable()
export class DraftingGenerationSuggester implements WfGenerationSuggester {
  private readonly logger = new Logger(DraftingGenerationSuggester.name);

  constructor(
    private readonly drafting: DraftingService,
    @Inject(WF_AGENT_IDENTITY) private readonly identity: WfAgentIdentityPort,
    @Inject(WF_AGENT_GATE) private readonly gate: WfAgentGate,
  ) {}

  async suggest(input: SuggestInput): Promise<WfGenerationSuggestion> {
    // (1) Droits du lanceur, relus en base ; toute erreur remonte (tâche laissée à l'humain).
    const identity = await this.identity.resolve(input.runAs.userGroupId);

    // (2) Paramètres lus dans le contexte de l'instance.
    const dto = this.readRequest(input.context);

    // (3) Garde puis réservation.
    if (typeof input.definitionId !== 'number' || !Number.isInteger(input.definitionId) || input.definitionId <= 0) {
      throw new DraftingSuggestionError('Définition du workflow inconnue : suggestion de rédaction impossible');
    }
    const scope = { definitionId: input.definitionId };
    await this.gate.assertRunnable(scope);
    const estimate: AgentUsage = {
      promptTokens: ESTIMATE_PROMPT_TOKENS,
      completionTokens: ESTIMATE_COMPLETION_TOKENS,
      cost: this.gate.costOf({ promptTokens: ESTIMATE_PROMPT_TOKENS, completionTokens: ESTIMATE_COMPLETION_TOKENS }),
    };
    const reservation = await this.gate.reserve(scope, estimate);

    // (4) Génération avec l'identité du lanceur uniquement.
    let res;
    try {
      res = await this.drafting.generate(dto, identity.user);
    } catch (err) {
      await this.releaseQuietly(reservation);
      throw err;
    }

    if (res.disabled) {
      await this.releaseQuietly(reservation);
      throw new DraftingSuggestionError('Rédaction assistée désactivée : tâche laissée à l’humain');
    }

    try {
      await this.gate.settle(reservation, estimate);
    } catch (err) {
      // Le brouillon est produit ; un échec de règlement ne doit pas le perdre (journal sans contenu).
      this.logger.warn(`règlement du budget en échec : ${err instanceof Error ? err.name : 'erreur'}`);
    }

    const sources = (dto.contextDocumentIds ?? []).map((id) => ({ kind: 'document' as const, id }));
    return {
      content: res.draftText,
      explanation: `Brouillon généré par l'IA à partir de ${this.describeSources(res.contextDocumentCount)} (à relire)`,
      sources,
      confidence: undefined,
    };
  }

  private describeSources(count: number): string {
    if (count <= 0) return 'la consigne et du modèle choisi';
    return `la consigne, du modèle choisi et de ${count} document${count > 1 ? 's' : ''} de contexte`;
  }

  private readRequest(context: Readonly<Record<string, unknown>>): GedDraftRequest {
    const raw = context.input;
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (typeof input.templateId !== 'string' || input.templateId === '') {
      throw new DraftingSuggestionError('Modèle de rédaction manquant dans le contexte (templateId)');
    }
    if (typeof input.instruction !== 'string' || input.instruction.trim() === '') {
      throw new DraftingSuggestionError('Consigne de rédaction manquante dans le contexte (instruction)');
    }
    const candidate: Record<string, unknown> = { templateId: input.templateId, instruction: input.instruction };
    if (input.contextDocumentIds !== undefined && input.contextDocumentIds !== null) {
      candidate.contextDocumentIds = input.contextDocumentIds;
    }
    if (input.dossierId !== undefined && input.dossierId !== null) candidate.dossierId = input.dossierId;
    const parsed = gedDraftRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new DraftingSuggestionError('Paramètres de rédaction invalides dans le contexte');
    }
    return parsed.data;
  }

  private async releaseQuietly(reservation: AgentReservation): Promise<void> {
    try {
      await this.gate.release(reservation);
    } catch (err) {
      this.logger.warn(`libération de la réservation en échec : ${err instanceof Error ? err.name : 'erreur'}`);
    }
  }
}
