import {
  WF_EFFECT_ACTIONS_MAX,
  WF_EFFECT_TECHNICAL_MESSAGE,
  WfEffectApplierHolder,
  compensationOf,
  noApplierError,
  runCompensations,
  selectValidatedActions,
  toEffectEngineError,
} from './effect-applier';
import { WfEffectApplyError, WfEngineError } from './engine.types';

const action = (tool: string, args: Record<string, unknown> = { mailId: 1 }) => ({
  tool,
  arguments: args,
  sideEffect: 1 as const,
  requiresValidation: true,
  preview: `Action ${tool}`,
});

const item = (proposal: unknown, kind = 1) => ({ wfInboxItemId: 5n, kind, proposal });
const proposal = (over: Record<string, unknown> = {}) => ({
  mode: 'action',
  result: {},
  preparedActions: [action('proposer_imputation_courrier')],
  suspicion_injection: false,
  ...over,
});
const agent = { type: 'agent' as const };

describe('WfEffectApplierHolder', () => {
  it('vide par défaut ; branche un applicateur ; refuse un AUTRE applicateur, accepte le même', () => {
    const holder = new WfEffectApplierHolder();
    expect(holder.get()).toBeUndefined();
    const port = { apply: jest.fn() };
    holder.set(port);
    holder.set(port);
    expect(holder.get()).toBe(port);
    expect(() => holder.set({ apply: jest.fn() })).toThrow(/déjà branché/);
    expect(() => new WfEffectApplierHolder().set({} as never)).toThrow(/invalide/);
  });
});

describe('selectValidatedActions', () => {
  it('rien pour une étape non agent, sans élément kind 1, mode suggestion, suspicion ou drapeau absent', () => {
    const p = proposal();
    expect(selectValidatedActions({ type: 'validation' }, [item(p)], p)).toBeNull();
    expect(selectValidatedActions(agent, [item(p, 0)], p)).toBeNull();
    const s = { mode: 'suggestion', suggestedActions: [action('x')], suspicion_injection: false };
    expect(selectValidatedActions(agent, [item(s)], s)).toBeNull();
    const inj = proposal({ suspicion_injection: true });
    expect(selectValidatedActions(agent, [item(inj)], inj)).toBeNull();
    const noFlag = { mode: 'action', preparedActions: [action('x')] };
    expect(selectValidatedActions(agent, [item(noFlag)], noFlag)).toBeNull();
    expect(selectValidatedActions(agent, [item('texte')], {})).toBeNull();
  });

  it('accepted : actions STOCKÉES, quel que soit l’ordre des clés du résultat', () => {
    const p = proposal();
    const reordered = { suspicion_injection: false, preparedActions: p.preparedActions, result: {}, mode: 'action' };
    expect(selectValidatedActions(agent, [item(p)], reordered)).toEqual({
      itemId: 5n,
      outcome: 'accepted',
      actions: p.preparedActions,
    });
  });

  it('modified : actions du résultat bornées aux outils (et au nombre) de la proposition stockée', () => {
    const p = proposal({ preparedActions: [action('a'), action('b')] });
    const changed = [action('b', { mailId: 2 })];
    expect(selectValidatedActions(agent, [item(p)], { ...p, preparedActions: changed })).toMatchObject({
      outcome: 'modified',
      actions: changed,
    });
    expect(selectValidatedActions(agent, [item(p)], { autre: 1 })).toEqual({ itemId: 5n, outcome: 'modified', actions: [] });
    expect(() => selectValidatedActions(agent, [item(p)], { preparedActions: [action('c')] })).toThrow(WfEngineError);
    expect(() => selectValidatedActions(agent, [item(p)], { preparedActions: [action('a'), action('a')] })).toThrow(
      /non proposée/,
    );
  });

  it('actions illisibles ou trop nombreuses : INVALID_INPUT (échec fermé)', () => {
    const p = proposal();
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as WfEngineError).code;
      }
      return null;
    };
    expect(codeOf(() => selectValidatedActions(agent, [item(p)], { preparedActions: [{ tool: 'A B' }] }))).toBe('INVALID_INPUT');
    expect(codeOf(() => selectValidatedActions(agent, [item(p)], { preparedActions: {} }))).toBe('INVALID_INPUT');
    const many = Array.from({ length: WF_EFFECT_ACTIONS_MAX + 1 }, () => action('proposer_imputation_courrier'));
    const big = proposal({ preparedActions: many });
    expect(codeOf(() => selectValidatedActions(agent, [item(big)], big))).toBe('INVALID_INPUT');
    const broken = proposal({ preparedActions: [{ tool: 'x', arguments: 'pas un objet' }] });
    expect(codeOf(() => selectValidatedActions(agent, [item(broken)], broken))).toBe('INVALID_INPUT');
  });
});

describe('toEffectEngineError / compensationOf / runCompensations', () => {
  it('refus explicable => INVALID_INPUT avec code et outil ; autre erreur => message générique', () => {
    const c = async () => undefined;
    const refused = new WfEffectApplyError('Refus clair.', 'menu_denied', 'proposer_imputation', c);
    expect(toEffectEngineError(refused)).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Refus clair.',
      details: { code: 'menu_denied', tool: 'proposer_imputation' },
    });
    expect(compensationOf(refused)).toBe(c);
    const tech = toEffectEngineError(new Error('texte du courrier'));
    expect(tech.message).toBe(WF_EFFECT_TECHNICAL_MESSAGE);
    expect(tech.details).toEqual({ code: 'effect_failed', tool: null });
    const engineErr = new WfEngineError('CONFLICT', 'x');
    expect(toEffectEngineError(engineErr)).toBe(engineErr);
    expect(compensationOf(new Error('x'))).toBeUndefined();
  });

  it('outil sans applicateur : INVALID_INPUT `no_applier` citant l’outil', () => {
    expect(noApplierError('proposer_relance')).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('« proposer_relance »'),
      details: { code: 'no_applier', tool: 'proposer_relance' },
    });
  });

  it('compensations en ordre inverse, sans jamais lever', async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    await runCompensations(
      [
        async () => {
          calls.push('a');
        },
        async () => {
          calls.push('b');
          throw new Error('b');
        },
        async () => {
          calls.push('c');
        },
      ],
      (e) => {
        errors.push(e);
        throw new Error('rapporteur défaillant');
      },
    );
    expect(calls).toEqual(['c', 'b', 'a']);
    expect(errors).toHaveLength(1);
  });
});
