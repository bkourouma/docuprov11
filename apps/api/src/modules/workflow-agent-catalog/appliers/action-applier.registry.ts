import { Injectable } from '@nestjs/common';
import type { ActionApplier } from '../catalog.contracts';

const TOOL_KEY_PATTERN = /^[a-z0-9_.]+$/;

/**
 * Registre des applicateurs d'effets (un par outil d'écriture, clé = `WfPreparedAction.tool`).
 * Refuse : clé invalide, doublon, et tout applicateur d'effet IRRÉVERSIBLE (`sideEffect` 2) — aucun effet
 * irréversible ne s'applique sans validation humaine, et ce lot n'en déclare aucun.
 */
@Injectable()
export class ActionApplierRegistry {
  private readonly appliers = new Map<string, ActionApplier>();

  register(applier: ActionApplier): void {
    const key = applier.toolKey;
    if (typeof key !== 'string' || key.length === 0 || key.length > 100 || !TOOL_KEY_PATTERN.test(key)) {
      throw new Error('Clé d’applicateur invalide : attendu [a-z0-9_.]+ (100 caractères au plus).');
    }
    if (this.appliers.has(key)) throw new Error(`Applicateur déjà enregistré : ${key}`);
    if (applier.sideEffect !== 1) {
      throw new Error(`Applicateur ${key} : un effet irréversible ou externe n'a pas d'applicateur dans ce catalogue.`);
    }
    this.appliers.set(key, applier);
  }

  get(toolKey: string): ActionApplier | undefined {
    return this.appliers.get(toolKey);
  }

  has(toolKey: string): boolean {
    return this.appliers.has(toolKey);
  }

  list(): ActionApplier[] {
    return [...this.appliers.values()];
  }
}
