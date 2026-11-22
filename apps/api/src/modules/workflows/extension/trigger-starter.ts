import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { WfStartInstanceResult, WorkflowEngineApi } from '../engine/engine.types';
import { PrincipalService } from '../principal.service';
import { WF_ENGINE } from '../workflows.tokens';
import { withEngineErrors } from '../workflow-errors';
import { SubjectAccessRegistry } from './subject-access';
import { WorkflowEventsPublisher } from './workflow-events';

export interface WfTriggerStartInput {
  definitionId: number;
  /** `run_as` du déclencheur : `app_user_group.user_group_id` dont les droits s'appliquent. */
  startedBy: number;
  /** Obligatoire : un déclencheur rejoué ne doit jamais créer de doublon. */
  idempotencyKey: string;
  triggerId?: number | null;
  subjectType?: string | null;
  subjectId?: string | null;
  context?: Record<string, unknown>;
}

/** Point d'entrée des déclencheurs (W3) : jeton `WF_TRIGGER_STARTER`. */
export interface WfTriggerStarter {
  start(input: WfTriggerStartInput): Promise<WfStartInstanceResult>;
}

/**
 * Démarrage par déclencheur. Deny-by-default : un déclencheur n'a jamais plus de droits que son
 * `run_as` — il faut que le lanceur existe, soit actif et possède le menu LANCER, et que l'objet lié
 * (le cas échéant) soit accessible à CE lanceur.
 */
@Injectable()
export class WorkflowTriggerStarterService implements WfTriggerStarter {
  constructor(
    @Inject(WF_ENGINE) private readonly engine: WorkflowEngineApi,
    private readonly principals: PrincipalService,
    private readonly subjects: SubjectAccessRegistry,
    private readonly events: WorkflowEventsPublisher,
  ) {}

  async start(input: WfTriggerStartInput): Promise<WfStartInstanceResult> {
    const key = input.idempotencyKey?.trim();
    if (!key || key.length > 200) {
      throw new ForbiddenException("Clé d'idempotence obligatoire (1 à 200 caractères) pour un déclencheur.");
    }
    if (!(await this.principals.canLaunch(input.startedBy))) {
      throw new ForbiddenException("Le compte d'exécution du déclencheur n'est pas autorisé à lancer des workflows.");
    }
    await this.subjects.assertAccess({ userGroupId: input.startedBy }, input.subjectType, input.subjectId);

    const result = await withEngineErrors(() =>
      this.engine.startInstance({
        definitionId: input.definitionId,
        startedBy: input.startedBy,
        idempotencyKey: key,
        triggerId: input.triggerId ?? null,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        context: input.context,
      }),
    );
    if (result.created) await this.events.publish(result.events);
    return result;
  }
}
