import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { WfDefinitionSource, type WfGraph } from '@archivage/types';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import { EvalService } from '../../workflow-agents/eval/eval.service';
import { DefinitionsService } from '../../workflows/definitions.service';
import { ALL_TEMPLATES } from './data';
import type { InstantiateTemplateResult, WorkflowTemplate, WorkflowTemplateSummary } from './template.types';

/** Nombre maximal de nouvelles tentatives après une collision de nom (suffixes « (2) » à « (6) »). */
export const TEMPLATE_NAME_MAX_RETRIES = 5;
const NAME_MAX = 200;

/**
 * Modèles de workflow prêts à l'emploi. La liste est une projection publique stricte ; l'instanciation crée un
 * BROUILLON ordinaire (aucune publication, aucun run d'évaluation, aucune autorisation d'outil : décisions
 * d'administration). Chaque appel passe par les services existants, donc avec leurs droits et leur journal.
 */
@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly definitions: DefinitionsService,
    private readonly evals: EvalService,
    private readonly audit: AuditService,
  ) {}

  list(): WorkflowTemplateSummary[] {
    return ALL_TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      agentKey: t.agentKey,
      tags: [...t.tags],
    }));
  }

  async instantiate(key: string, name: string | undefined, actor: AuthUser): Promise<InstantiateTemplateResult> {
    const template = ALL_TEMPLATES.find((t) => t.key === key);
    if (!template) throw new NotFoundException('Modèle de workflow introuvable.');

    const definitionId = await this.createDraft(template, name?.trim() || template.name, actor);
    try {
      await this.configureAgents(template, definitionId, actor);
      await this.journal(template, definitionId, actor);
    } catch (err) {
      await this.discard(definitionId, actor);
      throw err;
    }
    return { definitionId };
  }

  /** Crée le brouillon ; sur collision de nom (409), réessaie avec « (2) », « (3) »… */
  private async createDraft(template: WorkflowTemplate, baseName: string, actor: AuthUser): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      const suffix = attempt === 1 ? '' : ` (${attempt})`;
      const candidate = `${baseName.slice(0, NAME_MAX - suffix.length)}${suffix}`;
      try {
        const created = await this.definitions.create(
          {
            name: candidate,
            description: template.description,
            source: WfDefinitionSource.Manual,
            graph: structuredClone(template.graph) as WfGraph,
          },
          actor,
        );
        return created.definition.wfDefinitionId;
      } catch (err) {
        if (err instanceof ConflictException && attempt <= TEMPLATE_NAME_MAX_RETRIES) continue;
        throw err;
      }
    }
  }

  /** Pour chaque étape agent : jeu d'évaluation de départ (sans run), puis configuration au niveau « suggère ». */
  private async configureAgents(template: WorkflowTemplate, definitionId: number, actor: AuthUser): Promise<void> {
    for (const [stepKey, spec] of Object.entries(template.agentSteps)) {
      let evalSetId: number | undefined;
      if (template.evalSet && template.evalSetStepKey === stepKey) {
        const set = await this.evals.createSet(
          {
            definitionId,
            stepKey,
            name: template.evalSet.name,
            description: template.evalSet.description,
            minAccuracy: template.evalSet.minAccuracy,
          },
          actor,
        );
        evalSetId = set.wfEvalSetId;
        for (const [index, c] of template.evalSet.cases.entries()) {
          await this.evals.addCase(
            set.wfEvalSetId,
            { label: c.label, input: c.input, expected: c.expected, sortOrder: index + 1 },
            actor,
          );
        }
      }
      await this.definitions.upsertAgentConfig(
        definitionId,
        stepKey,
        {
          tools: [...spec.tools],
          confidenceThreshold: spec.confidenceThreshold,
          maxSteps: spec.maxSteps,
          timeoutSeconds: spec.timeoutSeconds,
          autonomy: 'suggere',
          ...(spec.objective !== undefined ? { objective: spec.objective } : {}),
          ...(evalSetId !== undefined ? { evalSetId } : {}),
        },
        actor,
      );
    }
  }

  /** Échec après création : archive le brouillon pour ne pas laisser une définition à moitié configurée. */
  private async discard(definitionId: number, actor: AuthUser): Promise<void> {
    try {
      await this.definitions.archive(definitionId, actor);
    } catch (err) {
      this.logger.error(`archivage du brouillon ${definitionId} en échec (${err instanceof Error ? err.name : 'erreur'})`);
    }
  }

  /** Une entrée d'audit par instanciation : identifiants seulement, aucun contenu. */
  private async journal(template: WorkflowTemplate, definitionId: number, actor: AuthUser): Promise<void> {
    try {
      await this.audit.dataChange({
        userGroupId: actor.userGroupId,
        actorFullName: actor.fullName ?? actor.username,
        objectRef: `wf_definition:${definitionId}`,
        newValue: JSON.stringify({
          action: 'template_instantiated',
          templateKey: template.key,
          templateSchemaVersion: template.schemaVersion,
          definitionId,
        }),
      });
    } catch (err) {
      this.logger.error(`audit wf_definition:${definitionId} en échec (${err instanceof Error ? err.name : 'erreur'})`);
    }
  }
}
