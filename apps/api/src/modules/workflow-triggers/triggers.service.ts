import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { WfDefinitionStatus, isWfTriggerEventType, type WfTriggerEventType } from '@archivage/types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { PrincipalService } from '../workflows/principal.service';
import { parseTriggerConditions } from './domain/conditions';
import {
  WF_TRIGGER_DEFAULT_LIMITS,
  WF_TRIGGER_LIMIT_CEILING,
  WF_TRIGGER_OPS,
  type WfTriggerConditions,
} from './domain/contracts';
import { WF_EVENT_CATALOG } from './domain/event-catalog';
import type {
  CreateTriggerInput,
  ListTriggersQuery,
  TriggerCatalogDto,
  TriggerDto,
  UpdateTriggerInput,
} from './triggers.dto';

const INVALID_RUN_AS = 'Le compte lanceur doit être actif et posséder le menu Lancer.';
const FOREIGN_TRIGGER_REFUSED = "Seul un administrateur peut modifier ou supprimer un déclencheur dont le lanceur est le compte d'une autre personne.";
const ELEVATION_REFUSED = 'Seul un administrateur peut désigner un autre compte comme lanceur.';
const ARCHIVED_DEFINITION = 'Ce workflow est archivé : aucun déclencheur ne peut lui être associé ni être activé.';

interface TriggerRow {
  wfTriggerId: number;
  definitionId: number;
  name: string;
  eventType: string;
  conditions: unknown;
  runAsUserGroupId: number;
  isActive: boolean;
  lastFiredAt: Date | null;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  definition: { name: string; status: number };
}

const TRIGGER_INCLUDE = { definition: { select: { name: true, status: true } } } as const;

/** Conditions stockées -> forme normalisée ; une ligne illisible (jamais produite par ce service) devient « sans condition ». */
function normalizeStored(eventType: string, raw: unknown): WfTriggerConditions {
  if (!isWfTriggerEventType(eventType)) return { match: [] };
  const parsed = parseTriggerConditions(eventType, raw);
  return parsed.ok ? parsed.value : { match: [] };
}

/** Résumé court pour le journal : jamais la liste complète des conditions. */
function summarize(row: TriggerRow | (Omit<TriggerRow, 'definition'> & { definition?: unknown })): string {
  const c = normalizeStored(row.eventType, row.conditions);
  return JSON.stringify({
    name: row.name,
    eventType: row.eventType,
    definitionId: row.definitionId,
    runAsUserGroupId: row.runAsUserGroupId,
    isActive: row.isActive,
    conditions: {
      match: c.match.length,
      deadline: c.deadline?.leadHours ?? null,
      threshold: c.threshold ? c.threshold.metaDataId : null,
      limits: c.limits ?? null,
    },
  });
}

/**
 * Déclencheurs par événement (conception). Un déclencheur n'a jamais plus de droits que son lanceur
 * (`runAsUserGroupId`) : le lanceur doit être actif et posséder le menu Lancer, et seul un administrateur peut
 * désigner un autre compte que le sien (pas d'élévation de privilèges).
 */
@Injectable()
export class WorkflowTriggersService {
  private readonly logger = new Logger(WorkflowTriggersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Lecture
  // -------------------------------------------------------------------------------------------

  async list(query: ListTriggersQuery): Promise<TriggerDto[]> {
    const where: Prisma.WfTriggerWhereInput = {};
    if (query.definitionId !== undefined) where.definitionId = query.definitionId;
    if (query.eventType !== undefined) where.eventType = query.eventType;
    if (query.isActive !== undefined) where.isActive = query.isActive;
    const rows = (await this.prisma.wfTrigger.findMany({
      where,
      include: TRIGGER_INCLUDE,
      orderBy: [{ wfTriggerId: 'desc' }],
      take: query.limit,
      skip: query.offset,
    })) as TriggerRow[];
    return Promise.all(rows.map((r) => this.toDto(r)));
  }

  async get(id: number): Promise<TriggerDto> {
    return this.toDto(await this.load(id));
  }

  /** Catalogue pour l'écran de conception : types d'événement, champs, opérateurs, plafonds. */
  catalog(): TriggerCatalogDto {
    return {
      eventTypes: (Object.entries(WF_EVENT_CATALOG) as [WfTriggerEventType, (typeof WF_EVENT_CATALOG)[WfTriggerEventType]][]).map(
        ([type, spec]) => ({
          type,
          label: spec.label,
          subjectType: spec.subjectType,
          fields: Object.entries(spec.fields).map(([name, f]) => ({ name, kind: f.kind, label: f.label })),
        }),
      ),
      operators: [...WF_TRIGGER_OPS],
      limits: {
        defaults: { ...WF_TRIGGER_DEFAULT_LIMITS },
        ceiling: { ...WF_TRIGGER_LIMIT_CEILING },
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Écriture
  // -------------------------------------------------------------------------------------------

  async create(user: AuthUser, body: CreateTriggerInput): Promise<TriggerDto> {
    const actorId = this.actorId(user);

    const def = await this.prisma.wfDefinition.findUnique({
      where: { wfDefinitionId: body.definitionId },
      select: { wfDefinitionId: true, name: true, status: true },
    });
    if (!def) throw new NotFoundException('Workflow introuvable.');
    if (def.status === WfDefinitionStatus.Archived) throw new UnprocessableEntityException(ARCHIVED_DEFINITION);

    const conditions = this.normalizeConditions(body.eventType, body.conditions);
    await this.checkRunAs(user, body.runAsUserGroupId);

    const created = (await this.prisma.wfTrigger.create({
      data: {
        definitionId: def.wfDefinitionId,
        name: body.name,
        eventType: body.eventType,
        conditions: conditions as unknown as Prisma.InputJsonValue,
        runAsUserGroupId: body.runAsUserGroupId,
        isActive: body.isActive,
        createdBy: actorId,
      },
      include: TRIGGER_INCLUDE,
    })) as TriggerRow;

    await this.journal(user, created.wfTriggerId, undefined, summarize(created));
    return this.toDto(created);
  }

  async update(user: AuthUser, id: number, body: UpdateTriggerInput): Promise<TriggerDto> {
    this.actorId(user);
    const current = await this.load(id);
    await this.assertOwnsCurrentRunAs(user, current);

    const data: Prisma.WfTriggerUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;

    if (body.conditions !== undefined) {
      const eventType = current.eventType as WfTriggerEventType;
      data.conditions = this.normalizeConditions(eventType, body.conditions) as unknown as Prisma.InputJsonValue;
    }

    const reactivating = body.isActive === true && !current.isActive;
    if (reactivating) {
      if (current.definition.status === WfDefinitionStatus.Archived) {
        throw new UnprocessableEntityException(ARCHIVED_DEFINITION);
      }
      // Réactivation (ex. après désactivation automatique) : les conditions stockées sont revalidées.
      this.normalizeConditions(current.eventType as WfTriggerEventType, body.conditions ?? current.conditions);
    }

    const runAsChanged = body.runAsUserGroupId !== undefined && body.runAsUserGroupId !== current.runAsUserGroupId;
    if (runAsChanged) {
      await this.checkRunAs(user, body.runAsUserGroupId as number);
      data.runAsUserGroupId = body.runAsUserGroupId as number;
    } else if (reactivating) {
      // Le lanceur actuel doit toujours être actif et posséder le menu Lancer.
      await this.assertCanLaunch(current.runAsUserGroupId);
    }
    if (body.isActive !== undefined) data.isActive = body.isActive;

    const updated = (await this.prisma.wfTrigger.update({
      where: { wfTriggerId: id },
      data,
      include: TRIGGER_INCLUDE,
    })) as TriggerRow;

    await this.journal(user, id, summarize(current), summarize(updated));
    return this.toDto(updated);
  }

  /** Suppression réelle : `wf_instance.trigger_id` passe à NULL côté base (les instances sont conservées). */
  async remove(user: AuthUser, id: number): Promise<void> {
    this.actorId(user);
    const current = await this.load(id);
    await this.assertOwnsCurrentRunAs(user, current);
    await this.prisma.wfTrigger.delete({ where: { wfTriggerId: id } });
    await this.journal(user, id, summarize(current), undefined);
  }

  // -------------------------------------------------------------------------------------------
  // Internes
  // -------------------------------------------------------------------------------------------

  /** Acteur identifié (jamais l'identité machine ni un jeton sans `userGroupId`). */
  private actorId(user: AuthUser): number {
    if (user.isScanAgent || user.userGroupId == null) {
      throw new ForbiddenException('Identité sans acteur : accès refusé aux déclencheurs.');
    }
    return user.userGroupId;
  }

  private async load(id: number): Promise<TriggerRow> {
    const row = (await this.prisma.wfTrigger.findUnique({
      where: { wfTriggerId: id },
      include: TRIGGER_INCLUDE,
    })) as TriggerRow | null;
    if (!row) throw new NotFoundException('Déclencheur introuvable.');
    return row;
  }

  private normalizeConditions(eventType: WfTriggerEventType, raw: unknown): WfTriggerConditions {
    const parsed = parseTriggerConditions(eventType, raw);
    if (!parsed.ok) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Conditions invalides.',
        issues: parsed.issues,
      });
    }
    return parsed.value;
  }

  private async assertCanLaunch(userGroupId: number): Promise<void> {
    if (!(await this.principals.canLaunch(userGroupId))) throw new UnprocessableEntityException(INVALID_RUN_AS);
  }

  /**
   * Anti-élévation sur le lanceur ACTUEL : un non-administrateur ne modifie, réactive ou supprime qu'un
   * déclencheur dont le lanceur est un compte de sa propre personne. Contrôle avant toute écriture ou audit.
   */
  private async assertOwnsCurrentRunAs(user: AuthUser, current: TriggerRow): Promise<void> {
    if (user.isAdmin) return;
    const owner = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId: current.runAsUserGroupId },
      select: { userId: true },
    });
    if (!owner || owner.userId !== user.userId) throw new ForbiddenException(FOREIGN_TRIGGER_REFUSED);
  }

  /**
   * Lanceur désigné : anti-élévation (un non-administrateur ne désigne que son propre compte, c'est-à-dire un
   * compte de la MÊME personne), puis compte actif possédant le menu Lancer.
   */
  private async checkRunAs(user: AuthUser, runAsUserGroupId: number): Promise<void> {
    if (!user.isAdmin) {
      const target = await this.prisma.appUserGroup.findUnique({
        where: { userGroupId: runAsUserGroupId },
        select: { userId: true },
      });
      if (!target || target.userId !== user.userId) throw new ForbiddenException(ELEVATION_REFUSED);
    }
    await this.assertCanLaunch(runAsUserGroupId);
  }

  /** Journal des modifications de données. Un échec du journal n'invalide jamais l'opération. */
  private async journal(user: AuthUser, id: number, oldValue: string | undefined, newValue: string | undefined) {
    try {
      await this.audit.dataChange({
        userGroupId: user.userGroupId,
        actorFullName: user.fullName ?? user.username,
        objectRef: `wf_trigger:${id}`,
        oldValue,
        newValue,
      });
    } catch (err) {
      this.logger.warn(`Journal d'audit indisponible pour wf_trigger:${id} : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async toDto(row: TriggerRow): Promise<TriggerDto> {
    let runAsLabel: string | null = null;
    try {
      runAsLabel = await this.principals.describeUserGroup(row.runAsUserGroupId);
    } catch {
      runAsLabel = null;
    }
    return {
      wfTriggerId: row.wfTriggerId,
      name: row.name,
      eventType: row.eventType as WfTriggerEventType,
      definitionId: row.definitionId,
      definitionName: row.definition.name,
      conditions: normalizeStored(row.eventType, row.conditions),
      runAsUserGroupId: row.runAsUserGroupId,
      runAsLabel,
      isActive: row.isActive,
      lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
