// Docu-Flow E2E : graphes et appels liés aux agents (outils autorisés, évaluation, budget, arrêt d'urgence).
// Aucun fournisseur IA : le mode IA de la pile E2E est « désactivé » ; l'exécuteur d'agent rend alors la main
// à l'humain (`ai_disabled`, apps/api/src/modules/workflow-agents/executor/agent-executor.ts).

import type { ApiLike, WfGraph } from './wf-api';

/** Graphe publiable à une étape agent (« suggère » par défaut), assignée au lanceur, terminale. */
export function agentGraph(opts: { tools?: string[]; autonomy?: 'suggere' | 'agit_avec_validation' | 'autonome' } = {}): WfGraph {
  return {
    schemaVersion: 1,
    start: 'analyse',
    steps: [
      {
        key: 'analyse',
        name: 'Analyse du dossier',
        type: 'agent',
        assignee: { kind: 'initiator' },
        agent: {
          objective: 'Lire le dossier et proposer une suite.',
          tools: opts.tools ?? [],
          confidenceThreshold: 0.8,
          autonomy: opts.autonomy ?? 'suggere',
        },
        next: [],
      },
    ],
  };
}

export interface WfBudgetDto {
  wfBudgetId: number;
  definitionId: number | null;
  periodKind: number;
  capAmount: string | null;
  consumedAmount: string;
  currency: string;
  alertThreshold: string;
  emergencyStop: boolean;
  emergencyStopReason: string | null;
}

export interface WfAgentBudgetOverview {
  global: WfBudgetDto;
  workflows: WfBudgetDto[];
}

export function getBudget(api: ApiLike): Promise<WfAgentBudgetOverview> {
  return api.get('/workflows/agents/budget');
}

export function setWorkflowBudget(
  api: ApiLike,
  definitionId: number,
  input: { capAmount?: number | null; currency?: string; alertThreshold?: number; periodKind?: 0 | 1 | 2 },
): Promise<WfBudgetDto> {
  return api.put('/workflows/agents/budget', { definitionId, ...input });
}

export function setEmergencyStop(api: ApiLike, definitionId: number | null, active: boolean, reason?: string): Promise<WfBudgetDto> {
  return api.post('/workflows/agents/emergency-stop', { definitionId, active, ...(reason ? { reason } : {}) });
}

export function replaceToolGrants(
  api: ApiLike,
  definitionId: number,
  grants: Array<{ toolKey: string; maxCallsPerInstance?: number | null }>,
): Promise<unknown> {
  return api.put(`/workflows/agents/definitions/${definitionId}/tool-grants`, { grants });
}

export function setLowRisk(api: ApiLike, definitionId: number, isLowRisk: boolean): Promise<unknown> {
  return api.post(`/workflows/definitions/${definitionId}/low-risk`, { isLowRisk });
}

export interface WfEvalSetDto {
  wfEvalSetId: number;
  definitionId: number;
  stepKey: string | null;
  name: string;
}

export interface WfEvalRunDto {
  wfEvalRunId: string;
  status: number; // 0 en cours, 1 terminé, 2 en erreur
  totalCases: number;
  passed: boolean;
  errorMessage: string | null;
}

/** GET /workflows/agents/definitions/:id/tool-grants (menu administration). */
export interface WfToolGrantDto {
  toolKey: string;
  maxCallsPerInstance: number | null;
}

export function getToolGrants(api: ApiLike, definitionId: number): Promise<WfToolGrantDto[]> {
  return api.get(`/workflows/agents/definitions/${definitionId}/tool-grants`);
}

/** POST /workflows/definitions/:id/validate : contrôles du brouillon enregistré, sans écriture. */
export function validateDraft(api: ApiLike, definitionId: number): Promise<{ ok: boolean; issues: Array<{ code: string; message: string; stepKey?: string }> }> {
  return api.post(`/workflows/definitions/${definitionId}/validate`, {});
}

/** Outil en lecture seule du catalogue de base (base-tools.ts), autorisable sans validation humaine. */
export const READ_TOOL = { key: 'rechercher_documents', label: 'Rechercher des documents' } as const;

export function createEvalSet(
  api: ApiLike,
  input: { definitionId: number; stepKey?: string | null; name: string; minAccuracy?: number },
): Promise<WfEvalSetDto> {
  return api.post('/workflows/agents/eval-sets', input);
}

export function createEvalCase(api: ApiLike, setId: number, label: string): Promise<unknown> {
  return api.post(`/workflows/agents/eval-sets/${setId}/cases`, {
    label,
    input: { context: { dossier: 'E2E' } },
    expected: { returnsToHuman: true },
  });
}
