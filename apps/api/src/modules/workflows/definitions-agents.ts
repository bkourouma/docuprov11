import type { Prisma } from '@prisma/client';
import {
  WF_EVAL_ACCURACY_FLOOR,
  wfAutonomyFromKey,
  type WfAgentConfigDetailDto,
  type WfAgentStepSpec,
  type WfAutonomyKey,
  type WfGraph,
  type WfStep,
} from '@archivage/types';
import { agentSpecHash, evalCasesHash } from './agent-spec-hash';
import type { WfDefinitionIssue } from './definitions.dto';

// Docu-Flow (lot W2) — configuration des étapes agent d'une version de workflow : le GRAPHE du brouillon
// est la source de vérité des champs communs (objectif, outils, seuil, autonomie, modèle, plafonds) ;
// la ligne `wf_agent_config` (+ `wf_agent_config_tool`) en est la copie d'exécution, plus les champs qui lui
// sont propres (`timeoutSeconds`, `evalSetId`). Le SQL fige la configuration d'une version dès sa mise à
// publication : tout se prépare donc sur le brouillon, puis `syncAgentConfigsFromGraph` aligne les lignes
// juste AVANT la publication.

type Tx = Prisma.TransactionClient;

export const AGENT_DEFAULT_TIMEOUT_SECONDS = 120;
export const AGENT_DEFAULT_MAX_STEPS = 10;
const TIMEOUT_MAX_SECONDS = 3600;

/** Seuil : colonne `Decimal(4,3)`. Arrondir avant écriture garde graphe, ligne et empreinte identiques. */
export function roundThreshold(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Plafond de coût : colonne `Decimal(14,4)`. */
export function roundCost(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Configuration effective d'une étape (valeurs par défaut appliquées, arrondis de colonne appliqués). */
export interface EffectiveAgentSpec {
  objective: string;
  tools: string[];
  confidenceThreshold: number;
  autonomy: WfAutonomyKey;
  model: string | null;
  maxSteps: number;
  maxCostPerRun: number | null;
  timeoutSeconds: number;
}

export function effectiveSpec(spec: WfAgentStepSpec, timeoutSeconds: number | null | undefined): EffectiveAgentSpec {
  return {
    objective: spec.objective,
    tools: [...spec.tools],
    confidenceThreshold: roundThreshold(spec.confidenceThreshold),
    autonomy: spec.autonomy,
    model: spec.model ?? null,
    maxSteps: spec.maxSteps ?? AGENT_DEFAULT_MAX_STEPS,
    maxCostPerRun: spec.maxCostPerRun === undefined ? null : roundCost(spec.maxCostPerRun),
    timeoutSeconds: timeoutSeconds ?? AGENT_DEFAULT_TIMEOUT_SECONDS,
  };
}

/** Empreinte du COMPORTEMENT de l'étape (comparée à `wf_eval_run.results.agentSpecHash`). */
export function effectiveSpecHash(e: EffectiveAgentSpec): string {
  return agentSpecHash({
    objective: e.objective,
    tools: e.tools,
    confidenceThreshold: e.confidenceThreshold,
    model: e.model,
    maxSteps: e.maxSteps,
    maxCostPerRun: e.maxCostPerRun,
    timeoutSeconds: e.timeoutSeconds,
  });
}

export interface AgentStepRef {
  step: WfStep;
  index: number;
  spec: WfAgentStepSpec;
}

/** Étapes de type agent portant une configuration (celles sans configuration sont signalées par le graphe). */
export function agentStepsOf(graph: WfGraph): AgentStepRef[] {
  const out: AgentStepRef[] = [];
  graph.steps.forEach((step, index) => {
    if (step.type === 'agent' && step.agent !== undefined) out.push({ step, index, spec: step.agent });
  });
  return out;
}

/** Clés d'étapes agent d'un graphe JSON brut (lecture tolérante, sans validation de schéma). */
export function agentStepKeysOfRaw(rawGraph: unknown): Set<string> {
  const keys = new Set<string>();
  const steps = (rawGraph as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return keys;
  for (const s of steps) {
    const step = s as { key?: unknown; type?: unknown } | null;
    if (step && step.type === 'agent' && typeof step.key === 'string') keys.add(step.key);
  }
  return keys;
}

export interface AgentConfigRowLite {
  wfAgentConfigId: number;
  timeoutSeconds: number;
  evalSetId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Vue d'une étape : champs communs lus dans le GRAPHE (source de vérité), champs propres lus dans la ligne.
 * Sans ligne (étape ajoutée au graphe, jamais configurée) : `wfAgentConfigId` vaut 0 (non persistée).
 */
export function buildAgentConfigDetail(
  versionId: number,
  ref: AgentStepRef,
  row: AgentConfigRowLite | null,
  fallbackDate: Date,
): WfAgentConfigDetailDto {
  const eff = effectiveSpec(ref.spec, row?.timeoutSeconds);
  return {
    wfAgentConfigId: row?.wfAgentConfigId ?? 0,
    definitionVersionId: versionId,
    stepKey: ref.step.key,
    objective: eff.objective,
    autonomyLevel: wfAutonomyFromKey(eff.autonomy),
    confidenceThreshold: eff.confidenceThreshold.toFixed(3),
    model: eff.model,
    maxSteps: eff.maxSteps,
    maxCostPerRun: eff.maxCostPerRun === null ? null : eff.maxCostPerRun.toFixed(4),
    timeoutSeconds: eff.timeoutSeconds,
    evalSetId: row?.evalSetId ?? null,
    createdAt: (row?.createdAt ?? fallbackDate).toISOString(),
    updatedAt: (row?.updatedAt ?? fallbackDate).toISOString(),
    tools: eff.tools,
    agentSpecHash: effectiveSpecHash(eff),
  };
}

// ---------------------------------------------------------------------------------------------
// Copie vers un nouveau brouillon
// ---------------------------------------------------------------------------------------------

/**
 * Recopie les configurations (et leurs outils) d'une version vers un nouveau brouillon : seules les étapes
 * encore de type agent dans le nouveau graphe. `evalSetId` et `timeoutSeconds` sont conservés. Le niveau
 * « autonome » est recopié en « agit avec validation » : le déclencheur SQL exige un run d'évaluation
 * réussi pour CETTE version, qui n'existe pas encore ; le graphe garde le niveau voulu, et la publication
 * exigera une nouvelle évaluation (`AGENT_AUTONOMY_NOT_ELIGIBLE`).
 */
export async function copyAgentConfigs(
  tx: Tx,
  fromVersionId: number,
  toVersionId: number,
  newRawGraph: unknown,
): Promise<number> {
  const keep = agentStepKeysOfRaw(newRawGraph);
  if (keep.size === 0) return 0;
  const rows = await tx.wfAgentConfig.findMany({
    where: { definitionVersionId: fromVersionId },
    include: { tools: { select: { toolId: true } } },
    orderBy: { wfAgentConfigId: 'asc' },
  });
  let copied = 0;
  for (const row of rows) {
    if (!keep.has(row.stepKey)) continue;
    await tx.wfAgentConfig.create({
      data: {
        definitionVersionId: toVersionId,
        stepKey: row.stepKey,
        objective: row.objective,
        autonomyLevel: Math.min(row.autonomyLevel, 1),
        confidenceThreshold: row.confidenceThreshold,
        model: row.model,
        maxSteps: row.maxSteps,
        maxCostPerRun: row.maxCostPerRun,
        timeoutSeconds: row.timeoutSeconds,
        evalSetId: row.evalSetId,
        tools: { create: row.tools.map((t) => ({ toolId: t.toolId })) },
      },
    });
    copied++;
  }
  return copied;
}

// ---------------------------------------------------------------------------------------------
// Synchronisation à la publication
// ---------------------------------------------------------------------------------------------

/**
 * Aligne `wf_agent_config` / `wf_agent_config_tool` de la version sur son graphe (source de vérité) :
 * upsert par étape agent (`timeoutSeconds` et `evalSetId` existants préservés), outils alignés, lignes des
 * étapes qui ne sont plus agent supprimées. À appeler dans la transaction de publication, AVANT de passer la
 * version à « publiée » (ensuite le SQL refuse toute écriture).
 */
export async function syncAgentConfigsFromGraph(tx: Tx, versionId: number, graph: WfGraph): Promise<void> {
  const steps = agentStepsOf(graph);
  const keys = steps.map((s) => s.step.key);

  // Étapes qui ne sont plus agent : outils d'abord (déclencheur de gel), puis lignes.
  await tx.wfAgentConfigTool.deleteMany({
    where: { agentConfig: { definitionVersionId: versionId, stepKey: { notIn: keys } } },
  });
  await tx.wfAgentConfig.deleteMany({ where: { definitionVersionId: versionId, stepKey: { notIn: keys } } });
  if (steps.length === 0) return;

  const existing = await tx.wfAgentConfig.findMany({
    where: { definitionVersionId: versionId },
    include: { tools: { select: { toolId: true } } },
  });
  const byKey = new Map(existing.map((r) => [r.stepKey, r]));
  const wantedKeys = [...new Set(steps.flatMap((s) => s.spec.tools))];
  const toolRows = wantedKeys.length
    ? await tx.wfTool.findMany({ where: { toolKey: { in: wantedKeys } }, select: { wfToolId: true, toolKey: true } })
    : [];
  const toolIdByKey = new Map(toolRows.map((t) => [t.toolKey, t.wfToolId]));

  for (const { step, spec } of steps) {
    const eff = effectiveSpec(spec, byKey.get(step.key)?.timeoutSeconds);
    const common = {
      objective: eff.objective,
      autonomyLevel: wfAutonomyFromKey(eff.autonomy),
      confidenceThreshold: eff.confidenceThreshold,
      model: eff.model,
      maxSteps: eff.maxSteps,
      maxCostPerRun: eff.maxCostPerRun,
    };
    const row = byKey.get(step.key);
    const saved = row
      ? await tx.wfAgentConfig.update({ where: { wfAgentConfigId: row.wfAgentConfigId }, data: common })
      : await tx.wfAgentConfig.create({
          data: { definitionVersionId: versionId, stepKey: step.key, ...common, timeoutSeconds: eff.timeoutSeconds },
        });
    const wantedIds = new Set(
      eff.tools.map((k) => toolIdByKey.get(k)).filter((id): id is number => id !== undefined),
    );
    const currentIds = new Set((row?.tools ?? []).map((t) => t.toolId));
    const stale = [...currentIds].filter((id) => !wantedIds.has(id));
    const fresh = [...wantedIds].filter((id) => !currentIds.has(id));
    if (stale.length > 0) {
      await tx.wfAgentConfigTool.deleteMany({
        where: { agentConfigId: saved.wfAgentConfigId, toolId: { in: stale } },
      });
    }
    if (fresh.length > 0) {
      await tx.wfAgentConfigTool.createMany({
        data: fresh.map((toolId) => ({ agentConfigId: saved.wfAgentConfigId, toolId })),
        skipDuplicates: true,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Contrôles de publication (lecture seule)
// ---------------------------------------------------------------------------------------------

export interface AgentIssueArgs {
  definitionId: number;
  versionId: number;
  graph: WfGraph;
}

/**
 * Contrôles des étapes agent d'un brouillon : configuration, outils (existent, activés, autorisés pour le
 * workflow), éligibilité à l'autonomie. N'écrit rien. Le marquage « faible risque » est déjà vérifié par le
 * graphe (`AUTONOMY_REQUIRES_LOW_RISK`).
 */
export async function collectAgentIssues(db: Tx, args: AgentIssueArgs): Promise<WfDefinitionIssue[]> {
  const steps = agentStepsOf(args.graph);
  if (steps.length === 0) return [];
  const issues: WfDefinitionIssue[] = [];

  const rows = await db.wfAgentConfig.findMany({
    where: { definitionVersionId: args.versionId },
    select: { stepKey: true, timeoutSeconds: true, evalSetId: true },
  });
  const rowByKey = new Map(rows.map((r) => [r.stepKey, r]));

  const keys = [...new Set(steps.flatMap((s) => s.spec.tools))];
  const tools = keys.length
    ? await db.wfTool.findMany({ where: { toolKey: { in: keys } }, select: { wfToolId: true, toolKey: true, isEnabled: true } })
    : [];
  const toolByKey = new Map(tools.map((t) => [t.toolKey, t]));
  const grants = tools.length
    ? await db.wfToolGrant.findMany({
        where: { definitionId: args.definitionId, toolId: { in: tools.map((t) => t.wfToolId) } },
        select: { toolId: true },
      })
    : [];
  const grantedIds = new Set(grants.map((g) => g.toolId));

  for (const ref of steps) {
    const { step, index, spec } = ref;
    const row = rowByKey.get(step.key);
    const eff = effectiveSpec(spec, row?.timeoutSeconds);
    const path = (...rest: (string | number)[]): (string | number)[] => ['steps', index, 'agent', ...rest];

    // Configuration
    const invalid: string[] = [];
    if (!eff.objective.trim()) invalid.push("l'objectif est vide");
    if (!Number.isFinite(eff.confidenceThreshold) || eff.confidenceThreshold < 0 || eff.confidenceThreshold > 1) {
      invalid.push('le seuil de confiance doit être compris entre 0 et 1');
    }
    if (!Number.isInteger(eff.maxSteps) || eff.maxSteps < 1 || eff.maxSteps > 50) {
      invalid.push("le nombre maximal d'étapes doit être compris entre 1 et 50");
    }
    if (eff.maxCostPerRun !== null && (!Number.isFinite(eff.maxCostPerRun) || eff.maxCostPerRun < 0)) {
      invalid.push('le plafond de coût par exécution ne peut pas être négatif');
    }
    if (!Number.isInteger(eff.timeoutSeconds) || eff.timeoutSeconds < 1 || eff.timeoutSeconds > TIMEOUT_MAX_SECONDS) {
      invalid.push(`le délai maximal doit être compris entre 1 et ${TIMEOUT_MAX_SECONDS} secondes`);
    }
    if (invalid.length > 0) {
      issues.push({
        code: 'AGENT_CONFIG_INVALID',
        message: `Configuration d’agent invalide sur l’étape « ${step.key} » : ${invalid.join(' ; ')}.`,
        stepKey: step.key,
        path: path(),
      });
    }

    // Outils
    const unknown = eff.tools.filter((k) => {
      const t = toolByKey.get(k);
      return t === undefined || !t.isEnabled;
    });
    if (unknown.length > 0) {
      issues.push({
        code: 'AGENT_TOOL_UNKNOWN',
        message: `L’étape « ${step.key} » utilise des outils inconnus ou désactivés : ${unknown.join(', ')}.`,
        stepKey: step.key,
        path: path('tools'),
      });
    }
    const notGranted = eff.tools.filter((k) => {
      const t = toolByKey.get(k);
      return t !== undefined && t.isEnabled && !grantedIds.has(t.wfToolId);
    });
    if (notGranted.length > 0) {
      issues.push({
        code: 'AGENT_TOOL_NOT_GRANTED',
        message: `L’étape « ${step.key} » utilise des outils non autorisés pour ce workflow : ${notGranted.join(', ')}. Autorisez-les d’abord.`,
        stepKey: step.key,
        path: path('tools'),
      });
    }

    // Autonomie (le marquage faible risque est déjà contrôlé par le graphe)
    if (eff.autonomy === 'autonome') {
      const reason = await autonomyIneligibility(db, args, eff, row?.evalSetId ?? null);
      if (reason !== null) {
        issues.push({
          code: 'AGENT_AUTONOMY_NOT_ELIGIBLE',
          message: `Le niveau autonome de l’étape « ${step.key} » est refusé : ${reason}`,
          stepKey: step.key,
          path: path('autonomy'),
        });
      }
    }
  }
  return issues;
}

/** Première raison pour laquelle l'étape ne peut pas être autonome, ou null si elle le peut. */
async function autonomyIneligibility(
  db: Tx,
  args: AgentIssueArgs,
  eff: EffectiveAgentSpec,
  evalSetId: number | null,
): Promise<string | null> {
  if (evalSetId === null) return 'aucun jeu d’évaluation n’est lié à l’étape.';
  const set = await db.wfEvalSet.findUnique({
    where: { wfEvalSetId: evalSetId },
    select: { definitionId: true, isActive: true, minAccuracy: true },
  });
  if (!set || set.definitionId !== args.definitionId) {
    return 'le jeu d’évaluation lié est introuvable ou n’appartient pas à ce workflow.';
  }
  if (!set.isActive) return 'le jeu d’évaluation lié est désactivé.';
  const minAccuracy = Number(set.minAccuracy);
  if (!(minAccuracy >= WF_EVAL_ACCURACY_FLOOR)) {
    return `le seuil de précision du jeu d’évaluation (${minAccuracy.toFixed(3)}) est inférieur au plancher de ${WF_EVAL_ACCURACY_FLOOR.toFixed(1)}.`;
  }
  const required = Math.max(WF_EVAL_ACCURACY_FLOOR, minAccuracy);
  const runs = await db.wfEvalRun.findMany({
    where: {
      evalSetId,
      definitionVersionId: args.versionId,
      status: 1,
      passed: true,
      totalCases: { gt: 0 },
    },
    select: { requiredAccuracy: true, results: true },
    orderBy: { wfEvalRunId: 'desc' },
    take: 50,
  });
  const eligible = runs.filter((r) => Number(r.requiredAccuracy) >= required);
  if (eligible.length === 0) return 'aucun run d’évaluation réussi pour cette version avec ce jeu.';
  const hash = effectiveSpecHash(eff);
  const specMatching = eligible.filter((r) => {
    const results = r.results as { agentSpecHash?: unknown } | null;
    return results !== null && typeof results === 'object' && results.agentSpecHash === hash;
  });
  if (specMatching.length === 0) {
    return 'la configuration de l’étape a changé depuis la dernière évaluation réussie : relancez l’évaluation.';
  }
  // Les cas du jeu ne doivent pas avoir changé depuis le run (ajout, modification, désactivation).
  const activeCases = await db.wfEvalCase.findMany({
    where: { evalSetId, isActive: true },
    select: { wfEvalCaseId: true, input: true, expected: true },
  });
  const casesHash = evalCasesHash(activeCases);
  const sameCases = specMatching.some((r) => (r.results as { casesHash?: unknown } | null)?.casesHash === casesHash);
  if (!sameCases) {
    return 'les cas du jeu d’évaluation ont changé depuis la dernière évaluation réussie : relancez l’évaluation.';
  }
  return null;
}
