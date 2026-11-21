import { z } from 'zod';
import { WF_AUTONOMY_KEYS, WF_TASK_TYPE_KEYS } from './wf-enums';
import { WF_KEY_PATTERN } from './wf-events';

// Docu-Flow — graphe d'étapes d'un workflow (colonne `wf_definition_version.graph`).
// Le validateur est PUR (aucune dépendance Node) : il tourne à l'identique dans l'api, le worker et le web.

export const WF_GRAPH_SCHEMA_VERSION = 1;
export const WF_GRAPH_MAX_STEPS = 200;

const STEP_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export const WF_ASSIGNEE_KINDS = ['user', 'group', 'role', 'initiator', 'subject_owner'] as const;
export const WF_CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'] as const;

const positiveInt = z.number().int().positive();

const wfAssigneeSchema = z
  .object({
    kind: z.enum(WF_ASSIGNEE_KINDS),
    id: positiveInt.optional(),
  })
  .superRefine((value, ctx) => {
    const needsId = value.kind === 'user' || value.kind === 'group' || value.kind === 'role';
    if (needsId && value.id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: "l'identifiant est obligatoire pour ce type d'affectation",
      });
    }
    if (!needsId && value.id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: "l'identifiant est interdit pour ce type d'affectation",
      });
    }
  });

const wfEdgeSchema = z.object({
  to: z.string().min(1),
  label: z.string().max(200).optional(),
  condition: z
    .object({
      field: z.string().min(1).max(200),
      op: z.enum(WF_CONDITION_OPS),
      value: z.unknown().optional(),
    })
    .optional(),
  isDefault: z.boolean().optional(),
});

const wfAgentStepSpecSchema = z.object({
  objective: z.string().min(1).max(4000),
  tools: z
    .array(z.string().min(1).max(100).regex(WF_KEY_PATTERN, "clé d'outil invalide"))
    .refine((tools) => new Set(tools).size === tools.length, {
      message: "la liste d'outils contient un doublon",
    }),
  confidenceThreshold: z.number().min(0).max(1).default(0.8),
  autonomy: z.enum(WF_AUTONOMY_KEYS).default('suggere'),
  model: z.string().max(200).optional(),
  maxSteps: positiveInt.max(50).optional(),
  maxCostPerRun: z.number().min(0).optional(),
});

const wfStepSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(100)
    .regex(STEP_KEY_PATTERN, "clé d'étape invalide (minuscules, chiffres et _, commence par une lettre)"),
  name: z.string().min(1).max(200),
  type: z.enum(WF_TASK_TYPE_KEYS),
  description: z.string().optional(),
  assignee: wfAssigneeSchema.optional(),
  dueInHours: positiveInt.optional(),
  reminderAfterHours: positiveInt.optional(),
  config: z.record(z.unknown()).optional(),
  agent: wfAgentStepSpecSchema.optional(),
  next: z.array(wfEdgeSchema).default([]),
});

export const wfGraphSchema = z.object({
  schemaVersion: z.literal(WF_GRAPH_SCHEMA_VERSION),
  start: z.string().min(1),
  steps: z.array(wfStepSchema).min(1).max(WF_GRAPH_MAX_STEPS),
});

export type WfGraph = z.infer<typeof wfGraphSchema>;
export type WfStep = WfGraph['steps'][number];
export type WfEdge = WfStep['next'][number];
export type WfAgentStepSpec = NonNullable<WfStep['agent']>;

export type WfGraphIssueCode =
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_STEP_KEY'
  | 'START_NOT_FOUND'
  | 'EDGE_TARGET_NOT_FOUND'
  | 'SELF_LOOP'
  | 'UNREACHABLE_STEP'
  | 'NO_TERMINAL_STEP'
  | 'STEP_CANNOT_REACH_TERMINAL'
  | 'AMBIGUOUS_BRANCHING'
  | 'AGENT_SPEC_MISSING'
  | 'AGENT_SPEC_ON_NON_AGENT'
  | 'DUPLICATE_EDGE_TARGET'
  | 'AUTONOMY_REQUIRES_LOW_RISK'
  | 'DECISION_NEEDS_BRANCHES';

export interface WfGraphIssue {
  code: WfGraphIssueCode;
  message: string;
  stepKey?: string;
  path?: (string | number)[];
}

export interface WfGraphValidationResult {
  ok: boolean;
  graph?: WfGraph;
  issues: WfGraphIssue[];
}

export interface WfGraphValidationOptions {
  /** Le workflow est marqué « à faible risque » (condition pour une étape agent autonome). */
  isLowRisk?: boolean;
}

/**
 * Valide un graphe : forme d'abord (SCHEMA_INVALID, une issue par erreur zod), puis, si la forme est
 * correcte, la sémantique (références, atteignabilité, branchements, étapes agent).
 * Itératif et linéaire en nombre d'étapes + arêtes.
 */
export function validateWorkflowGraph(
  input: unknown,
  options: WfGraphValidationOptions = {},
): WfGraphValidationResult {
  const parsed = wfGraphSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'SCHEMA_INVALID' as const,
        message: `Forme du graphe invalide${issue.path.length ? ` (${issue.path.join('.')})` : ''} : ${issue.message}`,
        path: issue.path,
      })),
    };
  }

  const graph = parsed.data;
  const issues: WfGraphIssue[] = [];
  const indexByKey = new Map<string, number>();

  // Clés d'étape (la première occurrence fait foi).
  graph.steps.forEach((step, i) => {
    if (indexByKey.has(step.key)) {
      issues.push({
        code: 'DUPLICATE_STEP_KEY',
        message: `La clé d'étape « ${step.key} » est utilisée plusieurs fois.`,
        stepKey: step.key,
        path: ['steps', i, 'key'],
      });
    } else {
      indexByKey.set(step.key, i);
    }
  });

  const startIndex = indexByKey.get(graph.start);
  if (startIndex === undefined) {
    issues.push({
      code: 'START_NOT_FOUND',
      message: `L'étape de départ « ${graph.start} » n'existe pas.`,
      path: ['start'],
    });
  }

  // Contrôles locaux à chaque étape + adjacence (indices d'étapes canoniques).
  const adjacency: number[][] = graph.steps.map(() => []);
  graph.steps.forEach((step, i) => {
    if (indexByKey.get(step.key) !== i) return; // doublon : ignoré pour le reste

    const seenTargets = new Set<string>();
    step.next.forEach((edge, j) => {
      const edgePath = ['steps', i, 'next', j];
      if (edge.to === step.key) {
        issues.push({
          code: 'SELF_LOOP',
          message: `L'étape « ${step.key} » pointe vers elle-même.`,
          stepKey: step.key,
          path: edgePath,
        });
      }
      if (seenTargets.has(edge.to)) {
        issues.push({
          code: 'DUPLICATE_EDGE_TARGET',
          message: `L'étape « ${step.key} » a plusieurs arêtes vers « ${edge.to} ».`,
          stepKey: step.key,
          path: edgePath,
        });
      }
      seenTargets.add(edge.to);

      const target = indexByKey.get(edge.to);
      if (target === undefined) {
        issues.push({
          code: 'EDGE_TARGET_NOT_FOUND',
          message: `L'étape « ${step.key} » pointe vers « ${edge.to} », qui n'existe pas.`,
          stepKey: step.key,
          path: [...edgePath, 'to'],
        });
      } else {
        at(adjacency, i).push(target);
      }
    });

    if (step.next.length > 1) {
      const fallbacks = step.next.filter(
        (e) => e.condition === undefined || e.isDefault === true,
      ).length;
      if (fallbacks > 1) {
        issues.push({
          code: 'AMBIGUOUS_BRANCHING',
          message: `L'étape « ${step.key} » a ${fallbacks} arêtes de repli : chaque arête sauf une doit porter une condition.`,
          stepKey: step.key,
          path: ['steps', i, 'next'],
        });
      }
    }

    if (step.type === 'agent' && step.agent === undefined) {
      issues.push({
        code: 'AGENT_SPEC_MISSING',
        message: `L'étape « ${step.key} » est de type agent mais n'a pas de configuration d'agent.`,
        stepKey: step.key,
        path: ['steps', i, 'agent'],
      });
    }
    if (step.type !== 'agent' && step.agent !== undefined) {
      issues.push({
        code: 'AGENT_SPEC_ON_NON_AGENT',
        message: `L'étape « ${step.key} » n'est pas de type agent mais porte une configuration d'agent.`,
        stepKey: step.key,
        path: ['steps', i, 'agent'],
      });
    }
    if (step.agent?.autonomy === 'autonome' && options.isLowRisk !== true) {
      issues.push({
        code: 'AUTONOMY_REQUIRES_LOW_RISK',
        message: `L'étape « ${step.key} » est autonome : le workflow doit d'abord être marqué à faible risque.`,
        stepKey: step.key,
        path: ['steps', i, 'agent', 'autonomy'],
      });
    }
    if (step.type === 'decision' && step.next.length < 2) {
      issues.push({
        code: 'DECISION_NEEDS_BRANCHES',
        message: `L'étape de décision « ${step.key} » doit avoir au moins deux arêtes sortantes.`,
        stepKey: step.key,
        path: ['steps', i, 'next'],
      });
    }
  });

  // Atteignabilité depuis le départ (parcours en largeur, itératif).
  if (startIndex !== undefined) {
    const reached = new Uint8Array(graph.steps.length);
    const queue: number[] = [startIndex];
    reached[startIndex] = 1;
    for (let head = 0; head < queue.length; head++) {
      for (const t of at(adjacency, at(queue, head))) {
        if (!reached[t]) {
          reached[t] = 1;
          queue.push(t);
        }
      }
    }

    graph.steps.forEach((step, i) => {
      if (indexByKey.get(step.key) === i && !reached[i]) {
        issues.push({
          code: 'UNREACHABLE_STEP',
          message: `L'étape « ${step.key} » n'est pas atteignable depuis l'étape de départ.`,
          stepKey: step.key,
          path: ['steps', i],
        });
      }
    });

    // Étapes terminales atteignables (aucune arête sortante déclarée).
    const terminals: number[] = [];
    for (const i of queue) {
      if (at(graph.steps, i).next.length === 0) terminals.push(i);
    }
    if (terminals.length === 0) {
      issues.push({
        code: 'NO_TERMINAL_STEP',
        message: "Le graphe n'a aucune étape finale (sans étape suivante) atteignable.",
        path: ['steps'],
      });
    } else {
      // Parcours inverse depuis les fins : toute étape atteignable non couverte boucle sans fin.
      const reverse: number[][] = graph.steps.map(() => []);
      for (const from of queue) {
        for (const to of at(adjacency, from)) at(reverse, to).push(from);
      }
      const canFinish = new Uint8Array(graph.steps.length);
      const stack = [...terminals];
      for (const t of terminals) canFinish[t] = 1;
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        for (const prev of at(reverse, cur)) {
          if (!canFinish[prev]) {
            canFinish[prev] = 1;
            stack.push(prev);
          }
        }
      }
      for (const i of queue) {
        if (!canFinish[i]) {
          issues.push({
            code: 'STEP_CANNOT_REACH_TERMINAL',
            message: `Depuis l'étape « ${at(graph.steps, i).key} », aucune étape finale n'est accessible (boucle sans fin).`,
            stepKey: at(graph.steps, i).key,
            path: ['steps', i],
          });
        }
      }
    }
  }

  return issues.length === 0 ? { ok: true, graph, issues } : { ok: false, issues };
}

/** Clés des étapes d'un graphe, dans l'ordre de déclaration. */
export function listWorkflowGraphStepKeys(graph: WfGraph): string[] {
  return graph.steps.map((s) => s.key);
}

/** Étapes de type agent, avec leur configuration. */
export function getWorkflowGraphAgentSteps(
  graph: WfGraph,
): Array<WfStep & { agent: WfAgentStepSpec }> {
  return graph.steps.filter(
    (s): s is WfStep & { agent: WfAgentStepSpec } => s.type === 'agent' && s.agent !== undefined,
  );
}

/** Accès indexé dont l'indice est garanti valide par construction (tableaux parallèles aux étapes). */
function at<T>(items: readonly T[], index: number): T {
  return items[index] as T;
}
