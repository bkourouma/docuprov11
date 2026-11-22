import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
  HttpException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  WfDefinitionStatus,
  WfDefinitionVersionStatus,
  WfDefinitionSource,
  validateWorkflowGraph,
  wfAutonomyFromKey,
  wfEscalationConfigSchema,
  wfGraphSchema,
  type CreateWfDefinitionInput,
  type UpsertWfAgentConfigInput,
  type WfAgentConfigDetailDto,
  type WfAgentStepSpec,
  type WfDefinitionDto,
  type WfDefinitionVersionDto,
  type WfGraph,
} from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  agentStepsOf,
  buildAgentConfigDetail,
  collectAgentIssues,
  copyAgentConfigs,
  roundCost,
  roundThreshold,
  syncAgentConfigsFromGraph,
} from './definitions-agents';
import type { WfTaskExecutorRegistry } from './engine/engine.types';
import { WF_EXECUTOR_REGISTRY } from './workflows.tokens';
import type {
  ListWfDefinitionsQuery,
  UpdateWfDraftInput,
  WfDefinitionDetailDto,
  WfDefinitionIssue,
  WfDefinitionValidationResponse,
  WfDefinitionVersionSummaryDto,
  WfDefinitionWithVersionDto,
} from './definitions.dto';

type Tx = Prisma.TransactionClient;

interface DefinitionRow {
  wfDefinitionId: number;
  name: string;
  description: string | null;
  status: number;
  source: number;
  isLowRisk: boolean;
  lowRiskMarkedBy: number | null;
  lowRiskMarkedAt: Date | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface VersionRow {
  wfDefinitionVersionId: number;
  definitionId: number;
  versionNumber: number;
  status: number;
  graph: unknown;
  graphHash: string | null;
  sourcePrompt: string | null;
  changeNote: string | null;
  publishedBy: number | null;
  publishedAt: Date | null;
  createdBy: number | null;
  createdAt: Date;
}

/** JSON canonique : clés d'objet triées récursivement, ordre des tableaux conservé. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const item = (v as Record<string, unknown>)[key];
        if (item !== undefined) out[key] = normalize(item);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(normalize(value));
}

/** SHA-256 hexadécimal du graphe canonique (indépendant de l'ordre des clés). */
export function hashGraph(graph: unknown): string {
  return createHash('sha256').update(canonicalJson(graph), 'utf8').digest('hex');
}

function errorCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isUniqueViolation(e: unknown): boolean {
  return errorCode(e) === 'P2002';
}

/** Erreur d'un déclencheur SQL (`check_violation` 23514 / `restrict_violation` 23001), quelle que soit la forme Prisma. */
function isTriggerViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  let text = '';
  try {
    text = `${(e as { message?: unknown }).message ?? ''} ${JSON.stringify((e as { meta?: unknown }).meta ?? '')}`;
  } catch {
    text = String((e as { message?: unknown }).message ?? '');
  }
  return /check_violation|restrict_violation|23514|23001/i.test(text) || errorCode(e) === 'P2004';
}

/** Message français d'un refus du SQL sur une configuration agent (autonomie, gel de version). */
function describeAgentTriggerViolation(e: unknown): string {
  const text = String((e as { message?: unknown } | null)?.message ?? '');
  if (/faible risque/i.test(text)) {
    return 'Le niveau autonome exige que le workflow soit marqué à faible risque (réservé aux administrateurs).';
  }
  if (/run d.évaluation|aucun run/i.test(text)) {
    return 'Le niveau autonome exige un run d’évaluation réussi pour cette version (jeu lié, seuil atteint) : lancez l’évaluation, puis réessayez.';
  }
  if (/publi/i.test(text)) {
    return 'Cette version n’est plus un brouillon : sa configuration est figée. Modifiez le workflow pour créer un nouveau brouillon.';
  }
  return 'Le niveau autonome exige un workflow à faible risque, un jeu d’évaluation lié et un run d’évaluation réussi pour cette version.';
}

const NAME_TAKEN = 'Un workflow non archivé porte déjà ce nom : choisissez un autre nom.';

@Injectable()
export class DefinitionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WF_EXECUTOR_REGISTRY) private readonly executors?: WfTaskExecutorRegistry,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Lecture
  // -------------------------------------------------------------------------------------------

  async list(query: ListWfDefinitionsQuery, actor: AuthUser): Promise<WfDefinitionDto[]> {
    this.actorId(actor);
    const rows = await this.prisma.wfDefinition.findMany({
      where: query.status === undefined ? {} : { status: query.status },
      orderBy: [{ updatedAt: 'desc' }, { wfDefinitionId: 'desc' }],
    });
    return rows.map(toDefinitionDto);
  }

  /** Définitions publiées (version publiée existante) : seules lançables. */
  async listLaunchable(actor: AuthUser): Promise<WfDefinitionDto[]> {
    this.actorId(actor);
    const rows = await this.prisma.wfDefinition.findMany({
      where: {
        status: WfDefinitionStatus.Published,
        versions: { some: { status: WfDefinitionVersionStatus.Published } },
      },
      orderBy: [{ name: 'asc' }],
    });
    return rows.map(toDefinitionDto);
  }

  async get(id: number, actor: AuthUser): Promise<WfDefinitionDetailDto> {
    this.actorId(actor);
    const def = await this.prisma.wfDefinition.findUnique({ where: { wfDefinitionId: id } });
    if (!def) throw new NotFoundException('Workflow introuvable.');
    const versions = await this.prisma.wfDefinitionVersion.findMany({
      where: { definitionId: id },
      orderBy: { versionNumber: 'desc' },
      select: {
        wfDefinitionVersionId: true,
        definitionId: true,
        versionNumber: true,
        status: true,
        graphHash: true,
        changeNote: true,
        publishedBy: true,
        publishedAt: true,
        createdBy: true,
        createdAt: true,
      },
    });
    return {
      definition: toDefinitionDto(def),
      versions: versions.map(
        (v): WfDefinitionVersionSummaryDto => ({
          wfDefinitionVersionId: v.wfDefinitionVersionId,
          definitionId: v.definitionId,
          versionNumber: v.versionNumber,
          status: v.status as WfDefinitionVersionDtoStatus,
          graphHash: v.graphHash,
          changeNote: v.changeNote,
          publishedBy: v.publishedBy,
          publishedAt: v.publishedAt?.toISOString() ?? null,
          createdBy: v.createdBy,
          createdAt: v.createdAt.toISOString(),
        }),
      ),
    };
  }

  async getVersion(id: number, versionNumber: number, actor: AuthUser): Promise<WfDefinitionVersionDto> {
    this.actorId(actor);
    const row = await this.prisma.wfDefinitionVersion.findUnique({
      where: { definitionId_versionNumber: { definitionId: id, versionNumber } },
    });
    if (!row) throw new NotFoundException('Version introuvable.');
    return toVersionDto(row);
  }

  // -------------------------------------------------------------------------------------------
  // Écriture
  // -------------------------------------------------------------------------------------------

  async create(input: CreateWfDefinitionInput, actor: AuthUser): Promise<WfDefinitionWithVersionDto> {
    const actorId = this.actorId(actor);
    try {
      const def = await this.prisma.wfDefinition.create({
        data: {
          name: input.name.trim(),
          description: input.description ?? null,
          status: WfDefinitionStatus.Draft,
          source: input.source ?? WfDefinitionSource.Manual,
          createdBy: actorId,
          versions: {
            create: {
              versionNumber: 1,
              status: WfDefinitionVersionStatus.Draft,
              graph: input.graph as unknown as Prisma.InputJsonValue,
              createdBy: actorId,
            },
          },
        },
        include: { versions: true },
      });
      const version = def.versions[0];
      if (!version) throw new Error('Version initiale absente après création.');
      return { definition: toDefinitionDto(def), version: toVersionDto(version) };
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(NAME_TAKEN);
      throw e;
    }
  }

  async updateDraft(id: number, input: UpdateWfDraftInput, actor: AuthUser): Promise<WfDefinitionWithVersionDto> {
    const actorId = this.actorId(actor);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockDefinition(tx, id);
        const def = await this.loadEditable(tx, id);
        const latest = await tx.wfDefinitionVersion.findFirst({
          where: { definitionId: id },
          orderBy: { versionNumber: 'desc' },
        });
        if (!latest) throw new NotFoundException('Aucune version pour ce workflow.');

        let version: VersionRow;
        if (latest.status === WfDefinitionVersionStatus.Draft) {
          const data: Prisma.WfDefinitionVersionUpdateInput = {};
          if (input.graph !== undefined) data.graph = input.graph as unknown as Prisma.InputJsonValue;
          if (input.changeNote !== undefined) data.changeNote = input.changeNote;
          version =
            Object.keys(data).length > 0
              ? await tx.wfDefinitionVersion.update({
                  where: { wfDefinitionVersionId: latest.wfDefinitionVersionId },
                  data,
                })
              : latest;
        } else {
          // Dernière version publiée (ou archivée) : jamais modifiée, on repart d'une copie en brouillon.
          version = await tx.wfDefinitionVersion.create({
            data: {
              definitionId: id,
              versionNumber: latest.versionNumber + 1,
              status: WfDefinitionVersionStatus.Draft,
              graph: (input.graph ?? latest.graph) as unknown as Prisma.InputJsonValue,
              changeNote: input.changeNote ?? null,
              createdBy: actorId,
            },
          });
          // La configuration des agents repart de celle de la version précédente (jeu d'évaluation et délai conservés).
          await copyAgentConfigs(tx, latest.wfDefinitionVersionId, version.wfDefinitionVersionId, version.graph);
        }

        let definition: DefinitionRow = def;
        if (input.name !== undefined || input.description !== undefined) {
          definition = await tx.wfDefinition.update({
            where: { wfDefinitionId: id },
            data: {
              ...(input.name !== undefined ? { name: input.name.trim() } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
            },
          });
        }
        return { definition: toDefinitionDto(definition), version: toVersionDto(version) };
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          input.name !== undefined ? NAME_TAKEN : 'Une autre modification vient de créer une version : réessayez.',
        );
      }
      throw e;
    }
  }

  /** Valide le brouillon courant. N'écrit rien. */
  async validateDraft(id: number, actor: AuthUser): Promise<WfDefinitionValidationResponse> {
    this.actorId(actor);
    const def = await this.prisma.wfDefinition.findUnique({ where: { wfDefinitionId: id } });
    if (!def) throw new NotFoundException('Workflow introuvable.');
    const draft = await this.prisma.wfDefinitionVersion.findFirst({
      where: { definitionId: id, status: WfDefinitionVersionStatus.Draft },
      orderBy: { versionNumber: 'desc' },
    });
    if (!draft) throw new ConflictException('Aucun brouillon à valider : modifiez d’abord le workflow.');
    const issues = await this.collectAllIssues(this.prisma, id, draft, def.isLowRisk);
    return { ok: issues.length === 0, issues };
  }

  // -------------------------------------------------------------------------------------------
  // Étapes agent du brouillon
  // -------------------------------------------------------------------------------------------

  /** Configuration des étapes agent du brouillon (le graphe fait foi pour les champs communs). */
  async listAgentConfigs(definitionId: number, actor: AuthUser): Promise<WfAgentConfigDetailDto[]> {
    this.actorId(actor);
    const def = await this.prisma.wfDefinition.findUnique({ where: { wfDefinitionId: definitionId } });
    if (!def) throw new NotFoundException('Workflow introuvable.');
    const draft = await this.latestDraftOrConflict(this.prisma, definitionId);
    const graph = parseDraftGraph(draft.graph);
    const rows = await this.prisma.wfAgentConfig.findMany({
      where: { definitionVersionId: draft.wfDefinitionVersionId },
      select: { wfAgentConfigId: true, stepKey: true, timeoutSeconds: true, evalSetId: true, createdAt: true, updatedAt: true },
    });
    const byKey = new Map(rows.map((r) => [r.stepKey, r]));
    return agentStepsOf(graph).map((ref) =>
      buildAgentConfigDetail(draft.wfDefinitionVersionId, ref, byKey.get(ref.step.key) ?? null, draft.createdAt),
    );
  }

  /**
   * Crée ou modifie la configuration d'une étape agent du BROUILLON, atomiquement : graphe (`step.agent`),
   * ligne `wf_agent_config` et outils. Champs absents = valeurs actuelles conservées. Le SQL refuse tout
   * niveau autonome sans faible risque ni run d'évaluation réussi : traduit en 409.
   */
  async upsertAgentConfig(
    definitionId: number,
    stepKey: string,
    input: UpsertWfAgentConfigInput,
    actor: AuthUser,
  ): Promise<WfAgentConfigDetailDto> {
    this.actorId(actor);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockDefinition(tx, definitionId);
        await this.loadEditable(tx, definitionId);
        const draft = await this.latestDraftOrConflict(tx, definitionId);
        const versionId = draft.wfDefinitionVersionId;

        const rawGraph = structuredClone(draft.graph) as { steps?: Array<Record<string, unknown>> } | null;
        const rawStep = Array.isArray(rawGraph?.steps) ? rawGraph.steps.find((st) => st?.key === stepKey) : undefined;
        if (!rawGraph || !rawStep) throw new NotFoundException('Étape introuvable dans le brouillon.');
        if (rawStep.type !== 'agent') {
          throw new UnprocessableEntityException(`L’étape « ${stepKey} » n’est pas de type agent.`);
        }

        // Fusion : champs absents = valeur actuelle du graphe (source de vérité).
        const current = (rawStep.agent ?? {}) as Partial<WfAgentStepSpec>;
        const objective = input.objective ?? current.objective;
        if (typeof objective !== 'string' || !objective.trim()) {
          throw new UnprocessableEntityException('L’objectif de l’agent est obligatoire.');
        }
        const tools = input.tools ?? (Array.isArray(current.tools) ? current.tools : []);
        const model = input.model !== undefined ? input.model : (current.model ?? null);
        const maxCostPerRun = input.maxCostPerRun !== undefined ? input.maxCostPerRun : (current.maxCostPerRun ?? null);
        const spec: Record<string, unknown> = {
          objective,
          tools,
          confidenceThreshold: roundThreshold(input.confidenceThreshold ?? current.confidenceThreshold ?? 0.8),
          autonomy: input.autonomy ?? current.autonomy ?? 'suggere',
        };
        if (model !== null) spec.model = model;
        const maxSteps = input.maxSteps ?? current.maxSteps;
        if (maxSteps !== undefined) spec.maxSteps = maxSteps;
        if (maxCostPerRun !== null) spec.maxCostPerRun = roundCost(maxCostPerRun);

        // Outils : présents dans le registre et activés (l'autorisation du workflow est contrôlée à la publication).
        const toolRows = tools.length
          ? await tx.wfTool.findMany({
              where: { toolKey: { in: tools } },
              select: { wfToolId: true, toolKey: true, isEnabled: true },
            })
          : [];
        const usable = new Map(toolRows.filter((t) => t.isEnabled).map((t) => [t.toolKey, t.wfToolId]));
        const unknown = tools.filter((k) => !usable.has(k));
        if (unknown.length > 0) {
          throw new UnprocessableEntityException(`Outils inconnus ou désactivés : ${unknown.join(', ')}.`);
        }

        // Jeu d'évaluation : du MÊME workflow.
        if (input.evalSetId !== undefined && input.evalSetId !== null) {
          const set = await tx.wfEvalSet.findUnique({
            where: { wfEvalSetId: input.evalSetId },
            select: { definitionId: true },
          });
          if (!set || set.definitionId !== definitionId) {
            throw new UnprocessableEntityException('Le jeu d’évaluation est introuvable pour ce workflow.');
          }
        }

        rawStep.agent = spec;
        const checked = wfGraphSchema.safeParse(rawGraph);
        if (!checked.success) {
          throw new UnprocessableEntityException(
            `Configuration d’agent invalide : ${checked.error.issues.map((i) => i.message).join(' ; ')}.`,
          );
        }
        await tx.wfDefinitionVersion.update({
          where: { wfDefinitionVersionId: versionId },
          data: { graph: rawGraph as unknown as Prisma.InputJsonValue },
        });

        const existing = await tx.wfAgentConfig.findUnique({
          where: { definitionVersionId_stepKey: { definitionVersionId: versionId, stepKey } },
          select: { wfAgentConfigId: true, timeoutSeconds: true, evalSetId: true },
        });
        const parsedStep = checked.data.steps.find((st) => st.key === stepKey)?.agent as WfAgentStepSpec;
        const common = {
          objective: parsedStep.objective,
          autonomyLevel: wfAutonomyFromKey(parsedStep.autonomy),
          confidenceThreshold: parsedStep.confidenceThreshold,
          model: parsedStep.model ?? null,
          maxSteps: parsedStep.maxSteps ?? 10,
          maxCostPerRun: parsedStep.maxCostPerRun ?? null,
        };
        const timeoutSeconds = input.timeoutSeconds ?? existing?.timeoutSeconds;
        const evalSetId = input.evalSetId !== undefined ? input.evalSetId : (existing?.evalSetId ?? null);
        const row = existing
          ? await tx.wfAgentConfig.update({
              where: { wfAgentConfigId: existing.wfAgentConfigId },
              data: { ...common, evalSetId, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) },
            })
          : await tx.wfAgentConfig.create({
              data: {
                definitionVersionId: versionId,
                stepKey,
                ...common,
                evalSetId,
                ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
              },
            });
        await tx.wfAgentConfigTool.deleteMany({ where: { agentConfigId: row.wfAgentConfigId } });
        if (tools.length > 0) {
          await tx.wfAgentConfigTool.createMany({
            data: tools.map((k) => ({ agentConfigId: row.wfAgentConfigId, toolId: usable.get(k) as number })),
          });
        }

        const ref = agentStepsOf(checked.data).find((r) => r.step.key === stepKey);
        if (!ref) throw new Error('Étape agent absente après écriture.');
        return buildAgentConfigDetail(versionId, ref, row, draft.createdAt);
      });
    } catch (e) {
      if (!(e instanceof HttpException) && isTriggerViolation(e)) {
        throw new ConflictException(describeAgentTriggerViolation(e));
      }
      throw e;
    }
  }

  async publish(id: number, actor: AuthUser): Promise<WfDefinitionWithVersionDto> {
    const actorId = this.actorId(actor);
    try {
      return await this.publishInTransaction(id, actorId);
    } catch (e) {
      // Garde-fou : les contrôles ci-dessous reproduisent ceux du SQL ; si une course les contourne, le refus
      // du déclencheur devient un 422 lisible plutôt qu'une erreur 500.
      if (!(e instanceof HttpException) && isTriggerViolation(e) && /autonomie|faible risque/i.test(String((e as Error).message))) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'Le workflow ne peut pas être publié : corrigez les problèmes signalés.',
          issues: [
            {
              code: 'AGENT_AUTONOMY_NOT_ELIGIBLE',
              message: describeAgentTriggerViolation(e),
            } satisfies WfDefinitionIssue,
          ],
        });
      }
      throw e;
    }
  }

  private publishInTransaction(id: number, actorId: number): Promise<WfDefinitionWithVersionDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDefinition(tx, id);
      const def = await this.loadEditable(tx, id);
      const draft = await tx.wfDefinitionVersion.findFirst({
        where: { definitionId: id, status: WfDefinitionVersionStatus.Draft },
        orderBy: { versionNumber: 'desc' },
      });
      if (!draft) throw new ConflictException('Aucun brouillon à publier.');

      // Contrôles en lecture seule d'abord (une version refusée n'écrit rien), puis alignement des lignes
      // `wf_agent_config` sur le graphe AVANT la mise à publication (ensuite le SQL les fige).
      const issues = await this.collectAllIssues(tx, id, draft, def.isLowRisk);
      if (issues.length > 0) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          message: 'Le workflow ne peut pas être publié : corrigez les problèmes signalés.',
          issues,
        });
      }
      const parsed = wfGraphSchema.parse(draft.graph);
      await syncAgentConfigsFromGraph(tx, draft.wfDefinitionVersionId, parsed);

      // La version publiée précédente est archivée AVANT (index unique partiel : une seule publiée).
      await tx.wfDefinitionVersion.updateMany({
        where: { definitionId: id, status: WfDefinitionVersionStatus.Published },
        data: { status: WfDefinitionVersionStatus.Archived },
      });
      const published = await tx.wfDefinitionVersion.update({
        where: { wfDefinitionVersionId: draft.wfDefinitionVersionId },
        data: {
          status: WfDefinitionVersionStatus.Published,
          graphHash: hashGraph(draft.graph),
          publishedAt: new Date(),
          publishedBy: actorId,
        },
      });
      const definition = await tx.wfDefinition.update({
        where: { wfDefinitionId: id },
        data: { status: WfDefinitionStatus.Published },
      });
      return { definition: toDefinitionDto(definition), version: toVersionDto(published) };
    });
  }

  /** Archive la définition et sa version publiée ; les instances en cours ne sont pas touchées. */
  async archive(id: number, actor: AuthUser): Promise<WfDefinitionDto> {
    this.actorId(actor);
    return this.prisma.$transaction(async (tx) => {
      const def = await tx.wfDefinition.findUnique({ where: { wfDefinitionId: id } });
      if (!def) throw new NotFoundException('Workflow introuvable.');
      if (def.status === WfDefinitionStatus.Archived) return toDefinitionDto(def);
      await tx.wfDefinitionVersion.updateMany({
        where: { definitionId: id, status: WfDefinitionVersionStatus.Published },
        data: { status: WfDefinitionVersionStatus.Archived },
      });
      const updated = await tx.wfDefinition.update({
        where: { wfDefinitionId: id },
        data: { status: WfDefinitionStatus.Archived },
      });
      return toDefinitionDto(updated);
    });
  }

  /** Marquage « faible risque » : administrateurs seulement (le contrôleur ET le service le vérifient). */
  async setLowRisk(id: number, isLowRisk: boolean, actor: AuthUser): Promise<WfDefinitionDto> {
    const actorId = this.actorId(actor);
    // Le droit est relu en base (le jeton peut dater : un administrateur rétrogradé ne doit plus pouvoir marquer).
    const row = await this.prisma.appUser.findUnique({
      where: { userId: actor.userId },
      select: { isAdmin: true, isDisabled: true },
    });
    if (!row?.isAdmin || row.isDisabled) throw new ForbiddenException('Réservé aux administrateurs.');
    const def = await this.prisma.wfDefinition.findUnique({ where: { wfDefinitionId: id } });
    if (!def) throw new NotFoundException('Workflow introuvable.');
    try {
      const updated = await this.prisma.wfDefinition.update({
        where: { wfDefinitionId: id },
        data: { isLowRisk, lowRiskMarkedBy: actorId, lowRiskMarkedAt: new Date() },
      });
      return toDefinitionDto(updated);
    } catch (e) {
      if (!isLowRisk && isTriggerViolation(e)) {
        throw new ConflictException(
          'Retrait du marquage « faible risque » refusé : une étape agent autonome existe encore. Repassez-la en non autonome d’abord.',
        );
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Interne
  // -------------------------------------------------------------------------------------------

  /** Acteur humain obligatoire : une identité machine (sans `userGroupId`) n'agit jamais. */
  private actorId(actor: AuthUser): number {
    if (actor.isScanAgent || actor.userGroupId === null || actor.userGroupId === undefined) {
      throw new ForbiddenException('Action réservée à un utilisateur identifié.');
    }
    return actor.userGroupId;
  }

  private async loadEditable(tx: Tx, id: number): Promise<DefinitionRow> {
    const def = await tx.wfDefinition.findUnique({ where: { wfDefinitionId: id } });
    if (!def) throw new NotFoundException('Workflow introuvable.');
    if (def.status === WfDefinitionStatus.Archived) {
      throw new ConflictException('Ce workflow est archivé : il ne peut plus être modifié ni publié.');
    }
    return def;
  }

  /** Verrou d'écriture sur la définition : sérialise modifications du brouillon, config d'agent et publication. */
  private async lockDefinition(tx: Tx, id: number): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "wf_definition" WHERE "wf_definition_id" = ${id} FOR UPDATE`;
  }

  /** Dernière version, qui doit être un brouillon (409 sinon : les versions publiées sont figées). */
  private async latestDraftOrConflict(db: Tx, id: number): Promise<VersionRow> {
    const latest = await db.wfDefinitionVersion.findFirst({
      where: { definitionId: id },
      orderBy: { versionNumber: 'desc' },
    });
    if (!latest) throw new NotFoundException('Aucune version pour ce workflow.');
    if (latest.status !== WfDefinitionVersionStatus.Draft) {
      throw new ConflictException(
        'La dernière version n’est pas un brouillon : modifiez le workflow pour créer un brouillon avant de configurer les agents.',
      );
    }
    return latest;
  }

  /** Graphe + escalades + exécuteurs + étapes agent (outils, autonomie). Liste vide = publiable. */
  private async collectAllIssues(
    db: Tx,
    definitionId: number,
    draft: VersionRow,
    isLowRisk: boolean,
  ): Promise<WfDefinitionIssue[]> {
    const issues = this.collectIssues(draft.graph, isLowRisk);
    const parsed = wfGraphSchema.safeParse(draft.graph);
    if (parsed.success) {
      issues.push(
        ...(await collectAgentIssues(db, {
          definitionId,
          versionId: draft.wfDefinitionVersionId,
          graph: parsed.data,
        })),
      );
    }
    return issues;
  }

  /** Graphe + escalades + exécuteurs (sans accès à la base). */
  private collectIssues(graphJson: unknown, isLowRisk: boolean): WfDefinitionIssue[] {
    const result = validateWorkflowGraph(graphJson, { isLowRisk });
    const issues: WfDefinitionIssue[] = [...result.issues];
    const graph: WfGraph | undefined = result.graph;
    if (!graph) return issues;

    graph.steps.forEach((step, i) => {
      const escalation = step.config?.escalation;
      if (escalation !== undefined) {
        const parsed = wfEscalationConfigSchema.safeParse(escalation);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            issues.push({
              code: 'ESCALATION_INVALID',
              message: `Escalade invalide sur l’étape « ${step.key} »${issue.path.length ? ` (${issue.path.join('.')})` : ''} : ${issue.message}`,
              stepKey: step.key,
              path: ['steps', i, 'config', 'escalation', ...issue.path],
            });
          }
        }
      }
      if (step.type === 'agent' && !this.executors?.has('agent')) {
        issues.push({
          code: 'EXECUTOR_MISSING',
          message: `L’étape « ${step.key} » est de type agent, mais aucun exécuteur d’agent n’est disponible : publication impossible pour l’instant.`,
          stepKey: step.key,
          path: ['steps', i, 'type'],
        });
      }
      // Brouillon généré en langage naturel (W5) : une affectation laissée « à compléter » bloque la publication.
      if (hasAssigneeToComplete(step)) {
        issues.push({
          code: 'AUTHORING_TO_COMPLETE',
          message: `Affectation à compléter à l’étape « ${step.key} » : désignez qui traite cette étape avant de publier.`,
          stepKey: step.key,
          path: ['steps', i, 'assignee'],
        });
      }
    });
    return issues;
  }
}

/** Marqueur posé par le générateur (`config.authoring.toComplete` contient « assignee ») et affectation toujours absente. */
function hasAssigneeToComplete(step: WfGraph['steps'][number]): boolean {
  if (step.assignee !== undefined) return false;
  const marker = step.config?.authoring;
  if (marker === null || typeof marker !== 'object') return false;
  const todo = (marker as { toComplete?: unknown }).toComplete;
  return Array.isArray(todo) && todo.includes('assignee');
}

type WfDefinitionVersionDtoStatus = WfDefinitionVersionDto['status'];

function parseDraftGraph(raw: unknown): WfGraph {
  const parsed = wfGraphSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UnprocessableEntityException('Le graphe du brouillon est invalide : corrigez-le avant de configurer les agents.');
  }
  return parsed.data;
}

function toDefinitionDto(row: DefinitionRow): WfDefinitionDto {
  return {
    wfDefinitionId: row.wfDefinitionId,
    name: row.name,
    description: row.description,
    status: row.status as WfDefinitionDto['status'],
    source: row.source as WfDefinitionDto['source'],
    isLowRisk: row.isLowRisk,
    lowRiskMarkedBy: row.lowRiskMarkedBy,
    lowRiskMarkedAt: row.lowRiskMarkedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVersionDto(row: VersionRow): WfDefinitionVersionDto {
  return {
    wfDefinitionVersionId: row.wfDefinitionVersionId,
    definitionId: row.definitionId,
    versionNumber: row.versionNumber,
    status: row.status as WfDefinitionVersionDtoStatus,
    graph: row.graph as WfGraph,
    graphHash: row.graphHash,
    sourcePrompt: row.sourcePrompt,
    changeNote: row.changeNote,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}
