import { createHash } from 'node:crypto';
import { canonicalJson } from './definitions.service';

/**
 * Empreinte de la partie de la configuration d'un agent qui détermine son COMPORTEMENT : objectif, outils,
 * seuil, modèle, plafonds. Le niveau d'autonomie et le jeu lié sont exclus (ils changent après le run
 * d'évaluation). Enregistrée dans `wf_eval_run.results.agentSpecHash` ; la publication refuse une autonomie
 * « autonome » si l'empreinte actuelle diffère de celle du dernier run réussi (la config a changé depuis).
 */
export interface AgentSpecHashInput {
  objective: string;
  tools: readonly string[];
  confidenceThreshold: number | string;
  model?: string | null;
  maxSteps?: number | null;
  maxCostPerRun?: number | string | null;
  timeoutSeconds?: number | null;
}

export function agentSpecHash(spec: AgentSpecHashInput): string {
  const normalized = {
    objective: spec.objective.trim(),
    tools: [...spec.tools].sort(),
    confidenceThreshold: Number(spec.confidenceThreshold),
    model: spec.model ?? null,
    maxSteps: spec.maxSteps ?? 10,
    maxCostPerRun: spec.maxCostPerRun == null ? null : Number(spec.maxCostPerRun),
    timeoutSeconds: spec.timeoutSeconds ?? 120,
  };
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}

/**
 * Empreinte du jeu de cas ACTIFS d'un jeu d'évaluation (identifiant, entrée, attendu ; le libellé et le poids
 * n'entrent pas : ils ne changent pas le verdict). Enregistrée dans `wf_eval_run.results.casesHash` ; modifier,
 * ajouter, supprimer (désactiver) un cas après un run réussi change l'empreinte et invalide l'éligibilité autonome
 * (contrôle d'éligibilité à l'exécution ET à la publication).
 */
export function evalCasesHash(cases: ReadonlyArray<{ wfEvalCaseId: number; input: unknown; expected: unknown }>): string {
  const normalized = [...cases]
    .sort((a, b) => a.wfEvalCaseId - b.wfEvalCaseId)
    .map((c) => ({ id: c.wfEvalCaseId, input: c.input, expected: c.expected }));
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}
