import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma, WfEvalCase, WfEvalRun, WfEvalSet } from '@prisma/client';
import {
  WF_EVAL_ACCURACY_FLOOR,
  WfEvalRunStatus,
  type WfEvalCaseDto,
  type WfEvalRunDto,
  type WfEvalSetDto,
} from '@archivage/types';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { evalCasesHash } from '../../workflows/agent-spec-hash';
import { agentStepKeysOfRaw } from '../../workflows/definitions-agents';
import { AgentConfigLoader, type LoadedAgentConfig } from '../agent-config.loader';
import {
  AgentIdentityError,
  WF_AGENT_IDENTITY,
  WF_AGENT_RUNNER,
  type AgentIdentity,
  type AgentRunOutput,
  type AgentRunStopReason,
  type WfAgentIdentityPort,
  type WfAgentRunner,
} from '../agent.contracts';
import { decideDisposition } from '../disposition';
import {
  EVAL_CASE_MAX_BYTES,
  evalCaseByteSize,
  evalCaseInputSchema,
  evalExpectedSchema,
  matchesExpected,
  type EvalCaseInput,
} from './eval-expected';
import type {
  CreateEvalCaseInput,
  CreateEvalSetInput,
  RunEvalSetInput,
  UpdateEvalCaseInput,
  UpdateEvalSetInput,
} from './eval.dto';

// Docu-Flow (lot W2) — jeux d'évaluation des agents et exécution (« runs »). Un run rejoue les cas actifs d'un
// jeu en MODE SANS EFFET DE BORD (`dry_run`) sur une version précise du workflow, avec les droits de
// l'évaluateur. Seul un run TERMINÉ et RÉUSSI sur la version autorise l'autonomie (voir
// `AutonomyEligibilityService` et le déclencheur SQL).
//
// Règles : la précision est celle des CAS (passés / total), le poids n'est qu'indicatif ; un arrêt de budget,
// d'urgence, d'IA désactivée, de masquage requis ou d'erreur fournisseur interrompt le run (statut 2), jamais un
// « réussi » partiel ; aucun contenu de document dans `results`, les logs ou le journal d'audit.

export const EVAL_MAX_ACTIVE_CASES = 500;
const STALE_RUN_MS = 60 * 60 * 1000;
const DEFAULT_MIN_ACCURACY = 0.9;

/** Arrêts du runner qui INTERROMPENT le run (le cas ne peut pas être jugé). */
const INTERRUPTING_STOPS: ReadonlySet<AgentRunStopReason> = new Set<AgentRunStopReason>([
  'budget_exceeded_global',
  'budget_exceeded_workflow',
  'budget_unavailable',
  'emergency_stop_global',
  'emergency_stop_workflow',
  'ai_disabled',
  'masking_required',
  'provider_error',
  'aborted',
]);

const INTERRUPT_MESSAGES: Partial<Record<AgentRunStopReason, string>> = {
  budget_exceeded_global: 'Plafond de budget global atteint',
  budget_exceeded_workflow: 'Plafond de budget du workflow atteint',
  budget_unavailable: 'Budget illisible (échec fermé)',
  emergency_stop_global: 'Arrêt d’urgence global actif',
  emergency_stop_workflow: 'Arrêt d’urgence du workflow actif',
  ai_disabled: 'IA désactivée',
  masking_required: 'Masquage des données requis avant tout envoi au fournisseur IA',
  provider_error: 'Erreur du fournisseur IA',
  aborted: 'Exécution abandonnée',
};

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export function toEvalSetDto(row: WfEvalSet): WfEvalSetDto {
  return {
    wfEvalSetId: row.wfEvalSetId,
    definitionId: row.definitionId,
    stepKey: row.stepKey,
    name: row.name,
    description: row.description,
    minAccuracy: String(row.minAccuracy),
    isActive: row.isActive,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toEvalCaseDto(row: WfEvalCase): WfEvalCaseDto {
  return {
    wfEvalCaseId: row.wfEvalCaseId,
    evalSetId: row.evalSetId,
    label: row.label,
    input: row.input,
    expected: row.expected,
    weight: row.weight,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

export function toEvalRunDto(row: WfEvalRun, withResults = true): WfEvalRunDto {
  return {
    wfEvalRunId: String(row.wfEvalRunId),
    evalSetId: row.evalSetId,
    definitionVersionId: row.definitionVersionId,
    status: row.status as WfEvalRunStatus,
    totalCases: row.totalCases,
    passedCases: row.passedCases,
    accuracy: row.accuracy === null ? null : String(row.accuracy),
    requiredAccuracy: String(row.requiredAccuracy),
    passed: row.passed,
    model: row.model,
    results: withResults ? row.results : null,
    costAmount: row.costAmount === null ? null : String(row.costAmount),
    errorMessage: row.errorMessage,
    runBy: row.runBy,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/** Résultat d'un cas dans `wf_eval_run.results.cases` : jamais de contenu de document. */
export interface EvalCaseOutcome {
  caseId: number;
  passed: boolean;
  reason?: string;
  confidence: number | null;
  disposition: 'complete' | 'propose' | 'return_to_human' | 'invalid_case';
  stopReason?: string;
}

interface RunContext {
  run: WfEvalRun;
  config: LoadedAgentConfig;
  identity: AgentIdentity;
  cases: Pick<WfEvalCase, 'wfEvalCaseId' | 'input' | 'expected'>[];
  actor: AuthUser;
  actorId: number;
  requiredAccuracy: number;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class EvalService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EvalService.name);
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WF_AGENT_RUNNER) private readonly runner: WfAgentRunner,
    @Inject(WF_AGENT_IDENTITY) private readonly identity: WfAgentIdentityPort,
    private readonly loader: AgentConfigLoader,
    private readonly audit: AuditService,
  ) {}

  /** Au démarrage : clôture les runs restés « en cours » (processus arrêté). Ne bloque ni ne fait échouer le démarrage. */
  onApplicationBootstrap(): void {
    this.track(
      this.failStaleRuns().then(
        () => undefined,
        (err: unknown) => this.logger.error(`failStaleRuns en échec (${errName(err)})`),
      ),
    );
  }

  /** Attend la fin des exécutions en arrière-plan (tests, arrêt propre). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // =========================================================================================================
  // Jeux
  // =========================================================================================================

  async createSet(input: CreateEvalSetInput, actor: AuthUser): Promise<WfEvalSetDto> {
    const actorId = this.actorId(actor);
    const min = input.minAccuracy ?? DEFAULT_MIN_ACCURACY;
    this.assertFloor(min);
    const def = await this.prisma.wfDefinition.findUnique({
      where: { wfDefinitionId: input.definitionId },
      select: { wfDefinitionId: true },
    });
    if (!def) throw new NotFoundException('Workflow introuvable.');
    if (input.stepKey) await this.assertAgentStep(input.definitionId, input.stepKey);

    const row = await this.prisma.wfEvalSet.create({
      data: {
        definitionId: input.definitionId,
        stepKey: input.stepKey ?? null,
        name: input.name,
        description: input.description ?? null,
        minAccuracy: round3(min).toFixed(3),
        createdBy: actorId,
      },
    });
    await this.journal(actor, `wf_eval_set:${row.wfEvalSetId}`, undefined, setAudit(row));
    return toEvalSetDto(row);
  }

  async updateSet(setId: number, input: UpdateEvalSetInput, actor: AuthUser): Promise<WfEvalSetDto> {
    this.actorId(actor);
    const before = await this.findSet(setId);
    if (input.definitionId !== undefined && input.definitionId !== before.definitionId) {
      throw new UnprocessableEntityException('Le workflow d’un jeu ne change jamais.');
    }

    const data: Prisma.WfEvalSetUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;

    if (input.stepKey !== undefined) {
      if (input.stepKey !== null && input.stepKey !== before.stepKey) {
        await this.assertAgentStep(before.definitionId, input.stepKey);
      }
      data.stepKey = input.stepKey;
    }

    let needsAutonomyCheck = false;
    if (input.minAccuracy !== undefined) {
      this.assertFloor(input.minAccuracy);
      if (input.minAccuracy < Number(before.minAccuracy)) needsAutonomyCheck = true;
      data.minAccuracy = round3(input.minAccuracy).toFixed(3);
    }
    if (input.isActive !== undefined) {
      if (!input.isActive && before.isActive) needsAutonomyCheck = true;
      data.isActive = input.isActive;
    }
    if (needsAutonomyCheck && (await this.linkedAutonomousCount(setId)) > 0) {
      throw new ConflictException(
        'Ce jeu est lié à une étape autonome : son seuil ne peut pas être abaissé ni le jeu désactivé.',
      );
    }

    if (Object.keys(data).length === 0) return toEvalSetDto(before);
    const after = await this.prisma.wfEvalSet.update({ where: { wfEvalSetId: setId }, data });
    await this.journal(actor, `wf_eval_set:${setId}`, setAudit(before), setAudit(after));
    return toEvalSetDto(after);
  }

  async listSets(definitionId?: number): Promise<WfEvalSetDto[]> {
    const rows = await this.prisma.wfEvalSet.findMany({
      where: definitionId === undefined ? {} : { definitionId },
      orderBy: { wfEvalSetId: 'asc' },
    });
    return rows.map(toEvalSetDto);
  }

  async getSet(setId: number): Promise<WfEvalSetDto> {
    return toEvalSetDto(await this.findSet(setId));
  }

  // =========================================================================================================
  // Cas
  // =========================================================================================================

  async listCases(setId: number, includeInactive = false): Promise<WfEvalCaseDto[]> {
    await this.findSet(setId);
    const rows = await this.prisma.wfEvalCase.findMany({
      where: includeInactive ? { evalSetId: setId } : { evalSetId: setId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { wfEvalCaseId: 'asc' }],
    });
    return rows.map(toEvalCaseDto);
  }

  async addCase(setId: number, input: CreateEvalCaseInput, actor: AuthUser): Promise<WfEvalCaseDto> {
    this.actorId(actor);
    this.assertCaseContent(input.input, input.expected);
    await this.findSet(setId);
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockSet(tx, setId);
      const active = await tx.wfEvalCase.count({ where: { evalSetId: setId, isActive: true } });
      if (active >= EVAL_MAX_ACTIVE_CASES) throw capError();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const agg = await tx.wfEvalCase.aggregate({ where: { evalSetId: setId }, _max: { sortOrder: true } });
        sortOrder = (agg._max.sortOrder ?? 0) + 1;
      }
      return tx.wfEvalCase.create({
        data: {
          evalSetId: setId,
          label: input.label,
          input: input.input as Prisma.InputJsonValue,
          expected: input.expected as Prisma.InputJsonValue,
          weight: input.weight ?? 1,
          sortOrder,
        },
      });
    });
    await this.journal(actor, `wf_eval_case:${row.wfEvalCaseId}`, undefined, caseAudit(row));
    return toEvalCaseDto(row);
  }

  async updateCase(setId: number, caseId: number, input: UpdateEvalCaseInput, actor: AuthUser): Promise<WfEvalCaseDto> {
    this.actorId(actor);
    await this.findSet(setId);
    const { before, after } = await this.prisma.$transaction(async (tx) => {
      await this.lockSet(tx, setId);
      const existing = await tx.wfEvalCase.findFirst({ where: { wfEvalCaseId: caseId, evalSetId: setId } });
      if (!existing) throw new NotFoundException('Cas introuvable.');
      const nextInput = input.input ?? existing.input;
      const nextExpected = input.expected ?? existing.expected;
      if (input.input !== undefined || input.expected !== undefined) this.assertCaseContent(nextInput, nextExpected);
      if (input.isActive === true && !existing.isActive) {
        const active = await tx.wfEvalCase.count({ where: { evalSetId: setId, isActive: true } });
        if (active >= EVAL_MAX_ACTIVE_CASES) throw capError();
      }
      const data: Prisma.WfEvalCaseUncheckedUpdateInput = {};
      if (input.label !== undefined) data.label = input.label;
      if (input.input !== undefined) data.input = input.input as Prisma.InputJsonValue;
      if (input.expected !== undefined) data.expected = input.expected as Prisma.InputJsonValue;
      if (input.weight !== undefined) data.weight = input.weight;
      if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
      if (input.isActive !== undefined) data.isActive = input.isActive;
      if (Object.keys(data).length === 0) return { before: existing, after: existing };
      const updated = await tx.wfEvalCase.update({ where: { wfEvalCaseId: caseId }, data });
      return { before: existing, after: updated };
    });
    if (before !== after) await this.journal(actor, `wf_eval_case:${caseId}`, caseAudit(before), caseAudit(after));
    return toEvalCaseDto(after);
  }

  /** Supprimer = désactiver (les runs passés restent lisibles). Idempotent. */
  async removeCase(setId: number, caseId: number, actor: AuthUser): Promise<WfEvalCaseDto> {
    this.actorId(actor);
    await this.findSet(setId);
    const existing = await this.prisma.wfEvalCase.findFirst({ where: { wfEvalCaseId: caseId, evalSetId: setId } });
    if (!existing) throw new NotFoundException('Cas introuvable.');
    if (!existing.isActive) return toEvalCaseDto(existing);
    const after = await this.prisma.wfEvalCase.update({ where: { wfEvalCaseId: caseId }, data: { isActive: false } });
    await this.journal(actor, `wf_eval_case:${caseId}`, caseAudit(existing), caseAudit(after));
    return toEvalCaseDto(after);
  }

  // =========================================================================================================
  // Runs
  // =========================================================================================================

  /**
   * Crée le run (statut 0) et le renvoie IMMÉDIATEMENT ; l'exécution tourne en arrière-plan dans le processus.
   * `required_accuracy` = max(seuil du jeu, plancher), FIGÉ ici.
   */
  async runSet(setId: number, params: RunEvalSetInput, actor: AuthUser): Promise<WfEvalRunDto> {
    const actorId = this.actorId(actor);
    const set = await this.findSet(setId);
    if (!set.isActive) throw new UnprocessableEntityException('Ce jeu est désactivé : aucun run possible.');

    const versionId = await this.resolveVersion(set, params.definitionVersionId);

    if (set.stepKey && params.stepKey && params.stepKey !== set.stepKey) {
      throw new UnprocessableEntityException('Ce jeu est lié à une autre étape que celle demandée.');
    }
    const stepKey = set.stepKey ?? params.stepKey;
    if (!stepKey) throw new UnprocessableEntityException('Indiquez l’étape agent à évaluer.');
    const config = await this.loader.load(versionId, stepKey);
    if (!config) throw new UnprocessableEntityException('Cette étape n’est pas une étape agent de cette version.');

    const cases = await this.prisma.wfEvalCase.findMany({
      where: { evalSetId: setId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { wfEvalCaseId: 'asc' }],
      select: { wfEvalCaseId: true, input: true, expected: true },
    });
    if (cases.length === 0) {
      throw new UnprocessableEntityException('Aucun cas actif : un run exige au moins un cas (total_cases > 0).');
    }

    let identity: AgentIdentity;
    try {
      identity = await this.identity.resolve(actorId);
    } catch (err) {
      if (err instanceof AgentIdentityError) throw new ForbiddenException(err.message);
      throw err;
    }

    const requiredAccuracy = round3(Math.max(Number(set.minAccuracy), WF_EVAL_ACCURACY_FLOOR));
    const run = await this.prisma.wfEvalRun.create({
      data: {
        evalSetId: setId,
        definitionVersionId: versionId,
        status: WfEvalRunStatus.Running,
        totalCases: cases.length,
        requiredAccuracy: requiredAccuracy.toFixed(3),
        runBy: actorId,
      },
    });
    await this.journal(actor, `wf_eval_run:${run.wfEvalRunId}`, undefined, {
      status: run.status,
      evalSetId: setId,
      definitionVersionId: versionId,
      stepKey,
      totalCases: cases.length,
      requiredAccuracy,
    });

    this.track(this.execute({ run, config, identity, cases, actor, actorId, requiredAccuracy }));
    return toEvalRunDto(run);
  }

  async listRuns(setId: number): Promise<WfEvalRunDto[]> {
    await this.findSet(setId);
    const rows = await this.prisma.wfEvalRun.findMany({
      where: { evalSetId: setId },
      orderBy: { wfEvalRunId: 'desc' },
      take: 50,
    });
    // Liste allégée : le détail par cas n'est servi que par `getRun`.
    return rows.map((r) => toEvalRunDto(r, false));
  }

  async getRun(runId: string): Promise<WfEvalRunDto> {
    if (!/^[1-9]\d{0,17}$/.test(runId)) throw new NotFoundException('Run introuvable.');
    const row = await this.prisma.wfEvalRun.findUnique({ where: { wfEvalRunId: BigInt(runId) } });
    if (!row) throw new NotFoundException('Run introuvable.');
    return toEvalRunDto(row);
  }

  /** Passe en erreur (statut 2) les runs « en cours » depuis plus d'une heure. Renvoie leur nombre. */
  async failStaleRuns(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_RUN_MS);
    const res = await this.prisma.wfEvalRun.updateMany({
      where: { status: WfEvalRunStatus.Running, startedAt: { lt: cutoff } },
      data: {
        status: WfEvalRunStatus.Errored,
        passed: false,
        errorMessage: 'Run interrompu : resté en cours plus d’une heure (processus arrêté ou redémarré).',
        finishedAt: new Date(),
      },
    });
    if (res.count > 0) this.logger.warn(`${res.count} run(s) d'évaluation périmé(s) passé(s) en erreur`);
    return res.count;
  }

  // =========================================================================================================
  // Exécution en arrière-plan
  // =========================================================================================================

  private track(p: Promise<void>): void {
    const tracked: Promise<void> = p.finally(() => {
      this.inflight.delete(tracked);
    });
    this.inflight.add(tracked);
  }

  private async execute(ctx: RunContext): Promise<void> {
    const runId = ctx.run.wfEvalRunId;
    try {
      await this.executeCases(ctx);
    } catch (err) {
      // Filet de sécurité : toute erreur inattendue termine le run en erreur (jamais « en cours » à vie).
      this.logger.error(`run d'évaluation ${runId} en échec (${errName(err)})`);
      await this.finishErrored(ctx, [], 0, 'Erreur interne pendant l’évaluation.', null, null).catch((e: unknown) =>
        this.logger.error(`clôture du run ${runId} en échec (${errName(e)})`),
      );
    }
  }

  private async executeCases(ctx: RunContext): Promise<void> {
    const { config, cases } = ctx;
    const outcomes: EvalCaseOutcome[] = [];
    let cost = 0;
    let model: string | null = null;

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]!;
      const input = evalCaseInputSchema.safeParse(c.input);
      const expected = evalExpectedSchema.safeParse(c.expected);
      if (!input.success || !expected.success) {
        outcomes.push({
          caseId: c.wfEvalCaseId,
          passed: false,
          reason: 'Cas illisible (contenu invalide).',
          confidence: null,
          disposition: 'invalid_case',
        });
        continue;
      }

      let out: AgentRunOutput;
      try {
        out = await this.runner.run({
          mode: 'dry_run',
          scope: {
            definitionId: config.definitionId,
            stepKey: config.stepKey,
            subject: input.data.subject ?? { type: null, id: null },
          },
          spec: {
            objective: config.objective,
            autonomy: config.autonomy,
            confidenceThreshold: config.confidenceThreshold,
            allowedToolKeys: config.allowedToolKeys,
            remainingToolCalls: remainingCalls(config.maxCallsByTool),
            model: config.model,
            maxSteps: config.maxSteps,
            maxCostPerRun: config.maxCostPerRun,
            timeoutSeconds: config.timeoutSeconds,
          },
          identity: ctx.identity,
          untrusted: untrustedOf(input.data),
          requestedBy: ctx.actorId,
        });
      } catch (err) {
        // Le contrat interdit de lever pour une cause métier : une erreur ici est inattendue.
        this.logger.error(`runner en échec pendant l'évaluation (${errName(err)})`);
        await this.finishErrored(ctx, outcomes, i, 'Erreur inattendue de l’agent pendant l’évaluation.', cost, model);
        return;
      }

      cost += out.audit.costAmount;
      model = model ?? out.audit.model;

      if (out.outcome === 'stopped' && out.stopReason && INTERRUPTING_STOPS.has(out.stopReason)) {
        const why = INTERRUPT_MESSAGES[out.stopReason] ?? 'Arrêt de l’agent';
        await this.finishErrored(ctx, outcomes, i, `${why} : run interrompu au cas n° ${i + 1}.`, cost, model);
        return;
      }

      const disposition = decideDisposition({
        autonomy: config.autonomy,
        confidenceThreshold: config.confidenceThreshold,
        run: out,
        autonomousEligible: true,
      });
      const match = matchesExpected(expected.data, {
        result: out.result,
        returnsToHuman: disposition.kind === 'return_to_human',
        suspicionInjection: out.suspicionInjection,
        confidence: out.confidence,
      });
      outcomes.push({
        caseId: c.wfEvalCaseId,
        passed: match.passed,
        ...(match.reason !== undefined ? { reason: match.reason } : {}),
        confidence: out.confidence,
        disposition: disposition.kind,
        ...(out.stopReason !== undefined ? { stopReason: out.stopReason } : {}),
      });
    }

    await this.finishCompleted(ctx, outcomes, cost, model);
  }

  private resultsOf(ctx: RunContext, outcomes: EvalCaseOutcome[], extra: Record<string, unknown> = {}): Prisma.InputJsonValue {
    return {
      agentSpecHash: ctx.config.specHash,
      casesHash: evalCasesHash(ctx.cases),
      stepKey: ctx.config.stepKey,
      cases: outcomes,
      ...extra,
    } as unknown as Prisma.InputJsonValue;
  }

  private async finishCompleted(
    ctx: RunContext,
    outcomes: EvalCaseOutcome[],
    cost: number,
    model: string | null,
  ): Promise<void> {
    const total = outcomes.length;
    const passedCases = outcomes.filter((o) => o.passed).length;
    // Seuil comparé en ENTIERS sur la précision exacte : 399/499 (0,79960) NE réussit PAS à 0,800 même si
    // la précision affichée (arrondie à 3 décimales) vaut 0,800. Exact >= seuil implique arrondi >= seuil (CHECK SQL).
    const passed = total > 0 && passedCases * 1000 >= Math.round(ctx.requiredAccuracy * 1000) * total;
    const accuracy = total > 0 ? round3(passedCases / total) : null;
    const res = await this.prisma.wfEvalRun.updateMany({
      where: { wfEvalRunId: ctx.run.wfEvalRunId, status: WfEvalRunStatus.Running },
      data: {
        status: WfEvalRunStatus.Completed,
        totalCases: total,
        passedCases,
        accuracy: accuracy === null ? null : accuracy.toFixed(3),
        passed,
        model: (model ?? ctx.config.model)?.slice(0, 200) ?? null,
        results: this.resultsOf(ctx, outcomes),
        costAmount: cost.toFixed(4),
        finishedAt: new Date(),
      },
    });
    await this.afterFinish(ctx, res.count, {
      status: WfEvalRunStatus.Completed,
      totalCases: total,
      passedCases,
      accuracy,
      passed,
    });
  }

  private async finishErrored(
    ctx: RunContext,
    judged: EvalCaseOutcome[],
    atIndex: number,
    message: string,
    cost: number | null,
    model: string | null,
  ): Promise<void> {
    const res = await this.prisma.wfEvalRun.updateMany({
      where: { wfEvalRunId: ctx.run.wfEvalRunId, status: WfEvalRunStatus.Running },
      data: {
        status: WfEvalRunStatus.Errored,
        passed: false,
        accuracy: null,
        passedCases: judged.filter((o) => o.passed).length,
        model: (model ?? ctx.config.model)?.slice(0, 200) ?? null,
        results: this.resultsOf(ctx, judged, { interruptedAtCase: atIndex + 1 }),
        costAmount: cost === null ? null : cost.toFixed(4),
        errorMessage: message,
        finishedAt: new Date(),
      },
    });
    await this.afterFinish(ctx, res.count, { status: WfEvalRunStatus.Errored, passed: false });
  }

  private async afterFinish(ctx: RunContext, updated: number, summary: Record<string, unknown>): Promise<void> {
    if (updated === 0) {
      // Déjà clôturé (run périmé) : le SQL fige un run terminé, on ne touche plus à rien.
      this.logger.warn(`run d'évaluation ${ctx.run.wfEvalRunId} déjà clôturé : résultat ignoré`);
      return;
    }
    await this.journal(ctx.actor, `wf_eval_run:${ctx.run.wfEvalRunId}`, { status: WfEvalRunStatus.Running }, summary);
  }

  // =========================================================================================================
  // Outils internes
  // =========================================================================================================

  private actorId(actor: AuthUser): number {
    if (actor.isScanAgent || actor.userGroupId === null || actor.userGroupId === undefined) {
      throw new ForbiddenException('Action réservée à un utilisateur identifié.');
    }
    return actor.userGroupId;
  }

  private assertFloor(minAccuracy: number): void {
    if (minAccuracy < WF_EVAL_ACCURACY_FLOOR) {
      throw new UnprocessableEntityException(
        `Le seuil de précision d’un jeu ne peut pas être inférieur à ${WF_EVAL_ACCURACY_FLOOR}.`,
      );
    }
  }

  private assertCaseContent(input: unknown, expected: unknown): void {
    if (evalCaseByteSize(input, expected) > EVAL_CASE_MAX_BYTES) {
      throw new UnprocessableEntityException(`Cas trop volumineux (${EVAL_CASE_MAX_BYTES / 1024} Kio au plus).`);
    }
  }

  private async findSet(setId: number): Promise<WfEvalSet> {
    const row = await this.prisma.wfEvalSet.findUnique({ where: { wfEvalSetId: setId } });
    if (!row) throw new NotFoundException('Jeu d’évaluation introuvable.');
    return row;
  }

  private linkedAutonomousCount(setId: number): Promise<number> {
    return this.prisma.wfAgentConfig.count({ where: { evalSetId: setId, autonomyLevel: 2 } });
  }

  /** Verrou de ligne sur le jeu : sérialise l'ajout / la réactivation de cas (plafond de 500 cas actifs). */
  private async lockSet(tx: Tx, setId: number): Promise<void> {
    await tx.$queryRaw`SELECT "wf_eval_set_id" FROM "wf_eval_set" WHERE "wf_eval_set_id" = ${setId} FOR UPDATE`;
  }

  /** L'étape doit être une étape agent d'au moins une version du workflow. */
  private async assertAgentStep(definitionId: number, stepKey: string): Promise<void> {
    const versions = await this.prisma.wfDefinitionVersion.findMany({ where: { definitionId }, select: { graph: true } });
    if (!versions.some((v) => agentStepKeysOfRaw(v.graph).has(stepKey))) {
      throw new UnprocessableEntityException('Cette étape n’est pas une étape agent de ce workflow.');
    }
  }

  /** Version demandée (du MÊME workflow que le jeu) ou, par défaut, la dernière. */
  private async resolveVersion(set: WfEvalSet, requested: number | undefined): Promise<number> {
    if (requested !== undefined) {
      const v = await this.prisma.wfDefinitionVersion.findUnique({
        where: { wfDefinitionVersionId: requested },
        select: { wfDefinitionVersionId: true, definitionId: true },
      });
      if (!v) throw new NotFoundException('Version introuvable.');
      if (v.definitionId !== set.definitionId) {
        throw new UnprocessableEntityException('Un jeu lié à une version ne change pas de workflow.');
      }
      return v.wfDefinitionVersionId;
    }
    const latest = await this.prisma.wfDefinitionVersion.findFirst({
      where: { definitionId: set.definitionId },
      orderBy: { versionNumber: 'desc' },
      select: { wfDefinitionVersionId: true },
    });
    if (!latest) throw new UnprocessableEntityException('Ce workflow n’a encore aucune version.');
    return latest.wfDefinitionVersionId;
  }

  /** Audit : ne bloque jamais l'opération déjà validée ; aucune valeur de contenu (champs de configuration seulement). */
  private async journal(
    actor: AuthUser,
    objectRef: string,
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.dataChange({
        userGroupId: actor.userGroupId,
        actorFullName: actor.fullName ?? actor.username,
        objectRef,
        oldValue: before ? JSON.stringify(before) : undefined,
        newValue: JSON.stringify(after),
      });
    } catch (err) {
      this.logger.error(`audit ${objectRef} en échec (${errName(err)})`);
    }
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'erreur inconnue';
}

function capError(): UnprocessableEntityException {
  return new UnprocessableEntityException(`Un jeu ne peut pas avoir plus de ${EVAL_MAX_ACTIVE_CASES} cas actifs.`);
}

function setAudit(row: WfEvalSet): Record<string, unknown> {
  return {
    definitionId: row.definitionId,
    stepKey: row.stepKey,
    name: row.name,
    minAccuracy: String(row.minAccuracy),
    isActive: row.isActive,
  };
}

/** Sans le contenu du cas (entrée et attendu peuvent reprendre des extraits de documents). */
function caseAudit(row: WfEvalCase): Record<string, unknown> {
  return { evalSetId: row.evalSetId, label: row.label, weight: row.weight, sortOrder: row.sortOrder, isActive: row.isActive };
}

function remainingCalls(max: Record<string, number | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(max)) if (typeof v === 'number') out[k] = v;
  return out;
}

function untrustedOf(
  input: EvalCaseInput,
): { label: string; origin: 'mail' | 'document' | 'ocr' | 'form' | 'context'; text: string }[] {
  const blocks = (input.untrusted ?? []).map((b) => ({ label: b.label, origin: b.origin, text: b.text }));
  if (input.context !== undefined) {
    blocks.push({ label: 'Contexte', origin: 'context', text: JSON.stringify(input.context) });
  }
  return blocks;
}
