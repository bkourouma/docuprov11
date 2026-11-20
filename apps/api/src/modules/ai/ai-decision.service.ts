import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type GedAiDecision } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  buildDocumentPatch,
  buildInputExcerpt,
  GED_GOVERNANCE_PROMPT_VERSION,
  GedAiDecisionStatus,
  type GedAiTask,
} from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { AiDecisionRecordInput } from './ai.types';
import { AI_DECISION_MAX_PAGE_SIZE, type ListAiDecisionsQuery } from './ai-decision.dto';

const DEFAULT_PAGE_SIZE = 25;

/** Décision sérialisable en JSON : identifiants BigInt en chaîne, score Decimal en nombre. */
export interface AiDecisionView {
  id: string;
  documentId: number | null;
  sourceItemId: string | null;
  task: number;
  mode: number;
  provider: string | null;
  model: string;
  promptVersion: string | null;
  inputExcerpt: string | null;
  inputHash: string | null;
  inputMasked: boolean;
  output: unknown;
  confidence: number | null;
  status: number;
  validatedBy: number | null;
  validatedAt: Date | null;
  requestedBy: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface AiDecisionPage {
  items: AiDecisionView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Journal des décisions de l'IA (`ged_ai_decision`, append-only) et leur revue humaine.
 *
 * Le texte d'entrée n'est JAMAIS conservé en entier : seulement un extrait tronqué (déjà masqué
 * par l'appelant) et son empreinte SHA-256, qui prouve ce qui a été soumis sans le stocker.
 */
@Injectable()
export class AiDecisionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Écrit une ligne de journal et renvoie son identifiant. */
  async record(input: AiDecisionRecordInput): Promise<bigint> {
    const hash = createHash('sha256')
      .update(`${input.inputText}\n${[...(input.attachmentHashes ?? [])].sort().join('\n')}`)
      .digest('hex');

    const row = await this.prisma.gedAiDecision.create({
      data: {
        documentId: input.documentId ?? null,
        sourceItemId: input.sourceItemId != null ? BigInt(input.sourceItemId) : null,
        task: input.task,
        mode: input.mode,
        provider: input.provider,
        model: input.model,
        promptVersion: input.promptVersion ?? null,
        inputExcerpt: buildInputExcerpt(input.inputText),
        inputHash: hash,
        inputMasked: input.inputMasked,
        output:
          input.output === undefined || input.output === null
            ? Prisma.JsonNull
            : (input.output as Prisma.InputJsonValue),
        confidence: input.confidence,
        status: input.status,
        requestedBy: input.requestedBy ?? null,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        durationMs: input.durationMs ?? null,
        errorMessage: input.errorMessage ?? null,
      },
      select: { gedAiDecisionId: true },
    });
    return row.gedAiDecisionId;
  }

  async list(query: ListAiDecisionsQuery): Promise<AiDecisionPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(AI_DECISION_MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));
    const where: Prisma.GedAiDecisionWhereInput = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.task !== undefined ? { task: query.task } : {}),
      ...(query.documentId !== undefined ? { documentId: query.documentId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.gedAiDecision.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { gedAiDecisionId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.gedAiDecision.count({ where }),
    ]);
    return { items: rows.map(toView), total, page, pageSize };
  }

  async get(id: number): Promise<AiDecisionView> {
    const row = await this.prisma.gedAiDecision.findUnique({ where: { gedAiDecisionId: BigInt(id) } });
    if (!row) throw new NotFoundException('Décision IA introuvable');
    return toView(row);
  }

  /** Validation humaine : la décision passe à « validée » et son patch est appliqué au document. */
  validate(id: number, actor: AuthUser): Promise<AiDecisionView> {
    return this.review(id, actor, GedAiDecisionStatus.Validee);
  }

  /** Rejet humain : la décision passe à « rejetée », le document n'est pas touché. */
  reject(id: number, actor: AuthUser): Promise<AiDecisionView> {
    return this.review(id, actor, GedAiDecisionStatus.Rejetee);
  }

  /**
   * Revue d'une décision « proposée », en une transaction. Le changement de statut est
   * conditionné par `status = Proposee` dans l'écriture elle-même : deux revues simultanées ne
   * peuvent pas réussir toutes les deux (la seconde obtient 409).
   */
  private async review(
    id: number,
    actor: AuthUser,
    target: typeof GedAiDecisionStatus.Validee | typeof GedAiDecisionStatus.Rejetee,
  ): Promise<AiDecisionView> {
    const decisionId = BigInt(id);
    await this.prisma.$transaction(async (tx) => {
      const decision = await tx.gedAiDecision.findUnique({ where: { gedAiDecisionId: decisionId } });
      if (!decision) throw new NotFoundException('Décision IA introuvable');
      // Les décisions de gouvernance ont leur propre circuit (droits, confirmation, effets) : on
      // refuse ici, avant toute écriture.
      if (decision.promptVersion === GED_GOVERNANCE_PROMPT_VERSION) {
        throw new ConflictException(
          "Cette décision relève du module Gouvernance : utilisez l'écran Gouvernance.",
        );
      }
      if (decision.status !== GedAiDecisionStatus.Proposee) {
        throw new ConflictException('Seule une décision proposée peut être validée ou rejetée.');
      }

      const claimed = await tx.gedAiDecision.updateMany({
        where: { gedAiDecisionId: decisionId, status: GedAiDecisionStatus.Proposee },
        data: { status: target, validatedBy: actor.userGroupId, validatedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new ConflictException('Cette décision vient d\'être traitée par un autre utilisateur.');
      }

      if (target === GedAiDecisionStatus.Validee && decision.documentId !== null) {
        await this.applyPatch(tx, decision.documentId, decision.task as GedAiTask, decision.output);
      }
    });
    return this.get(id);
  }

  /**
   * Applique le patch IA en ne remplissant QUE les champs encore vides : une condition
   * `champ IS NULL` par champ, jamais d'écrasement d'une saisie humaine.
   */
  private async applyPatch(
    tx: Prisma.TransactionClient,
    documentId: number,
    task: GedAiTask,
    output: unknown,
  ): Promise<void> {
    const patch = buildDocumentPatch(task, output);
    if (patch.documentTypeId !== undefined) {
      await tx.document.updateMany({
        where: { documentId, documentTypeId: null },
        data: { documentTypeId: patch.documentTypeId },
      });
    }
    if (patch.documentDate !== undefined) {
      await tx.document.updateMany({
        where: { documentId, documentDate: null },
        data: { documentDate: new Date(`${patch.documentDate}T00:00:00Z`) },
      });
    }
    if (patch.overview !== undefined) {
      await tx.document.updateMany({
        where: { documentId, overview: null },
        data: { overview: patch.overview },
      });
    }
  }
}

function toView(row: GedAiDecision): AiDecisionView {
  return {
    id: row.gedAiDecisionId.toString(),
    documentId: row.documentId,
    sourceItemId: row.sourceItemId !== null ? row.sourceItemId.toString() : null,
    task: row.task,
    mode: row.mode,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    inputExcerpt: row.inputExcerpt,
    inputHash: row.inputHash,
    inputMasked: row.inputMasked,
    output: row.output,
    confidence: row.confidence !== null ? row.confidence.toNumber() : null,
    status: row.status,
    validatedBy: row.validatedBy,
    validatedAt: row.validatedAt,
    requestedBy: row.requestedBy,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    durationMs: row.durationMs,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  };
}
