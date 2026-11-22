import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  GedAiMode,
  GedAiTask,
  WfDefinitionSource,
  WfDefinitionStatus,
  WfDefinitionVersionStatus,
  validateWorkflowGraph,
  wfGraphSchema,
  type WfAuthoringExplanation,
  type WfAuthoringGenerateResponse,
  type WfAuthoringIssue,
  type WfGraph,
  type WfGraphIssue,
} from '@archivage/types';
import { AiService } from '../ai/ai.service';
import { AiMaskingRequiredError, AiUnsupportedInputError, type AiRunResult } from '../ai/ai.types';
import { AiConfigurationError } from '../ai/ai-provider.factory';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  AgentBlockedError,
  WF_AGENT_GATE,
  type AgentReservation,
  type AgentUsage,
  type WfAgentGate,
} from '../workflow-agents/agent.contracts';
import { generateNonce, replaceAngles, sanitizeText, truncateSafe } from '../workflow-agents/injection/untrusted';
import { extractFigures } from './authoring.assumptions';
import {
  AUTHORING_ASSUMPTION_MAX_CHARS,
  AUTHORING_MAX_ASSUMPTIONS,
  AUTHORING_MAX_OUTPUT_TOKENS,
  AUTHORING_NAME_MAX,
  AUTHORING_SOURCE_PROMPT_MAX,
  AuthoringOutputError,
  WF_AUTHORING_PROMPT_VERSION,
  type AuthoringModelOutput,
  type AuthoringToolInfo,
  type GuardrailResult,
} from './authoring.contracts';
import type { GenerateAuthoringInput } from './authoring.dto';
import { explainGraph } from './authoring.explain';
import { applyGuardrails } from './authoring.guardrails';
import { parseAuthoringOutput } from './authoring.output';
import { buildAuthoringPrompt } from './authoring.prompt';
import { suggestTrigger } from './authoring.trigger';

// Docu-Flow W5 : génération d'un BROUILLON de workflow à partir d'une description en français.
// Rien n'est jamais publié, aucun déclencheur n'est créé, `isLowRisk` reste faux.

export const AUTHORING_MSG = {
  aiDisabled: 'IA désactivée pour ce client',
  emergencyStop: 'Arrêt d’urgence des agents actif : la génération est suspendue.',
  budgetExceeded: 'Budget IA atteint : génération refusée.',
  budgetUnavailable: 'Budget IA illisible : la génération est suspendue par prudence.',
  masking: 'Envoi refusé : le masquage des données est obligatoire pour ce mode d’IA.',
  provider: 'Le service d’IA n’a pas pu répondre. Réessayez plus tard.',
  unusable: 'Le brouillon généré est inutilisable : reformulez la description puis réessayez.',
  nameTaken: 'Un workflow non archivé porte déjà ce nom : reformulez la description.',
  notFound: 'Workflow introuvable.',
  forbidden: 'Action réservée à un utilisateur identifié.',
  reviewLine: 'Ce brouillon est à relire : rien n’est publié.',
} as const;

export const AUTHORING_FALLBACK_NAME = 'Workflow décrit en langage naturel';
const MAX_NAME_RETRIES = 5;
const MAX_REPAIR_ISSUES = 30;
const REPAIR_ISSUE_MAX_CHARS = 300;
const DEFINITION_DESCRIPTION_MAX = 4000;
const PARSE_FAILURE_ISSUE = 'La réponse précédente n’était pas un objet JSON conforme au format demandé.';

/** Échec typé : le résultat d'audit et la réponse HTTP sont décidés au même endroit. */
class AuthoringFailure extends Error {
  constructor(
    readonly outcome: string,
    readonly http: HttpException,
  ) {
    super(outcome);
    this.name = 'AuthoringFailure';
  }
}

interface RunStats {
  promptTokens: number;
  completionTokens: number;
  repairUsed: boolean;
  issuesCount: number;
  removed: GuardrailResult['removed'] | null;
}

interface Candidate {
  output: AuthoringModelOutput;
  guard: GuardrailResult;
  /** Graphe de forme valide (sinon `null`). */
  graph: WfGraph | null;
  issues: WfGraphIssue[];
  ok: boolean;
}

interface RepairInput {
  previousGraph: unknown;
  issues: string[];
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'erreur inconnue');

@Injectable()
export class AuthoringService {
  private readonly logger = new Logger(AuthoringService.name);

  /** Date courante (UTC) ; remplaçable en test. */
  now: () => Date = () => new Date();

  constructor(
    private readonly ai: AiService,
    @Inject(WF_AGENT_GATE) private readonly gate: WfAgentGate,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Génération
  // -------------------------------------------------------------------------------------------

  async generate(input: GenerateAuthoringInput, actor: AuthUser): Promise<WfAuthoringGenerateResponse> {
    const userGroupId = this.actorId(actor);
    const stats: RunStats = {
      promptTokens: 0,
      completionTokens: 0,
      repairUsed: false,
      issuesCount: 0,
      removed: null,
    };
    try {
      const response = await this.runGenerate(input, userGroupId, stats);
      stats.issuesCount = response.issues.length;
      await this.writeAudit(actor, `wf_authoring:definition:${response.definitionId}`, 'created', input, stats);
      return response;
    } catch (e) {
      if (e instanceof AuthoringFailure) {
        await this.writeAudit(actor, 'wf_authoring:generate', e.outcome, input, stats);
        throw e.http;
      }
      await this.writeAudit(actor, 'wf_authoring:generate', 'error', input, stats);
      throw e;
    }
  }

  private async runGenerate(
    input: GenerateAuthoringInput,
    userGroupId: number,
    stats: RunStats,
  ): Promise<WfAuthoringGenerateResponse> {
    // IA désactivée : refus AVANT la garde et sans rien écrire (hors audit).
    let mode: GedAiMode;
    try {
      mode = (await this.ai.getEffectiveConfig()).mode;
    } catch (e) {
      this.logger.warn(`Configuration IA illisible (${errorName(e)}).`);
      throw new AuthoringFailure('provider_error', new BadGatewayException(AUTHORING_MSG.provider));
    }
    if (mode === GedAiMode.Desactivee) {
      throw new AuthoringFailure('ai_disabled', new ConflictException(AUTHORING_MSG.aiDisabled));
    }

    const tools = await this.loadTools();
    const allowedTools = new Set(tools.map((t) => t.key));

    // Première génération, puis AU PLUS UNE réparation (nouvel appel complet, nouvelle garde, nouveau jeton).
    const first = await this.attempt(input, tools, allowedTools, userGroupId, stats, undefined);
    let last = first;

    if (!first?.ok) {
      stats.repairUsed = true;
      const repair: RepairInput = {
        previousGraph: first?.guard.graph ?? null,
        issues: first
          ? first.issues.slice(0, MAX_REPAIR_ISSUES).map((i) => truncateSafe(i.message, REPAIR_ISSUE_MAX_CHARS))
          : [PARSE_FAILURE_ISSUE],
      };
      last = await this.attempt(input, tools, allowedTools, userGroupId, stats, repair);
    }

    // Après la réparation, seule une FORME valide permet de créer le brouillon (la sémantique reste corrigeable).
    const best = last;
    if (!best?.graph) {
      const issues = (last?.issues ?? []).map(toIssue);
      stats.issuesCount = issues.length;
      stats.removed = last?.guard.removed ?? null;
      throw new AuthoringFailure(
        'invalid_output',
        new UnprocessableEntityException({ message: AUTHORING_MSG.unusable, code: 'AUTHORING_INVALID', issues }),
      );
    }
    stats.removed = best.guard.removed;

    const def = await this.createDraft(best, best.graph, input.description, userGroupId);
    const triggerSuggestion = suggestTrigger({
      description: input.description,
      triggerHint: input.triggerHint,
      modelTrigger: best.output.trigger,
    });
    return {
      definitionId: def.id,
      name: def.name,
      graph: best.graph,
      issues: best.issues.map(toIssue),
      assumptions: this.buildAssumptions(best, input.description),
      toComplete: best.guard.toComplete,
      triggerSuggestion,
    };
  }

  /**
   * Un appel complet : garde, réservation, appel, règlement, puis garde-fous et validation.
   * Renvoie `null` si la sortie du modèle n'est pas un objet exploitable.
   */
  private async attempt(
    input: GenerateAuthoringInput,
    tools: AuthoringToolInfo[],
    allowedTools: ReadonlySet<string>,
    userGroupId: number,
    stats: RunStats,
    repair: RepairInput | undefined,
  ): Promise<Candidate | null> {
    const request = buildAuthoringPrompt({
      nonce: generateNonce(),
      description: input.description,
      triggerHint: input.triggerHint,
      tools,
      ...(repair ? { repair } : {}),
    });

    // Estimation prudente : jetons ≈ caractères / 3 en entrée, plafond de sortie en complétion.
    // definitionId 0 : aucune ligne de budget de workflow n'existe pour une génération, donc seul le budget
    // GLOBAL est débité (voulu : une génération n'appartient à aucun workflow).
    const scope = { definitionId: 0 };
    let estimate: AgentUsage;
    let reservation: AgentReservation;
    try {
      await this.gate.assertRunnable(scope);
      const promptTokens = Math.ceil((request.system.length + request.text.length) / 3);
      const completionTokens = Math.max(AUTHORING_MAX_OUTPUT_TOKENS, request.maxOutputTokens);
      const cost = this.gate.costOf({ promptTokens, completionTokens });
      if (!Number.isFinite(cost) || cost < 0) {
        throw new AgentBlockedError('budget_unavailable', 'Coût illisible.');
      }
      estimate = { promptTokens, completionTokens, cost };
      reservation = await this.gate.reserve(scope, estimate);
    } catch (e) {
      throw this.mapGateError(e);
    }

    let raw: AiRunResult<AuthoringModelOutput>;
    try {
      // Requête construite champ par champ : jamais de pièce jointe binaire (`attachments`).
      raw = await this.ai.run<AuthoringModelOutput>({
        task: GedAiTask.Autre,
        request: {
          system: request.system,
          text: request.text,
          jsonSchema: request.jsonSchema,
          strictSchema: false,
          maxOutputTokens: request.maxOutputTokens,
        },
        parse: parseAuthoringOutput,
        promptVersion: WF_AUTHORING_PROMPT_VERSION,
        requestedBy: userGroupId,
        autoApply: false,
        documentId: null,
      });
    } catch (e) {
      if (e instanceof AiMaskingRequiredError) {
        await this.release(reservation); // refus avant tout appel au fournisseur
        throw new AuthoringFailure('masking_required', new ConflictException(AUTHORING_MSG.masking));
      }
      if (e instanceof AiUnsupportedInputError) {
        await this.release(reservation);
        throw new AuthoringFailure('provider_error', new BadGatewayException(AUTHORING_MSG.provider));
      }
      if (e instanceof AiConfigurationError) {
        // Configuration IA inexploitable : levée par `createProvider` AVANT tout appel au fournisseur, rien n'est consommé.
        await this.release(reservation);
        this.logger.warn(`Configuration IA inexploitable (${errorName(e)}).`);
        throw new AuthoringFailure('provider_error', new BadGatewayException(AUTHORING_MSG.provider));
      }
      // L'appel est parti (ou a pu partir) : le coût est engagé, on solde l'estimation (prudent).
      await this.settle(reservation, estimate, stats);
      if (e instanceof AuthoringOutputError) return null;
      this.logger.warn(`Appel au modèle en échec (${errorName(e)}).`);
      throw new AuthoringFailure('provider_error', new BadGatewayException(AUTHORING_MSG.provider));
    }

    if (raw.disabled) {
      await this.release(reservation);
      throw new AuthoringFailure('ai_disabled', new ConflictException(AUTHORING_MSG.aiDisabled));
    }
    await this.settle(reservation, this.actualUsage(raw) ?? estimate, stats);

    const guard = applyGuardrails(raw.data.graph, { allowedTools });
    const validation = validateWorkflowGraph(guard.graph, { isLowRisk: false });
    const shape = wfGraphSchema.safeParse(guard.graph);
    return {
      output: raw.data,
      guard,
      graph: shape.success ? shape.data : null,
      issues: validation.issues,
      ok: validation.ok && shape.success,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Explication d'un workflow existant (lecture seule)
  // -------------------------------------------------------------------------------------------

  async explain(definitionId: number, actor: AuthUser): Promise<WfAuthoringExplanation> {
    this.actorId(actor);
    const def = await this.prisma.wfDefinition.findUnique({ where: { wfDefinitionId: definitionId } });
    if (!def) throw new NotFoundException(AUTHORING_MSG.notFound);
    const versions = await this.prisma.wfDefinitionVersion.findMany({
      where: { definitionId },
      orderBy: { versionNumber: 'desc' },
    });
    const version = versions.find((v) => v.status === WfDefinitionVersionStatus.Draft) ?? versions[0];
    if (!version) throw new NotFoundException(AUTHORING_MSG.notFound);
    const parsed = wfGraphSchema.safeParse(version.graph);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        message: 'Le graphe de ce workflow est invalide : il ne peut pas être expliqué.',
        code: 'AUTHORING_INVALID',
      });
    }
    return explainGraph(parsed.data, { definitionId, versionNumber: version.versionNumber, name: def.name });
  }

  // -------------------------------------------------------------------------------------------
  // Outils, hypothèses, création
  // -------------------------------------------------------------------------------------------

  private async loadTools(): Promise<AuthoringToolInfo[]> {
    const rows = await this.prisma.wfTool.findMany({ where: { isEnabled: true } });
    return rows.map((r) => ({
      key: r.toolKey,
      label: r.label,
      description: r.description ?? null,
      sideEffect: (r.sideEffect === 1 || r.sideEffect === 2 ? r.sideEffect : 0) as 0 | 1 | 2,
    }));
  }

  private buildAssumptions(c: Candidate, description: string): string[] {
    const clean = (s: unknown): string =>
      truncateSafe(replaceAngles(sanitizeText(s)).replace(/\s+/g, ' ').trim(), AUTHORING_ASSUMPTION_MAX_CHARS);
    const out: string[] = [];
    const add = (s: unknown): void => {
      const line = clean(s);
      if (line && !out.includes(line)) out.push(line);
    };
    c.output.assumptions.slice(0, AUTHORING_MAX_ASSUMPTIONS).forEach(add);
    c.guard.notes.forEach(add);
    extractFigures(description).forEach(add);
    add(AUTHORING_MSG.reviewLine);
    return out;
  }

  private cleanName(raw: unknown): string {
    const line = replaceAngles(sanitizeText(raw)).replace(/\s+/g, ' ').trim();
    const name = truncateSafe(line, AUTHORING_NAME_MAX);
    if (name) return name;
    return `${AUTHORING_FALLBACK_NAME} ${this.now().toISOString().slice(0, 10)}`;
  }

  /** Une seule création atomique (définition + version 1 en brouillon), comme `DefinitionsService.create`. */
  private async createDraft(
    c: Candidate,
    graph: WfGraph,
    description: string,
    userGroupId: number,
  ): Promise<{ id: number; name: string }> {
    const baseName = this.cleanName(c.output.name);
    const defDescription =
      truncateSafe(replaceAngles(sanitizeText(c.output.description)).trim(), DEFINITION_DESCRIPTION_MAX) || null;
    const sourcePrompt = truncateSafe(replaceAngles(sanitizeText(description)).trim(), AUTHORING_SOURCE_PROMPT_MAX);

    for (let n = 1; n <= MAX_NAME_RETRIES + 1; n++) {
      const suffix = n === 1 ? '' : ` (${n})`;
      const name = truncateSafe(baseName, AUTHORING_NAME_MAX - suffix.length) + suffix;
      try {
        const def = await this.prisma.wfDefinition.create({
          data: {
            name,
            description: defDescription,
            status: WfDefinitionStatus.Draft,
            source: WfDefinitionSource.NaturalLanguage,
            createdBy: userGroupId,
            versions: {
              create: {
                versionNumber: 1,
                status: WfDefinitionVersionStatus.Draft,
                graph: graph as unknown as Prisma.InputJsonValue,
                sourcePrompt,
                createdBy: userGroupId,
              },
            },
          },
        });
        return { id: def.wfDefinitionId, name: def.name };
      } catch (e) {
        if (isUniqueViolation(e)) continue;
        throw e;
      }
    }
    throw new AuthoringFailure('name_taken', new ConflictException(AUTHORING_MSG.nameTaken));
  }

  // -------------------------------------------------------------------------------------------
  // Garde (budget, arrêt d'urgence) : échec fermé
  // -------------------------------------------------------------------------------------------

  private mapGateError(e: unknown): AuthoringFailure {
    if (e instanceof AgentBlockedError) {
      switch (e.reason) {
        case 'ai_disabled':
          return new AuthoringFailure('ai_disabled', new ConflictException(AUTHORING_MSG.aiDisabled));
        case 'emergency_stop_global':
        case 'emergency_stop_workflow':
          return new AuthoringFailure(`blocked:${e.reason}`, new ConflictException(AUTHORING_MSG.emergencyStop));
        case 'budget_exceeded_global':
        case 'budget_exceeded_workflow':
          return new AuthoringFailure(
            `blocked:${e.reason}`,
            new HttpException(AUTHORING_MSG.budgetExceeded, HttpStatus.TOO_MANY_REQUESTS),
          );
        default:
          break;
      }
    } else {
      this.logger.warn(`Garde de budget en échec (${errorName(e)}).`);
    }
    // Toute erreur non typée est traitée comme un budget illisible : échec fermé.
    return new AuthoringFailure(
      'blocked:budget_unavailable',
      new ServiceUnavailableException(AUTHORING_MSG.budgetUnavailable),
    );
  }

  private actualUsage(result: object): AgentUsage | null {
    const r = result as { promptTokens?: unknown; completionTokens?: unknown };
    const p = r.promptTokens;
    const c = r.completionTokens;
    if (typeof p !== 'number' || typeof c !== 'number' || !Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) {
      return null;
    }
    try {
      const cost = this.gate.costOf({ promptTokens: p, completionTokens: c });
      return Number.isFinite(cost) && cost >= 0 ? { promptTokens: p, completionTokens: c, cost } : null;
    } catch {
      return null;
    }
  }

  private async settle(reservation: AgentReservation, usage: AgentUsage, stats: RunStats): Promise<void> {
    stats.promptTokens += usage.promptTokens;
    stats.completionTokens += usage.completionTokens;
    try {
      await this.gate.settle(reservation, usage);
    } catch (e) {
      // Le coût est déjà engagé : on ne fait pas échouer la génération.
      this.logger.error(`Règlement de la réservation en échec (${errorName(e)}).`);
    }
  }

  private async release(reservation: AgentReservation): Promise<void> {
    try {
      await this.gate.release(reservation);
    } catch (e) {
      this.logger.error(`Libération de la réservation en échec (${errorName(e)}).`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Audit (jamais bloquant, jamais de contenu)
  // -------------------------------------------------------------------------------------------

  private async writeAudit(
    actor: AuthUser,
    objectRef: string,
    outcome: string,
    input: GenerateAuthoringInput,
    stats: RunStats,
  ): Promise<void> {
    try {
      await this.audit.dataChange({
        userGroupId: actor.userGroupId,
        actorFullName: actor.fullName ?? actor.username,
        objectRef,
        newValue: JSON.stringify({
          outcome,
          descriptionLength: input.description.length,
          promptTokens: stats.promptTokens,
          completionTokens: stats.completionTokens,
          repairUsed: stats.repairUsed,
          issuesCount: stats.issuesCount,
          removed: stats.removed,
        }),
      });
    } catch (e) {
      this.logger.error(`audit wf_authoring en échec (${errorName(e)})`);
    }
  }

  private actorId(actor: AuthUser): number {
    if (actor.isScanAgent || actor.userGroupId === null || actor.userGroupId === undefined) {
      throw new ForbiddenException(AUTHORING_MSG.forbidden);
    }
    return actor.userGroupId;
  }
}

function toIssue(i: WfGraphIssue): WfAuthoringIssue {
  const out: WfAuthoringIssue = { code: i.code, message: i.message };
  if (i.stepKey !== undefined) out.stepKey = i.stepKey;
  if (i.path !== undefined) out.path = i.path;
  return out;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}
