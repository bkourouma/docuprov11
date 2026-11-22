import { createHash } from 'node:crypto';
import {
  ASST_RETENTION_DAYS,
  ASST_SUMMARY_MAX_CHARS,
  AsstMessageRole,
  AsstProposalStatus,
  asstCanonicalActionsJson,
  asstProposedActionsSchema,
  isAsstProposalTerminal,
  isAsstProposalTransitionAllowed,
  type AsstConversationDto,
  type AsstMessageDto,
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
} from '../assistant.contracts';

/** SHA-256 hexadécimal du JSON canonique des actions (même calcul que l'API : `argsHash`). */
export function sha256Actions(actions: AsstProposedAction[]): string {
  return createHash('sha256').update(asstCanonicalActionsJson(actions), 'utf8').digest('hex');
}

const DAY_MS = 86_400_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^[a-z0-9_.]+$/;
/** Plafond de `ck_asst_message_content`. */
const MESSAGE_CONTENT_DB_MAX = 20_000;

interface ConversationRow {
  id: number;
  userId: number;
  userGroupId: number;
  title: string | null;
  pageContext: AsstPageContext | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  purgeAt: Date;
  deletedAt: Date | null;
}

interface MessageRow {
  id: number;
  conversationId: number;
  role: AsstMessageRole;
  content: string;
  position: number;
  promptTokens: number | null;
  completionTokens: number | null;
  aiDecisionId: string | null;
  createdAt: Date;
}

interface ProposalRow {
  id: number;
  conversationId: number;
  messageId: number;
  userId: number;
  userGroupId: number;
  status: AsstProposalStatus;
  actions: AsstProposedAction[];
  summary: string;
  argsHash: string;
  expiresAt: Date;
  createdAt: Date;
  confirmedAt: Date | null;
  finishedAt: Date | null;
  result: AsstProposalResultDto | null;
  errorCode: string | null;
  errorMessage: string | null;
  rowVersion: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Identifiant exposé (chaîne de chiffres) -> entier interne ; `null` si la forme est invalide. */
function parseId(id: string): number | null {
  return typeof id === 'string' && /^\d{1,15}$/.test(id) ? Number(id) : null;
}

/**
 * Implémentation EN MÉMOIRE de `AsstProposalStore` (tests des lots suivants). Mêmes sémantiques que
 * l'implémentation Prisma : propriété par `userId` partout (objet d'un autre -> `null`/`false`), conversation masquée
 * invisible, CAS sur `rowVersion` + statut, et mêmes règles que le déclencheur SQL `asst_proposal_guard`
 * (une violation LÈVE une `Error`, comme la base lèverait une exception).
 */
export class InMemoryProposalStore implements AsstProposalStore {
  private readonly conversations = new Map<number, ConversationRow>();
  private readonly messages = new Map<number, MessageRow>();
  private readonly proposals = new Map<number, ProposalRow>();
  private seqConversation = 0;
  private seqMessage = 0;
  private seqProposal = 0;

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
    const title = input.title ?? null;
    if (title !== null && title.trim() === '') {
      throw new Error('asst_conversation : titre vide refusé (ck_asst_conversation_title)');
    }
    const id = ++this.seqConversation;
    const row: ConversationRow = {
      id,
      userId: input.userId,
      userGroupId: input.userGroupId,
      title,
      pageContext: input.pageContext ? clone(input.pageContext) : null,
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
      lastMessageAt: new Date(input.now),
      purgeAt: new Date(input.now.getTime() + ASST_RETENTION_DAYS * DAY_MS),
      deletedAt: null,
    };
    this.conversations.set(id, row);
    return this.conversationDto(row);
  }

  async listConversations(
    userId: number,
    opts: { limit: number; offset: number },
  ): Promise<{ items: AsstConversationDto[]; total: number }> {
    const visible = [...this.conversations.values()]
      .filter((c) => c.userId === userId && c.deletedAt === null)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id - a.id);
    return {
      items: visible.slice(opts.offset, opts.offset + opts.limit).map((c) => this.conversationDto(c)),
      total: visible.length,
    };
  }

  async getConversation(
    userId: number,
    conversationId: string,
  ): Promise<{ conversation: AsstConversationDto; messages: AsstMessageDto[] } | null> {
    const conv = this.ownedConversation(userId, conversationId);
    if (!conv) return null;
    const messages = [...this.messages.values()]
      .filter((m) => m.conversationId === conv.id)
      .sort((a, b) => a.position - b.position)
      .map((m) => this.messageDto(m));
    return { conversation: this.conversationDto(conv), messages };
  }

  async deleteConversation(userId: number, conversationId: string, now: Date): Promise<boolean> {
    const conv = this.ownedConversation(userId, conversationId);
    if (!conv) return false;
    conv.deletedAt = new Date(now);
    // Trace d'exécution (proposition confirmée, appliquée ou en échec) : masquage SANS abaisser purge_at.
    const hasTrace = [...this.proposals.values()].some(
      (p) =>
        p.conversationId === conv.id &&
        (p.status === AsstProposalStatus.Confirmed ||
          p.status === AsstProposalStatus.Applied ||
          p.status === AsstProposalStatus.Failed),
    );
    if (!hasTrace) conv.purgeAt = new Date(now);
    conv.updatedAt = new Date(now);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async appendMessage(userId: number, input: AsstNewMessage, now: Date): Promise<AsstMessageDto | null> {
    const conv = this.ownedConversation(userId, input.conversationId);
    if (!conv) return null;
    if (input.content.trim() === '' || input.content.length > MESSAGE_CONTENT_DB_MAX) {
      throw new Error('asst_message : contenu vide ou trop long (ck_asst_message_content)');
    }
    const promptTokens = input.promptTokens ?? null;
    const completionTokens = input.completionTokens ?? null;
    const aiDecisionId = input.aiDecisionId ?? null;
    if ((promptTokens !== null && promptTokens < 0) || (completionTokens !== null && completionTokens < 0)) {
      throw new Error('asst_message : jetons négatifs refusés (ck_asst_message_tokens)');
    }
    if (
      input.role !== AsstMessageRole.Assistant &&
      (promptTokens !== null || completionTokens !== null || aiDecisionId !== null)
    ) {
      throw new Error('asst_message : seul un message assistant porte des jetons ou une décision IA');
    }
    const position =
      [...this.messages.values()].filter((m) => m.conversationId === conv.id).reduce((max, m) => Math.max(max, m.position), 0) + 1;
    const row: MessageRow = {
      id: ++this.seqMessage,
      conversationId: conv.id,
      role: input.role,
      content: input.content,
      position,
      promptTokens,
      completionTokens,
      aiDecisionId,
      createdAt: new Date(now),
    };
    this.messages.set(row.id, row);
    conv.updatedAt = new Date(now);
    conv.lastMessageAt = new Date(now);
    return this.messageDto(row);
  }

  async deleteMessage(userId: number, conversationId: string, messageId: string): Promise<boolean> {
    const conv = this.ownedConversation(userId, conversationId);
    const id = parseId(messageId);
    const row = id === null ? undefined : this.messages.get(id);
    if (!conv || !row || row.conversationId !== conv.id) return false;
    if ([...this.proposals.values()].some((p) => p.messageId === row.id)) return false;
    this.messages.delete(row.id);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Propositions
  // ---------------------------------------------------------------------------

  async createProposal(input: AsstNewProposal, now: Date): Promise<AsstProposalDto> {
    const conv = this.ownedConversation(input.userId, input.conversationId);
    if (!conv) throw new Error('asst_proposal : conversation introuvable ou appartenant à un autre utilisateur');
    const messageId = parseId(input.messageId);
    const message = messageId === null ? undefined : this.messages.get(messageId);
    if (!message || message.conversationId !== conv.id) {
      throw new Error('asst_proposal : message introuvable dans cette conversation');
    }
    const parsed = asstProposedActionsSchema.safeParse(input.actions);
    if (!parsed.success) {
      throw new Error(`asst_proposal : actions invalides (${parsed.error.issues.map((i) => i.message).join('; ')})`);
    }
    if (!SHA256_HEX.test(input.argsHash)) {
      throw new Error('asst_proposal : argsHash doit être un SHA-256 hexadécimal minuscule (ck_asst_proposal_args_hash)');
    }
    if (input.summary.trim() === '' || input.summary.length > ASST_SUMMARY_MAX_CHARS) {
      throw new Error('asst_proposal : résumé vide ou trop long (ck_asst_proposal_summary)');
    }
    if (input.expiresAt.getTime() <= now.getTime()) {
      throw new Error('asst_proposal : expires_at doit être postérieur à created_at (ck_asst_proposal_expiry)');
    }
    const row: ProposalRow = {
      id: ++this.seqProposal,
      conversationId: conv.id,
      messageId: message.id,
      userId: input.userId,
      userGroupId: input.userGroupId,
      status: AsstProposalStatus.Proposed,
      actions: clone(parsed.data),
      summary: input.summary,
      argsHash: input.argsHash,
      expiresAt: new Date(input.expiresAt),
      createdAt: new Date(now),
      confirmedAt: null,
      finishedAt: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      rowVersion: 0,
    };
    this.proposals.set(row.id, row);
    return this.proposalDto(row);
  }

  async getProposal(userId: number, proposalId: string): Promise<AsstProposalDto | null> {
    const id = parseId(proposalId);
    const row = id === null ? undefined : this.proposals.get(id);
    if (!row || row.userId !== userId) return null;
    const conv = this.conversations.get(row.conversationId);
    if (!conv || conv.deletedAt !== null) return null;
    return this.proposalDto(row);
  }

  async transitionProposal(t: AsstProposalTransition): Promise<AsstProposalDto | null> {
    const id = parseId(t.proposalId);
    const row = id === null ? undefined : this.proposals.get(id);
    // Compare-and-set : introuvable, statut ou version différents de ceux attendus -> null (aucune écriture).
    if (!row || row.status !== t.expectedStatus || row.rowVersion !== t.expectedRowVersion) return null;

    // --- Règles de asst_proposal_guard (levée d'erreur, comme l'exception SQL) ---
    const from = row.status;
    const to = t.to;
    if (isAsstProposalTerminal(from)) {
      throw new Error(`asst_proposal ${row.id} : proposition clôturée (statut ${from}) : figée`);
    }
    if (!isAsstProposalTransitionAllowed(from, to)) {
      throw new Error(`asst_proposal ${row.id} : transition de statut illégale (${from} -> ${to})`);
    }
    if (from === AsstProposalStatus.Proposed && to === AsstProposalStatus.Confirmed && row.expiresAt.getTime() <= t.now.getTime()) {
      throw new Error(`asst_proposal ${row.id} : proposition expirée, confirmation refusée`);
    }
    if (from === AsstProposalStatus.Proposed && to === AsstProposalStatus.Expired && row.expiresAt.getTime() > t.now.getTime()) {
      throw new Error(`asst_proposal ${row.id} : proposition non échue, expiration refusée`);
    }

    // --- Contraintes CHECK sur le résultat / l'erreur ---
    if (t.result !== undefined && to !== AsstProposalStatus.Applied) {
      throw new Error('asst_proposal : result réservé au statut Appliquée (ck_asst_proposal_result)');
    }
    if (to === AsstProposalStatus.Failed) {
      if (t.errorCode === undefined || !ERROR_CODE.test(t.errorCode)) {
        throw new Error('asst_proposal : errorCode (^[a-z0-9_.]+$) obligatoire pour le statut Échec (ck_asst_proposal_error)');
      }
    } else if (t.errorCode !== undefined || t.errorMessage !== undefined) {
      throw new Error('asst_proposal : errorCode / errorMessage réservés au statut Échec (ck_asst_proposal_error)');
    }

    row.status = to;
    row.rowVersion += 1;
    if (to === AsstProposalStatus.Confirmed) row.confirmedAt = new Date(t.now);
    if (to !== AsstProposalStatus.Confirmed) row.finishedAt = new Date(t.now);
    if (to === AsstProposalStatus.Applied) row.result = t.result ? clone(t.result) : null;
    if (to === AsstProposalStatus.Failed) {
      row.errorCode = t.errorCode ?? null;
      row.errorMessage = t.errorMessage ?? null;
    }
    return this.proposalDto(row);
  }

  async listExpirableProposals(now: Date, limit: number): Promise<AsstProposalDto[]> {
    // Volontairement sans filtre sur la visibilité de la conversation : le job doit clôturer aussi les
    // propositions d'un échange masqué (elles ne doivent pas rester ouvertes).
    return [...this.proposals.values()]
      .filter((p) => p.status === AsstProposalStatus.Proposed && p.expiresAt.getTime() <= now.getTime())
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id - b.id)
      .slice(0, Math.max(0, limit))
      .map((p) => this.proposalDto(p));
  }

  /** Ajout A2 : propositions « confirmées » depuis avant `before` (balayage des exécutions interrompues). */
  async listStaleConfirmedProposals(before: Date, limit: number): Promise<AsstProposalDto[]> {
    return [...this.proposals.values()]
      .filter((p) => p.status === AsstProposalStatus.Confirmed && p.confirmedAt !== null && p.confirmedAt.getTime() < before.getTime())
      .sort((a, b) => (a.confirmedAt?.getTime() ?? 0) - (b.confirmedAt?.getTime() ?? 0) || a.id - b.id)
      .slice(0, Math.max(0, limit))
      .map((p) => this.proposalDto(p));
  }

  /** Ajout A2 : acteur propriétaire (même règle de visibilité que `getProposal`). */
  async getProposalActor(userId: number, proposalId: string): Promise<{ userId: number; userGroupId: number } | null> {
    const id = parseId(proposalId);
    const row = id === null ? undefined : this.proposals.get(id);
    if (!row || row.userId !== userId) return null;
    const conv = this.conversations.get(row.conversationId);
    if (!conv || conv.deletedAt !== null) return null;
    return { userId: row.userId, userGroupId: row.userGroupId };
  }

  /** Observation de test : échéance de purge d'un échange (même masqué) ; `null` si l'échange n'existe pas. */
  peekPurgeAt(conversationId: string): Date | null {
    const id = parseId(conversationId);
    const conv = id === null ? undefined : this.conversations.get(id);
    return conv ? new Date(conv.purgeAt) : null;
  }

  // ---------------------------------------------------------------------------
  // Internes
  // ---------------------------------------------------------------------------

  /** Conversation visible de l'utilisateur (existante, non masquée, à lui) ; sinon `undefined`. */
  private ownedConversation(userId: number, conversationId: string): ConversationRow | undefined {
    const id = parseId(conversationId);
    const conv = id === null ? undefined : this.conversations.get(id);
    return conv && conv.userId === userId && conv.deletedAt === null ? conv : undefined;
  }

  private conversationDto(c: ConversationRow): AsstConversationDto {
    let messageCount = 0;
    for (const m of this.messages.values()) if (m.conversationId === c.id) messageCount += 1;
    return {
      conversationId: String(c.id),
      title: c.title,
      pageContext: c.pageContext ? clone(c.pageContext) : null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      lastMessageAt: c.lastMessageAt.toISOString(),
      purgeAt: c.purgeAt.toISOString(),
      messageCount,
    };
  }

  private messageDto(m: MessageRow): AsstMessageDto {
    return {
      messageId: String(m.id),
      conversationId: String(m.conversationId),
      role: m.role,
      content: m.content,
      position: m.position,
      createdAt: m.createdAt.toISOString(),
      proposals: [...this.proposals.values()]
        .filter((p) => p.messageId === m.id)
        .sort((a, b) => a.id - b.id)
        .map((p) => this.proposalDto(p)),
    };
  }

  private proposalDto(p: ProposalRow): AsstProposalDto {
    return {
      proposalId: String(p.id),
      conversationId: String(p.conversationId),
      messageId: String(p.messageId),
      status: p.status,
      actions: clone(p.actions),
      summary: p.summary,
      argsHash: p.argsHash,
      expiresAt: p.expiresAt.toISOString(),
      createdAt: p.createdAt.toISOString(),
      confirmedAt: p.confirmedAt ? p.confirmedAt.toISOString() : null,
      finishedAt: p.finishedAt ? p.finishedAt.toISOString() : null,
      result: p.result ? clone(p.result) : null,
      errorCode: p.errorCode,
      errorMessage: p.errorMessage,
      rowVersion: p.rowVersion,
    };
  }
}
