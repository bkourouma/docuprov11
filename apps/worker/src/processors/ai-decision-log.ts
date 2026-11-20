// Socle IA — journal `ged_ai_decision` (append-only). On ne conserve JAMAIS le texte complet :
// extrait tronqué du texte MASQUÉ envoyé + son empreinte SHA-256.
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildInputExcerpt, type GedAiDecisionStatus, type GedAiTask } from '@archivage/types';

export interface DecisionLogEntry {
  documentId: number;
  sourceItemId?: number | null;
  task: GedAiTask;
  /** Mode FIGÉ au moment de l'appel (le paramétrage peut changer ensuite) : 1 locale, 2 cloud. */
  mode: 1 | 2;
  provider: string | null;
  model: string;
  promptVersion: string;
  /** Texte masqué effectivement envoyé ; `null` si rien n'a été envoyé (masquage refusé). */
  sentText: string | null;
  inputMasked: boolean;
  output: unknown;
  confidence: number | null;
  status: GedAiDecisionStatus;
  requestedBy?: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  errorMessage: string | null;
}

/** Empreinte SHA-256 hexadécimale du texte masqué envoyé. */
export function hashSentText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function buildDecisionData(e: DecisionLogEntry): Prisma.GedAiDecisionUncheckedCreateInput {
  return {
    documentId: e.documentId,
    sourceItemId: e.sourceItemId != null ? BigInt(e.sourceItemId) : null,
    task: e.task,
    mode: e.mode,
    provider: e.provider,
    model: e.model,
    promptVersion: e.promptVersion,
    inputExcerpt: e.sentText !== null ? buildInputExcerpt(e.sentText) : null,
    inputHash: e.sentText !== null ? hashSentText(e.sentText) : null,
    inputMasked: e.inputMasked,
    ...(e.output !== null && e.output !== undefined
      ? { output: e.output as Prisma.InputJsonValue }
      : {}),
    confidence: e.confidence,
    status: e.status,
    requestedBy: e.requestedBy ?? null,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    durationMs: e.durationMs,
    errorMessage: e.errorMessage,
  };
}

/** Écrit une ligne de journal et renvoie son identifiant (BigInt sérialisé en chaîne). */
export async function writeAiDecision(
  prisma: Pick<PrismaClient, 'gedAiDecision'>,
  entry: DecisionLogEntry,
): Promise<string> {
  const row = await prisma.gedAiDecision.create({
    data: buildDecisionData(entry),
    select: { gedAiDecisionId: true },
  });
  return row.gedAiDecisionId.toString();
}
