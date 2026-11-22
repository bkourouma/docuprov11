import type { ActionApplier } from '../catalog.contracts';
import { ActionApplierRegistry } from './action-applier.registry';

const applier = (toolKey: string, sideEffect: 1 | 2 = 1): ActionApplier => ({
  toolKey,
  sideEffect,
  parse: (a) => a,
  apply: async () => ({ effects: [] }),
});

describe('ActionApplierRegistry', () => {
  it('enregistre, retrouve et liste ; refuse doublon, clé invalide et effet irréversible', () => {
    const registry = new ActionApplierRegistry();
    const a = applier('proposer_imputation_courrier');
    registry.register(a);
    expect(registry.get('proposer_imputation_courrier')).toBe(a);
    expect(registry.has('proposer_imputation_courrier')).toBe(true);
    expect(registry.get('inconnu')).toBeUndefined();
    expect(registry.list()).toEqual([a]);
    expect(() => registry.register(applier('proposer_imputation_courrier'))).toThrow(/déjà enregistré/);
    expect(() => registry.register(applier('Clé Invalide'))).toThrow(/invalide/);
    expect(() => registry.register(applier(''))).toThrow(/invalide/);
    expect(() => registry.register(applier('x'.repeat(101)))).toThrow(/invalide/);
    expect(() => registry.register(applier('envoyer_courriel', 2))).toThrow(/irréversible/);
  });
});
