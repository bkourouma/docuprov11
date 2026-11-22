import type { Prisma } from '@prisma/client';
import {
  asstPageContextSchema,
  type AsstConversationDto,
  type AsstMessageDto,
  type AsstMessageRole,
  type AsstPageContext,
  type AsstProposalDto,
  type AsstProposalResultDto,
  type AsstProposalStatus,
  type AsstProposedAction,
} from '@archivage/types';

// Conversions lignes Prisma <-> DTO du magasin de l'assistant. Identifiants BigInt exposés en chaîne, dates en
// ISO 8601 UTC. Aucun jeton ni identifiant de décision IA n'est exposé.

/** Ligne `asst_conversation` (champs lus par les conversions). */
export interface AsstConversationRow {
  asstConversationId: bigint;
  title: string | null;
  pageContext: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  purgeAt: Date;
}

/** Ligne `asst_message` (champs lus par les conversions). */
export interface AsstMessageRow {
  asstMessageId: bigint;
  conversationId: bigint;
  role: number;
  content: string;
  position: number;
  createdAt: Date;
}

/** Ligne `asst_proposal` (champs lus par les conversions). */
export interface AsstProposalRow {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Contexte de page relu par le schéma zod ; invalide ou absent -> `null`. */
export function pageContextFromJson(value: unknown): AsstPageContext | null {
  if (value === null || value === undefined) return null;
  const parsed = asstPageContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Actions relues telles que stockées : contrôle MINIMAL de forme (tableau d'objets portant un `tool` texte), sans
 * reparse complet. Une forme inattendue donne un tableau vide : l'exécuteur recalcule le hash et refuse (échec fermé).
 */
export function actionsFromJson(value: unknown): AsstProposedAction[] {
  if (!Array.isArray(value)) return [];
  const ok = value.every((a) => isRecord(a) && typeof a.tool === 'string');
  return ok ? (value as unknown as AsstProposedAction[]) : [];
}

/** Résultat d'exécution : objet portant un tableau `effects` ; sinon `null`. */
export function resultFromJson(value: unknown): AsstProposalResultDto | null {
  if (!isRecord(value) || !Array.isArray(value.effects)) return null;
  return value as unknown as AsstProposalResultDto;
}

export function toConversationDto(row: AsstConversationRow, messageCount: number): AsstConversationDto {
  return {
    conversationId: String(row.asstConversationId),
    title: row.title,
    pageContext: pageContextFromJson(row.pageContext),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    purgeAt: row.purgeAt.toISOString(),
    messageCount,
  };
}

export function toProposalDto(row: AsstProposalRow): AsstProposalDto {
  return {
    proposalId: String(row.asstProposalId),
    conversationId: String(row.conversationId),
    messageId: String(row.messageId),
    status: row.status as AsstProposalStatus,
    actions: actionsFromJson(row.actions),
    summary: row.summary,
    argsHash: row.argsHash,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    result: resultFromJson(row.result),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    rowVersion: row.rowVersion,
  };
}

export function toMessageDto(row: AsstMessageRow, proposals: readonly AsstProposalRow[] = []): AsstMessageDto {
  return {
    messageId: String(row.asstMessageId),
    conversationId: String(row.conversationId),
    role: row.role as AsstMessageRole,
    content: row.content,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    proposals: proposals.map(toProposalDto),
  };
}

/** Identifiant exposé (1 à 18 chiffres) -> BigInt ; `null` si la forme est invalide (jamais d'exception). */
export function parseAsstId(id: unknown): bigint | null {
  return typeof id === 'string' && /^\d{1,18}$/.test(id) ? BigInt(id) : null;
}
