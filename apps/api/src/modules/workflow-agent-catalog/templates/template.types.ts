import type { WfGraph } from '@archivage/types';
import type { AgentKey, EvalSeedSet } from '../catalog.contracts';

// Docu-Flow (lot W6) : modèles de workflow prêts à l'emploi. Ce sont des DONNÉES versionnées dans le dépôt
// (jamais en base). Instancier un modèle crée un BROUILLON ordinaire que le concepteur complète (affectations,
// délégataires, autorisations d'outils) puis publie.

/** Paramètres d'exécution d'une étape agent (copiés dans `wf_agent_config` à l'instanciation). */
export interface TemplateAgentStep {
  /** Outils autorisés pour l'étape (clés du registre). Aucun outil d'effet 2 ; jamais d'autorisation créée. */
  tools: string[];
  confidenceThreshold: number;
  maxSteps: number;
  timeoutSeconds: number;
  /** Facultatif : remplace l'objectif du graphe à l'instanciation. */
  objective?: string;
}

export interface WorkflowTemplate {
  /** Clé stable (`^[a-z0-9-]+$`), valeur de `TEMPLATE_KEYS`. */
  key: string;
  name: string;
  description: string;
  /** Agent mis en oeuvre, ou null pour un modèle sans IA. */
  agentKey: AgentKey | null;
  tags: string[];
  /** Version de la DONNÉE du modèle (entier, à incrémenter à chaque évolution du contenu). */
  schemaVersion: number;
  graph: WfGraph;
  /** Par clé d'étape agent du graphe. */
  agentSteps: Record<string, TemplateAgentStep>;
  /** Jeu d'évaluation de départ (aucun run n'est créé : l'autonomie reste non éligible). */
  evalSet?: EvalSeedSet;
  /** Étape agent à laquelle le jeu est lié (obligatoire si `evalSet` est présent). */
  evalSetStepKey?: string;
  /** Texte indicatif : déclencheur conseillé (jamais créé automatiquement). */
  suggestedTrigger?: string;
}

/** Projection publique (GET /workflows/templates) : CONTRAT FIXE, aucun champ de plus ni de moins. */
export interface WorkflowTemplateSummary {
  key: string;
  name: string;
  description: string;
  agentKey: AgentKey | null;
  tags: string[];
}

/** Réponse de POST /workflows/templates/:key/instantiate : CONTRAT FIXE. */
export interface InstantiateTemplateResult {
  definitionId: number;
}
