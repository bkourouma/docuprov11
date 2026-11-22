import { validateWorkflowGraph, type WfTriggerEventType } from '@archivage/types';

// Docu-Flow W5 — contrôle de STRUCTURE d'un brouillon de workflow par rapport aux attentes d'un cas d'évaluation.
// Fonction pure : renvoie la liste des écarts en français (vide si le graphe est conforme). Sert à mesurer la
// qualité de génération ; ce n'est PAS le gate d'autonomie des agents.

export interface AuthoringEvalExpectation {
  minSteps: number;
  maxSteps: number;
  /** Types d'étape qui doivent tous figurer au moins une fois. */
  stepTypes: string[];
  /** Outils que les étapes agent ont le droit d'utiliser (liste vide : aucune étape agent attendue). */
  agentToolsAllowed: string[];
  /** Une étape `decision` à deux branches au moins est requise. */
  needsDecision: boolean;
  /** Une étape `validation` est requise. */
  needsApproval: boolean;
  /** Libellés d'affectation attendus (ex. « DAF »), lus dans `assigneeHint` ou le marqueur à compléter. */
  humanSteps: string[];
  triggerEvent: WfTriggerEventType | null;
  /** Sous-chaînes attendues dans les hypothèses (ex. « 5 000 000 »). */
  assumptionsMention: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Libellés d'affectation d'une étape : `assigneeHint` brut ou marqueur `config.authoring`. */
function hintsOf(step: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof step.assigneeHint === 'string') out.push(step.assigneeHint);
  const config = isRecord(step.config) ? step.config : undefined;
  const marker = config && isRecord(config.authoring) ? config.authoring : undefined;
  if (marker) {
    if (typeof marker.assigneeHint === 'string') out.push(marker.assigneeHint);
    if (Array.isArray(marker.toComplete)) {
      for (const e of marker.toComplete) if (isRecord(e) && typeof e.hint === 'string') out.push(e.hint);
    }
  }
  return out;
}

/** Liste des écarts entre `graph` (brut ou nettoyé) et `attendu`. Vide si tout est conforme. */
export function checkStructure(graph: unknown, attendu: AuthoringEvalExpectation): string[] {
  const gaps: string[] = [];
  if (!isRecord(graph) || !Array.isArray(graph.steps)) return ['Le graphe est absent ou illisible.'];

  const validation = validateWorkflowGraph(graph);
  if (!validation.ok) {
    for (const issue of validation.issues.slice(0, 3)) gaps.push(`Graphe invalide : ${issue.message}`);
    if (validation.issues.length > 3) gaps.push(`Graphe invalide : ${validation.issues.length - 3} autre(s) problème(s).`);
  }

  const steps = graph.steps.filter(isRecord);
  if (steps.length < attendu.minSteps) {
    gaps.push(`Trop peu d'étapes : ${steps.length} (au moins ${attendu.minSteps} attendues).`);
  }
  if (steps.length > attendu.maxSteps) {
    gaps.push(`Trop d'étapes : ${steps.length} (au plus ${attendu.maxSteps} attendues).`);
  }

  const types = new Set(steps.map((s) => (typeof s.type === 'string' ? s.type : '')));
  for (const t of attendu.stepTypes) {
    if (!types.has(t)) gaps.push(`Aucune étape de type « ${t} » alors qu'elle est attendue.`);
  }

  const agentSteps = steps.filter((s) => s.type === 'agent');
  if (attendu.agentToolsAllowed.length === 0 && agentSteps.length > 0) {
    gaps.push("Une étape agent est présente alors qu'aucune n'est attendue.");
  }
  for (const s of agentSteps) {
    const agent = isRecord(s.agent) ? s.agent : {};
    const tools = Array.isArray(agent.tools) ? agent.tools : [];
    for (const tool of tools) {
      if (typeof tool !== 'string' || !attendu.agentToolsAllowed.includes(tool)) {
        gaps.push(`L'étape « ${String(s.key)} » utilise un outil hors liste attendue.`);
      }
    }
    if (agent.autonomy !== undefined && agent.autonomy !== 'suggere') {
      gaps.push(`L'étape « ${String(s.key)} » a une autonomie autre que « suggere ».`);
    }
  }

  for (const s of steps) {
    const assignee = isRecord(s.assignee) ? s.assignee : undefined;
    if (assignee && (assignee.id !== undefined || ['user', 'group', 'role'].includes(String(assignee.kind)))) {
      gaps.push(`L'étape « ${String(s.key)} » porte un identifiant d'affectation (jamais inventé par le générateur).`);
    }
  }

  if (attendu.needsDecision) {
    const ok = steps.some((s) => s.type === 'decision' && Array.isArray(s.next) && s.next.length >= 2);
    if (!ok) gaps.push('Aucune décision à deux branches au moins.');
  }
  if (attendu.needsApproval && !steps.some((s) => s.type === 'validation')) {
    gaps.push('Aucune étape de validation.');
  }

  const hints = steps.flatMap(hintsOf).map(fold);
  for (const label of attendu.humanSteps) {
    const wanted = fold(label);
    if (!hints.some((h) => h.includes(wanted))) gaps.push(`Aucune affectation « ${label} » trouvée.`);
  }

  return gaps;
}

/** Hypothèses attendues : liste des sous-chaînes absentes (vide si toutes présentes). */
export function checkAssumptions(assumptions: readonly string[], attendu: AuthoringEvalExpectation): string[] {
  const text = assumptions.join('\n');
  return attendu.assumptionsMention
    .filter((m) => !text.includes(m))
    .map((m) => `Les hypothèses ne mentionnent pas « ${m} ».`);
}
