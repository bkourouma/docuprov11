import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ASST_PROPOSAL_TRANSITIONS,
  ASST_PROPOSAL_TTL_MINUTES,
  ASST_RETENTION_DAYS,
  ASST_SUMMARY_MAX_CHARS,
  AsstMessageRole,
  AsstProposalStatus,
  asstProposedActionsSchema,
  type AsstConversationDto,
  type AsstMessageDto,
  type AsstPageContext,
  type AsstProposalDto,
} from '@archivage/types';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AsstNewMessage,
  AsstNewProposal,
  AsstProposalStore,
  AsstProposalTransition,
} from '../assistant.contracts';
import { asstArgsHash } from './asst-proposal-hash';
import {
  parseAsstId,
  toConversationDto,
  toMessageDto,
  toProposalDto,
} from './asst-store.mappers';

const DAY_MS = 86_400_000;
/** Marge de tolérance sur l'échéance maximale d'une proposition (écart d'horloge entre l'appelant et `now`). */
const EXPIRY_MARGIN_MS = 1_000;
/** Plafond de `ck_asst_message_content`. */
const MESSAGE_CONTENT_MAX = 20_000;
const DIGITS = /^\d{1,18}$/;

/**
 * Magasin Prisma de l'assistant (conversations, messages, propositions). Mêmes sémantiques que l'implémentation en
 * mémoire (`testing/in-memory-proposal-store.ts`) : propriété par `userId` partout (objet d'un autre ou identifiant
 * mal formé -> `null`/`false`, jamais d'exception), échange masqué introuvable, compare-and-set sur la transition.
 * Les violations de CHECK ou de déclencheur PostgreSQL remontent TELLES QUELLES (contrat attendu par l'exécuteur).
 */
@Injectable()
export class AsstProposalStoreService implements AsstProposalStore {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  async createConversation(input: {
    userId: number;
    userGroupId: number;
    title?: string | null;
    pageContext?: AsstPageContext | null;
    now: Date;
  }): Promise<AsstConversationDto> {
    const row = await this.prisma.asstConversation.create({
      data: {
        userId: input.userId,
        userGroupId: input.userGroupId,
        title: input.title ?? null,
        ...(input.pageContext ? { pageContext: input.pageContext as unknown as Prisma.InputJsonValue } : {}),
        createdAt: input.now,
        updatedAt: input.now,
        lastMessageAt: input.now,
        purgeAt: new Date(input.now.getTime() + ASST_RETENTION_DAYS * DAY_MS),
      },
    });
    return toConversationDto(row, 0);
  }

  async listConversations(
    userId: number,
    opts: { limit: number; offset: number },
  ): Promise<{ items: AsstConversationDto[]; total: number }> {
    const where = { userId, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.asstConversation.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { asstConversationId: 'desc' }],
        skip: Math.max(0, opts.offset),
        take: Math.max(0, opts.limit),
        include: { _count: { select: { messages: true } } },
      }),
      this.prisma.asstConversation.count({ where }),
    ]);
    return { items: rows.map((r) => toConversationDto(r, r._count.messages)), total };
  }

  async getConversation(
    userId: number,
    conversationId: string,
  ): Promise<{ conversation: AsstConversationDto; messages: AsstMessageDto[] } | null> {
    const id = parseAsstId(conversationId);
    if (id === null) return null;
    const row = await this.prisma.asstConversation.findFirst({
      where: { asstConversationId: id, userId, deletedAt: null },
      include: {
        messages: {
          orderBy: { position: 'asc' },
          include: { proposals: { orderBy: { asstProposalId: 'asc' } } },
        },
      },
    });
    if (!row) return null;
    return {
      conversation: toConversationDto(row, row.messages.length),
      messages: row.messages.map((m) => toMessageDto(m, m.proposals)),
    };
  }

  async deleteConversation(userId: number, conversationId: string, now: Date): Promise<boolean> {
    const id = parseAsstId(conversationId);
    if (id === null) return false;
    // Un seul UPDATE conditionnel : masquage immédiat, purge échue.
    const { count } = await this.prisma.asstConversation.updateMany({
      where: { asstConversationId: id, userId, deletedAt: null },
      data: { deletedAt: now, purgeAt: now, updatedAt: now },
    });
    return count > 0;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async appendMessage(userId: number, input: AsstNewMessage, now: Date): Promise<AsstMessageDto | null> {
    if (input.role !== AsstMessageRole.User && input.role !== AsstMessageRole.Assistant) {
      throw new Error('asst_message : rôle invalide');
    }
    if (input.content.trim() === '' || input.content.length > MESSAGE_CONTENT_MAX) {
      throw new Error('asst_message : contenu vide ou supérieur à 20 000 caractères');
    }
    const isAssistant = input.role === AsstMessageRole.Assistant;
    const promptTokens = isAssistant ? (input.promptTokens ?? null) : null;
    const completionTokens = isAssistant ? (input.completionTokens ?? null) : null;
    const aiDecision = isAssistant ? (input.aiDecisionId ?? null) : null;
    if (
      (promptTokens !== null && (!Number.isInteger(promptTokens) || promptTokens < 0)) ||
      (completionTokens !== null && (!Number.isInteger(completionTokens) || completionTokens < 0))
    ) {
      throw new Error('asst_message : jetons invalides (entiers positifs ou nuls attendus)');
    }
    if (aiDecision !== null && !DIGITS.test(aiDecision)) {
      throw new Error('asst_message : identifiant de décision IA invalide');
    }
    const conversationId = parseAsstId(input.conversationId);
    if (conversationId === null) return null;

    return this.prisma.$transaction(async (tx) => {
      // Verrou de ligne : sérialise les ajouts concurrents sur le même échange (positions consécutives).
      const locked = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT "asst_conversation_id" AS id FROM "asst_conversation"
        WHERE "asst_conversation_id" = ${conversationId} AND "user_id" = ${userId} AND "deleted_at" IS NULL
        FOR UPDATE`;
      if (locked.length === 0) return null;
      const last = await tx.asstMessage.aggregate({ where: { conversationId }, _max: { position: true } });
      const row = await tx.asstMessage.create({
        data: {
          conversationId,
          role: input.role,
          content: input.content,
          position: (last._max.position ?? 0) + 1,
          promptTokens,
          completionTokens,
          aiDecisionId: aiDecision === null ? null : BigInt(aiDecision),
          createdAt: now,
        },
      });
      await tx.asstConversation.update({
        where: { asstConversationId: conversationId },
        data: { lastMessageAt: now, updatedAt: now },
      });
      return toMessageDto(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Propositions
  // ---------------------------------------------------------------------------

  async createProposal(input: AsstNewProposal, now: Date): Promise<AsstProposalDto> {
    const parsed = asstProposedActionsSchema.safeParse(input.actions);
    if (!parsed.success) {
      throw new Error(`asst_proposal : actions invalides (${parsed.error.issues.map((i) => i.message).join('; ')})`);
    }
    if (input.argsHash !== asstArgsHash(parsed.data)) {
      throw new Error('asst_proposal : argsHash différent du hash des actions');
    }
    if (input.summary.trim() === '' || input.summary.length > ASST_SUMMARY_MAX_CHARS) {
      throw new Error('asst_proposal : résumé vide ou trop long');
    }
    const maxExpiry = now.getTime() + ASST_PROPOSAL_TTL_MINUTES * 60_000 + EXPIRY_MARGIN_MS;
    if (input.expiresAt.getTime() <= now.getTime() || input.expiresAt.getTime() > maxExpiry) {
      throw new Error("asst_proposal : échéance hors de la fenêtre autorisée (postérieure à la création, durée de vie maximale respectée)");
    }
    const conversationId = parseAsstId(input.conversationId);
    const messageId = parseAsstId(input.messageId);
    if (conversationId === null || messageId === null) throw new Error('asst_proposal : identifiant invalide');

    const row = await this.prisma.asstProposal.create({
      data: {
        conversationId,
        messageId,
        userId: input.userId,
        userGroupId: input.userGroupId,
        status: AsstProposalStatus.Proposed,
        rowVersion: 0,
        actions: parsed.data as unknown as Prisma.InputJsonValue,
        summary: input.summary,
        argsHash: input.argsHash,
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now,
      },
    });
    return toProposalDto(row);
  }

  async getProposal(userId: number, proposalId: string): Promise<AsstProposalDto | null> {
    const row = await this.ownedProposal(userId, proposalId);
    return row ? toProposalDto(row) : null;
  }

  async getProposalActor(userId: number, proposalId: string): Promise<{ userId: number; userGroupId: number } | null> {
    const row = await this.ownedProposal(userId, proposalId);
    return row ? { userId: row.userId, userGroupId: row.userGroupId } : null;
  }

  /**
   * Compare-and-set : `updateMany` conditionnel sur le statut ET `row_version` attendus. Écrit dans `t.db`
   * (transaction de l'exécuteur) s'il est fourni. `null` si la condition ne correspond plus. Une violation de CHECK
   * ou de déclencheur LÈVE l'erreur PostgreSQL telle quelle.
   */
  async transitionProposal(t: AsstProposalTransition): Promise<AsstProposalDto | null> {
    const allowed = ASST_PROPOSAL_TRANSITIONS[t.expectedStatus];
    if (!allowed || !allowed.includes(t.to)) {
      throw new Error(`asst_proposal : transition de statut illégale (${String(t.expectedStatus)} -> ${String(t.to)})`);
    }
    const id = parseAsstId(t.proposalId);
    if (id === null) return null;
    const db: Prisma.TransactionClient = (t.db as Prisma.TransactionClient | undefined) ?? this.prisma;

    const data: Prisma.AsstProposalUpdateManyMutationInput = {
      status: t.to,
      rowVersion: { increment: 1 },
      updatedAt: t.now,
    };
    if (t.to === AsstProposalStatus.Confirmed) data.confirmedAt = t.now;
    else data.finishedAt = t.now;
    if (t.to === AsstProposalStatus.Applied && t.result !== undefined) {
      data.result = t.result as unknown as Prisma.InputJsonValue;
    }
    if (t.to === AsstProposalStatus.Failed) {
      data.errorCode = t.errorCode ?? null;
      data.errorMessage = t.errorMessage ?? null;
    }
    const { count } = await db.asstProposal.updateMany({
      where: { asstProposalId: id, status: t.expectedStatus, rowVersion: t.expectedRowVersion },
      data,
    });
    if (count === 0) return null;
    const row = await db.asstProposal.findUnique({ where: { asstProposalId: id } });
    return row ? toProposalDto(row) : null;
  }

  async listExpirableProposals(now: Date, limit: number): Promise<AsstProposalDto[]> {
    // Sans filtre de visibilité : le job clôture aussi les propositions d'un échange masqué.
    const rows = await this.prisma.asstProposal.findMany({
      where: { status: AsstProposalStatus.Proposed, expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { asstProposalId: 'asc' }],
      take: Math.max(0, limit),
    });
    return rows.map(toProposalDto);
  }

  async listStaleConfirmedProposals(before: Date, limit: number): Promise<AsstProposalDto[]> {
    const rows = await this.prisma.asstProposal.findMany({
      where: { status: AsstProposalStatus.Confirmed, confirmedAt: { lt: before } },
      orderBy: [{ confirmedAt: 'asc' }, { asstProposalId: 'asc' }],
      take: Math.max(0, limit),
    });
    return rows.map(toProposalDto);
  }

  // ---------------------------------------------------------------------------
  // Internes
  // ---------------------------------------------------------------------------

  /** Proposition de l'utilisateur dont l'échange n'est pas masqué ; sinon `null`. */
  private async ownedProposal(userId: number, proposalId: string) {
    const id = parseAsstId(proposalId);
    if (id === null) return null;
    return this.prisma.asstProposal.findFirst({
      where: { asstProposalId: id, userId, conversation: { deletedAt: null } },
    });
  }
}
