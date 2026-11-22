import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ASST_RETENTION_DAYS,
  AsstProposalStatus,
  type AsstConversationDto,
  type AsstMessageDto,
  type AsstMessageRole,
  type AsstPageContext,
  type AsstProposalDto,
  type AsstProposalResultDto,
  type AsstProposedAction,
} from '@archivage/types';
import type {
  AsstNewMessage,
  AsstNewProposal,
  AsstProposalStore,
  AsstProposalTransition,
} from '../../assistant.contracts';

// Magasin Prisma MINIMAL, réservé aux TESTS d'intégration de l'exécuteur (lot A2). Le vrai magasin est écrit par le
// lot A1 : celui-ci n'implémente que ce dont l'exécuteur et sa suite ont besoin ; le reste lève une erreur.
// Aucune autre garde que celles de la base (CHECK et déclencheur `asst_proposal_guard`) : c'est le but du test.

const DAY_MS = 86_400_000;
const NOT_USED = 'non utilisé en test';

/** Client de lecture/écriture : le client Prisma ou un client transactionnel. */
type Db = PrismaClient | Prisma.TransactionClient;

/** Identifiant exposé (chaîne de chiffres) -> BigInt ; `null` si la forme est invalide. */
function parseId(id: string): bigint | null {
  return typeof id === 'string' && /^\d{1,18}$/.test(id) ? BigInt(id) : null;
}

export class PrismaTestProposalStore implements AsstProposalStore {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------------------------------------------------------------------------
  // Conversations et messages (utilisés par la mise en place des tests)
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
    return {
      conversationId: String(row.asstConversationId),
      title: row.title,
      pageContext: (row.pageContext as AsstPageContext | null) ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastMessageAt: row.lastMessageAt.toISOString(),
      purgeAt: row.purgeAt.toISOString(),
      messageCount: 0,
    };
  }

  async appendMessage(userId: number, input: AsstNewMessage, now: Date): Promise<AsstMessageDto | null> {
    const conversationId = parseId(input.conversationId);
    if (conversationId === null) return null;
    const conversation = await this.prisma.asstConversation.findFirst({
      where: { asstConversationId: conversationId, userId, deletedAt: null },
      select: { asstConversationId: true },
    });
    if (!conversation) return null;
    const last = await this.prisma.asstMessage.aggregate({ where: { conversationId }, _max: { position: true } });
    const row = await this.prisma.asstMessage.create({
      data: {
        conversationId,
        role: input.role,
        content: input.content,
        position: (last._max.position ?? 0) + 1,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        aiDecisionId: input.aiDecisionId ? BigInt(input.aiDecisionId) : null,
        createdAt: now,
      },
    });
    return {
      messageId: String(row.asstMessageId),
      conversationId: String(row.conversationId),
      role: row.role as AsstMessageRole,
      content: row.content,
      position: row.position,
      createdAt: row.createdAt.toISOString(),
      proposals: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Propositions
  // ---------------------------------------------------------------------------

  async createProposal(input: AsstNewProposal, now: Date): Promise<AsstProposalDto> {
    const conversationId = parseId(input.conversationId);
    const messageId = parseId(input.messageId);
    if (conversationId === null || messageId === null) throw new Error('asst_proposal : identifiant invalide');
    const row = await this.prisma.asstProposal.create({
      data: {
        conversationId,
        messageId,
        userId: input.userId,
        userGroupId: input.userGroupId,
        actions: input.actions as unknown as Prisma.InputJsonValue,
        summary: input.summary,
        argsHash: input.argsHash,
        expiresAt: input.expiresAt,
        // `created_at` explicite : un test peut ainsi créer une proposition DÉJÀ échue (expires_at > created_at).
        createdAt: now,
        updatedAt: now,
      },
    });
    return this.toDto(row);
  }

  async getProposal(userId: number, proposalId: string): Promise<AsstProposalDto | null> {
    const row = await this.ownedRow(this.prisma, userId, proposalId);
    return row ? this.toDto(row) : null;
  }

  async getProposalActor(userId: number, proposalId: string): Promise<{ userId: number; userGroupId: number } | null> {
    const row = await this.ownedRow(this.prisma, userId, proposalId);
    return row ? { userId: row.userId, userGroupId: row.userGroupId } : null;
  }

  /**
   * UPDATE conditionnel (compare-and-set sur statut ET `row_version`). Écrit dans `t.db` (transaction de
   * l'exécuteur) quand il est fourni, sinon via le client. `null` si la condition ne correspond plus. Une violation
   * de CHECK ou du déclencheur LÈVE l'erreur PostgreSQL telle quelle.
   */
  async transitionProposal(t: AsstProposalTransition): Promise<AsstProposalDto | null> {
    const id = parseId(t.proposalId);
    if (id === null) return null;
    const db: Db = (t.db as Prisma.TransactionClient | undefined) ?? this.prisma;
    const data: Prisma.AsstProposalUpdateManyMutationInput = {
      status: t.to,
      rowVersion: { increment: 1 },
      updatedAt: t.now,
    };
    if (t.to === AsstProposalStatus.Confirmed) data.confirmedAt = t.now;
    else data.finishedAt = t.now;
    if (t.to === AsstProposalStatus.Applied && t.result !== undefined) {
      data.result = t.result as AsstProposalResultDto as unknown as Prisma.InputJsonValue;
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
    return row ? this.toDto(row) : null;
  }

  async listExpirableProposals(now: Date, limit: number): Promise<AsstProposalDto[]> {
    const rows = await this.prisma.asstProposal.findMany({
      where: { status: AsstProposalStatus.Proposed, expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { asstProposalId: 'asc' }],
      take: Math.max(0, limit),
    });
    return rows.map((r) => this.toDto(r));
  }

  async listStaleConfirmedProposals(before: Date, limit: number): Promise<AsstProposalDto[]> {
    const rows = await this.prisma.asstProposal.findMany({
      where: { status: AsstProposalStatus.Confirmed, confirmedAt: { lt: before } },
      orderBy: [{ confirmedAt: 'asc' }, { asstProposalId: 'asc' }],
      take: Math.max(0, limit),
    });
    return rows.map((r) => this.toDto(r));
  }

  // ---------------------------------------------------------------------------
  // Non utilisés en test
  // ---------------------------------------------------------------------------

  listConversations(_userId: number, _opts: { limit: number; offset: number }): Promise<{ items: AsstConversationDto[]; total: number }> {
    return Promise.reject(new Error(`listConversations : ${NOT_USED}`));
  }

  getConversation(_userId: number, _conversationId: string): Promise<{ conversation: AsstConversationDto; messages: AsstMessageDto[] } | null> {
    return Promise.reject(new Error(`getConversation : ${NOT_USED}`));
  }

  deleteConversation(_userId: number, _conversationId: string, _now: Date): Promise<boolean> {
    return Promise.reject(new Error(`deleteConversation : ${NOT_USED}`));
  }

  // ---------------------------------------------------------------------------
  // Internes
  // ---------------------------------------------------------------------------

  /** Proposition de l'utilisateur dont la conversation n'est pas masquée ; sinon `null`. */
  private async ownedRow(db: Db, userId: number, proposalId: string) {
    const id = parseId(proposalId);
    if (id === null) return null;
    return db.asstProposal.findFirst({
      where: { asstProposalId: id, userId, conversation: { deletedAt: null } },
    });
  }

  private toDto(row: {
    asstProposalId: bigint;
    conversationId: bigint;
    messageId: bigint;
    status: number;
    actions: Prisma.JsonValue;
    summary: string;
    argsHash: string;
    expiresAt: Date;
    createdAt: Date;
    confirmedAt: Date | null;
    finishedAt: Date | null;
    result: Prisma.JsonValue | null;
    errorCode: string | null;
    errorMessage: string | null;
    rowVersion: number;
  }): AsstProposalDto {
    return {
      proposalId: String(row.asstProposalId),
      conversationId: String(row.conversationId),
      messageId: String(row.messageId),
      status: row.status as AsstProposalStatus,
      actions: row.actions as unknown as AsstProposedAction[],
      summary: row.summary,
      argsHash: row.argsHash,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      result: (row.result as AsstProposalResultDto | null) ?? null,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      rowVersion: row.rowVersion,
    };
  }
}
