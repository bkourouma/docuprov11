import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ASST_ASSISTANT_MESSAGE_MAX_CHARS,
  AsstMessageRole,
  type AsstConversationDto,
  type AsstMessageDto,
  type AsstPageContext,
  type AsstProposalDto,
} from '@archivage/types';
import {
  ASST_GATE,
  ASST_PLANNER,
  ASST_PROPOSAL_STORE,
  AsstError,
  type AsstConversationsPort,
  type AsstGatePort,
  type AsstIdentity,
  type AsstPlannerPort,
  type AsstProposalStore,
} from '../assistant.contracts';
import { parseClarificationContent } from '../planner/clarification-format';
import { PLANNER_HISTORY_MAX_MESSAGES } from '../planner/planner.types';
import { asstArgsHash, asstProposalExpiresAt } from '../store/asst-proposal-hash';
import { AsstMessageRateLimiter } from './asst-message-rate-limiter';

const notFound = (): AsstError => new AsstError('not_found', 'Échange introuvable.');

/**
 * Routes de conversation de l'assistant : orchestre magasin, porte de coût, planificateur et limiteur de débit.
 * Ne fait QUE proposer : aucune exécution d'effet, aucun appel à l'exécuteur. Tout objet d'un autre utilisateur
 * est traité comme inexistant (`not_found`).
 */
@Injectable()
export class AsstConversationsService implements AsstConversationsPort {
  /** Horloge surchargeable (tests). */
  now: () => Date = () => new Date();
  private readonly limiter: AsstMessageRateLimiter;

  constructor(
    @Inject(ASST_PROPOSAL_STORE) private readonly store: AsstProposalStore,
    @Inject(ASST_PLANNER) private readonly planner: AsstPlannerPort,
    @Inject(ASST_GATE) private readonly gate: AsstGatePort,
    @Optional() @Inject(AsstMessageRateLimiter) limiter?: AsstMessageRateLimiter,
  ) {
    this.limiter = limiter ?? new AsstMessageRateLimiter();
  }

  async create(
    identity: AsstIdentity,
    body: { title?: string; pageContext?: AsstPageContext },
  ): Promise<AsstConversationDto> {
    await this.gate.assertRunnable(identity.user.userId);
    return this.store.createConversation({
      userId: identity.user.userId,
      userGroupId: identity.principal.userGroupId,
      title: body.title ?? null,
      pageContext: body.pageContext ?? null,
      now: this.now(),
    });
  }

  list(
    identity: AsstIdentity,
    query: { limit: number; offset: number },
  ): Promise<{ items: AsstConversationDto[]; total: number }> {
    return this.store.listConversations(identity.user.userId, { limit: query.limit, offset: query.offset });
  }

  async detail(
    identity: AsstIdentity,
    conversationId: string,
  ): Promise<{ conversation: AsstConversationDto; messages: AsstMessageDto[] }> {
    const found = await this.store.getConversation(identity.user.userId, conversationId);
    if (!found) throw notFound();
    const messages = found.messages.map((m) => ({ ...m }));
    const last = messages[messages.length - 1];
    if (last && last.role === AsstMessageRole.Assistant && last.proposals.length === 0) {
      const clarification = parseClarificationContent(last.content);
      if (clarification) last.clarification = clarification;
    }
    return { conversation: found.conversation, messages };
  }

  async remove(identity: AsstIdentity, conversationId: string): Promise<void> {
    const done = await this.store.deleteConversation(identity.user.userId, conversationId, this.now());
    if (!done) throw notFound();
  }

  async postMessage(
    identity: AsstIdentity,
    conversationId: string,
    body: { content: string; pageContext?: AsstPageContext },
  ): Promise<{ conversation: AsstConversationDto; userMessage: AsstMessageDto; assistantMessage: AsstMessageDto }> {
    const userId = identity.user.userId;

    // (1) Limite de débit par utilisateur (par processus).
    const decision = this.limiter.tryConsume(userId);
    if (!decision.allowed) {
      throw new AsstError('budget_exceeded', 'Trop de messages en peu de temps : patientez quelques instants.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    // (2) Échange de l'utilisateur (sinon 404, sans appeler le planificateur).
    const found = await this.store.getConversation(userId, conversationId);
    if (!found) throw notFound();

    // (3) Historique borné, AVANT le nouveau message ; contexte de page du corps, sinon de l'échange.
    const history = found.messages.slice(-PLANNER_HISTORY_MAX_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
    const pageContext = body.pageContext ?? found.conversation.pageContext ?? null;

    // (4) Planification AVANT toute écriture : un échec ne laisse aucune trace et remonte tel quel.
    const plan = await this.planner.plan({ identity, conversationId, message: body.content, pageContext, history });
    const reply = plan.reply.slice(0, ASST_ASSISTANT_MESSAGE_MAX_CHARS);
    if (reply.trim() === '') {
      throw new AsstError('assistant_unavailable', 'L’assistant n’a pas pu répondre : réessayez dans un instant.');
    }
    const summary = plan.summary?.trim() ? plan.summary : null;
    if (plan.actions.length > 0 && summary === null) {
      // Échec fermé : une action sans résumé lisible ne peut pas être présentée à la confirmation.
      throw new AsstError('assistant_unavailable', 'L’assistant n’a pas pu préparer la proposition : réessayez dans un instant.');
    }

    // (5) Persistance : message utilisateur, message assistant, puis proposition éventuelle.
    const now = this.now();
    const userMessage = await this.store.appendMessage(
      userId,
      { conversationId, role: AsstMessageRole.User, content: body.content },
      now,
    );
    if (!userMessage) throw notFound();
    const assistantMessage = await this.store.appendMessage(
      userId,
      {
        conversationId,
        role: AsstMessageRole.Assistant,
        content: reply,
        promptTokens: plan.usage.promptTokens,
        completionTokens: plan.usage.completionTokens,
        aiDecisionId: plan.aiDecisionId ?? null,
      },
      now,
    );
    if (!assistantMessage) throw notFound();

    let proposals: AsstProposalDto[] = [];
    if (plan.actions.length > 0 && summary !== null) {
      const proposal = await this.store.createProposal(
        {
          conversationId,
          messageId: assistantMessage.messageId,
          userId,
          userGroupId: identity.principal.userGroupId,
          actions: plan.actions,
          summary,
          argsHash: asstArgsHash(plan.actions),
          expiresAt: asstProposalExpiresAt(now),
        },
        now,
      );
      proposals = [proposal];
    }

    // (6) Réponse : échange relu du magasin.
    const fresh = await this.store.getConversation(userId, conversationId);
    if (!fresh) throw notFound();
    const out: AsstMessageDto = { ...assistantMessage, proposals };
    if (plan.clarification) out.clarification = plan.clarification;
    return { conversation: fresh.conversation, userMessage, assistantMessage: out };
  }
}
