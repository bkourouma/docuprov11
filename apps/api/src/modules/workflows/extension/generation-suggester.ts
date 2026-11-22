import { Logger } from '@nestjs/common';
import type { WfExecutorContext, WfExecutorOutcome, WfTaskExecutor } from '../engine/engine.types';

/** Jeton facultatif : un module fournisseur peut le déclarer pour brancher la suggestion de rédaction. */
export const WF_GENERATION_SUGGESTER = 'WF_GENERATION_SUGGESTER';

export interface WfGenerationSuggestion {
  content: string;
  explanation?: string;
  sources?: unknown;
  confidence?: number;
}

/**
 * Point d'extension « génération assistée ». Le fournisseur SUGGÈRE seulement : la suggestion devient une
 * proposition de boîte (kind 1) que l'humain accepte ou ignore, jamais un résultat appliqué seul.
 *
 * W1 : aucune implémentation (le module drafting n'exporte pas son service). Pour brancher : fournir
 * `{ provide: WF_GENERATION_SUGGESTER, useClass: ... }` dans `WorkflowsModule` (ou un module importé qui
 * l'exporte) ; le module enregistre alors l'exécuteur ci-dessous pour le type de tâche 'generation'.
 */
export interface WfGenerationSuggester {
  suggest(input: {
    instanceId: string;
    taskId: string;
    stepKey: string;
    context: Readonly<Record<string, unknown>>;
    /** Droits d'exécution : ceux du lanceur. */
    runAs: { userGroupId: number };
    /** (Ajout W2, facultatif) Définition de l'instance : permet au fournisseur de passer par la garde budgétaire. */
    definitionId?: number;
  }): Promise<WfGenerationSuggestion>;
}

/**
 * Exécuteur du type 'generation'. Toute erreur du fournisseur laisse la tâche ouverte à l'humain
 * (`wait`) : une suggestion absente ne bloque ni ne fait échouer le workflow.
 */
export function createGenerationSuggestionExecutor(suggester: WfGenerationSuggester): WfTaskExecutor {
  const logger = new Logger('WfGenerationSuggestionExecutor');
  return {
    taskType: 'generation',
    async execute(ctx: WfExecutorContext): Promise<WfExecutorOutcome> {
      try {
        const s = await suggester.suggest({
          instanceId: ctx.instanceId,
          taskId: ctx.taskId,
          stepKey: ctx.step.key,
          context: ctx.context,
          runAs: ctx.runAs,
          definitionId: ctx.definitionId,
        });
        if (!s.content?.trim()) return { kind: 'wait' };
        return {
          kind: 'propose',
          proposal: { content: s.content },
          explanation: s.explanation,
          sources: s.sources,
          confidence: s.confidence,
        };
      } catch (err) {
        logger.warn(
          `suggestion indisponible (tâche laissée à l'humain) : ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: 'wait' };
      }
    },
  };
}
