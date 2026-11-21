import { isWfTaskTypeKey } from '@archivage/types';
import type { WfTaskExecutor, WfTaskExecutorRegistry } from './engine.types';

/**
 * Registre en mémoire des exécuteurs de tâches (un par type d'étape). Vide en W1 ; W2 y enregistre
 * l'exécuteur 'agent'. Refuse un type inconnu et un DOUBLE enregistrement (jamais de remplacement
 * silencieux d'un exécuteur par un autre).
 */
export class WfExecutorRegistry implements WfTaskExecutorRegistry {
  private readonly executors = new Map<string, WfTaskExecutor>();

  register(executor: WfTaskExecutor): void {
    const type = executor?.taskType;
    if (!isWfTaskTypeKey(type)) {
      throw new Error(`Type de tâche inconnu pour un exécuteur : « ${String(type)} ».`);
    }
    if (typeof executor.execute !== 'function') {
      throw new Error(`L'exécuteur « ${type} » n'a pas de méthode execute.`);
    }
    if (this.executors.has(type)) {
      throw new Error(`Un exécuteur est déjà enregistré pour le type de tâche « ${type} ».`);
    }
    this.executors.set(type, executor);
  }

  get(taskType: string): WfTaskExecutor | undefined {
    return this.executors.get(taskType);
  }

  has(taskType: string): boolean {
    return this.executors.has(taskType);
  }

  /** Types couverts (ordre d'enregistrement). */
  types(): string[] {
    return [...this.executors.keys()];
  }
}
