import { decideDisposition, type DispositionInput } from './disposition';

type RunOverride = Partial<DispositionInput['run']>;

const base = (over: Partial<Omit<DispositionInput, 'run'>> & { run?: RunOverride } = {}): DispositionInput => ({
  autonomy: 2,
  confidenceThreshold: 0.8,
  autonomousEligible: true,
  ...over,
  run: {
    outcome: 'final',
    confidence: 0.95,
    suspicionInjection: false,
    preparedActions: [],
    result: { ok: true },
    ...over.run,
  },
});

describe('decideDisposition', () => {
  it('autonome éligible, confiance suffisante, aucune action : complète seul', () => {
    expect(decideDisposition(base())).toEqual({ kind: 'complete' });
  });

  it('sous le seuil : retour à l’humain quel que soit le niveau', () => {
    for (const autonomy of [0, 1, 2] as const) {
      expect(decideDisposition(base({ autonomy, run: { confidence: 0.79 } }))).toEqual({
        kind: 'return_to_human',
        reason: 'low_confidence',
      });
    }
  });

  it('confiance absente ou NaN : retour à l’humain', () => {
    expect(decideDisposition(base({ run: { confidence: null } })).kind).toBe('return_to_human');
    expect(decideDisposition(base({ run: { confidence: Number.NaN } })).kind).toBe('return_to_human');
  });

  it('arrêt du runner ou résultat nul : retour à l’humain', () => {
    expect(decideDisposition(base({ run: { outcome: 'stopped' } })).kind).toBe('return_to_human');
    expect(decideDisposition(base({ run: { result: null } })).kind).toBe('return_to_human');
  });

  it('suspicion d’injection : proposition signalée, jamais d’action seule', () => {
    expect(decideDisposition(base({ run: { suspicionInjection: true, confidence: 0.99 } }))).toEqual({
      kind: 'propose',
      reason: 'suspicion_injection',
    });
  });

  it('suggère et agit avec validation : proposition', () => {
    expect(decideDisposition(base({ autonomy: 0 })).kind).toBe('propose');
    expect(decideDisposition(base({ autonomy: 1 })).kind).toBe('propose');
  });

  it('autonome non éligible : proposition', () => {
    expect(decideDisposition(base({ autonomousEligible: false }))).toEqual({
      kind: 'propose',
      reason: 'autonomy_not_eligible',
    });
  });

  it('autonome avec une action préparée : proposition (validation humaine obligatoire)', () => {
    const action = {
      tool: 'proposer_imputation',
      arguments: {},
      sideEffect: 1 as const,
      requiresValidation: true,
      preview: 'x',
    };
    expect(decideDisposition(base({ run: { preparedActions: [action] } }))).toEqual({
      kind: 'propose',
      reason: 'action_requires_validation',
    });
  });
});
