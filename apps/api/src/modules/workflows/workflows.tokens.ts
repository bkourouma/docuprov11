/** Jetons d'injection du module Docu-Flow (workflows). */

/** `WorkflowEngineApi` (instance de `WorkflowEngine`, construite en usine dans workflows.module.ts). */
export const WF_ENGINE = 'WF_ENGINE';

/** `WfTaskExecutorRegistry` : W2 y enregistre l'exécuteur 'agent' ; vide en W1. */
export const WF_EXECUTOR_REGISTRY = 'WF_EXECUTOR_REGISTRY';

/** `WfEffectApplierHolder` : W6 y branche l'applicateur des actions validées (vide : une action à appliquer est refusée). */
export const WF_EFFECT_APPLIER = 'WF_EFFECT_APPLIER';

/** `WfTriggerStarter` : point d'entrée des déclencheurs (W3). */
export const WF_TRIGGER_STARTER = 'WF_TRIGGER_STARTER';
