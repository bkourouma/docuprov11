import { z } from 'zod';
import { AgentIdentityError } from '../../workflow-agents/agent.contracts';
import { WfEffectApplyError, type WfEffectApplyInput } from '../../workflows/engine/engine.types';
import { EffectRefusedError, type ActionApplier, type ApplierContext } from '../catalog.contracts';
import { ActionApplierRegistry } from './action-applier.registry';
import { EffectDispatcher } from './effect-dispatcher';

const NOW = new Date('2026-11-22T09:00:00.000Z');
const launcherUser = { userId: 11, username: 'lanceur', isAdmin: false, userGroupId: 10, fullName: 'Lanceur' };

function fakeApplier(
  toolKey: string,
  impl: (ctx: ApplierContext, args: { n: number }) => Promise<{ effects: Array<{ tool: string; summary: Record<string, unknown> }>; compensate?: () => Promise<void> }>,
): ActionApplier<{ n: number }> & { apply: jest.Mock } {
  return {
    toolKey,
    sideEffect: 1,
    parse: (args: unknown) => z.object({ n: z.number().int() }).strict().parse(args),
    apply: jest.fn(impl),
  };
}

function setup(opts: { validatorRow?: unknown; identityError?: AgentIdentityError } = {}) {
  const registry = new ActionApplierRegistry();
  const identity = {
    resolve: jest.fn(async () => {
      if (opts.identityError) throw opts.identityError;
      return { principal: { userGroupId: 10, userId: 11, groupIds: [], roleId: null }, user: launcherUser };
    }),
  };
  const rightsFactory = { create: jest.fn((validator, launcher) => ({ validator, launcher, requireAnyMenu: jest.fn(), requireMailReadable: jest.fn() })) };
  const tx = {
    appUserGroup: {
      findUnique: jest.fn(async () =>
        opts.validatorRow !== undefined
          ? opts.validatorRow
          : { userId: 21, user: { username: 'valideur', fullName: 'Valideur', isAdmin: true, isDisabled: false } },
      ),
    },
  };
  const dispatcher = new EffectDispatcher(registry, identity, rightsFactory as never);
  const input = (actions: Array<{ tool: string; arguments: Record<string, unknown> }>): WfEffectApplyInput => ({
    tx: tx as never,
    now: NOW,
    instanceId: '1',
    taskId: '9',
    stepKey: 'ia',
    definitionVersionId: 50,
    subject: { type: 'mail', id: '5' },
    input: { draftSpaceId: 4 },
    stepConfig: {},
    validator: { userGroupId: 20, userId: 21, groupIds: [], roleId: null },
    launcherUserGroupId: 10,
    outcome: 'accepted',
    actions: actions.map((a) => ({ ...a, sideEffect: 1, requiresValidation: true, preview: '' })),
  });
  return { registry, identity, rightsFactory, tx, dispatcher, input };
}

describe('EffectDispatcher', () => {
  it('applique séquentiellement, dans l’ordre, avec un scratch partagé et les droits valideur + lanceur relus', async () => {
    const { registry, dispatcher, input, rightsFactory, identity, tx } = setup();
    const seen: string[] = [];
    const a = fakeApplier('outil_a', async (ctx, args) => {
      seen.push(`a${args.n}`);
      ctx.scratch.set('compteur', 1);
      return { effects: [{ tool: 'outil_a', summary: { n: args.n } }] };
    });
    const b = fakeApplier('outil_b', async (ctx, args) => {
      seen.push(`b${args.n}:${String(ctx.scratch.get('compteur'))}`);
      expect(ctx.tx).toBe(tx);
      expect(ctx.validatorPrincipal.userGroupId).toBe(20);
      return { effects: [{ tool: 'outil_b', summary: { n: args.n } }] };
    });
    registry.register(a);
    registry.register(b);
    const out = await dispatcher.apply(input([
      { tool: 'outil_a', arguments: { n: 1 } },
      { tool: 'outil_b', arguments: { n: 2 } },
      { tool: 'outil_a', arguments: { n: 3 } },
    ]));
    expect(seen).toEqual(['a1', 'b2:1', 'a3']);
    expect(out.effects).toEqual([
      { tool: 'outil_a', summary: { n: 1 } },
      { tool: 'outil_b', summary: { n: 2 } },
      { tool: 'outil_a', summary: { n: 3 } },
    ]);
    expect(out.compensate).toBeUndefined();
    expect(identity.resolve).toHaveBeenCalledWith(10);
    const [validator, launcher] = rightsFactory.create.mock.calls[0];
    expect(validator).toMatchObject({ userId: 21, userGroupId: 20, isAdmin: true });
    expect(launcher).toBe(launcherUser);
    // Le même contexte (donc le même scratch) pour toutes les actions du lot.
    expect(a.apply.mock.calls[0][0]).toBe(b.apply.mock.calls[0][0]);
  });

  it('outil sans applicateur dans un lot mixte : refus `no_applier` AVANT toute application ni lecture d’identité', async () => {
    for (const order of [
      [{ tool: 'outil_a', arguments: { n: 1 } }, { tool: 'inconnu', arguments: {} }],
      [{ tool: 'inconnu', arguments: {} }, { tool: 'outil_a', arguments: { n: 1 } }],
    ]) {
      const { registry, dispatcher, input, identity } = setup();
      const a = fakeApplier('outil_a', async () => ({ effects: [{ tool: 'outil_a', summary: {} }] }));
      registry.register(a);
      const p = dispatcher.apply(input(order));
      await expect(p).rejects.toBeInstanceOf(WfEffectApplyError);
      await expect(p).rejects.toMatchObject({ code: 'no_applier', tool: 'inconnu', message: expect.stringContaining('inconnu') });
      expect(a.apply).not.toHaveBeenCalled();
      expect(identity.resolve).not.toHaveBeenCalled();
    }
  });

  it('argument invalide : refus explicable, rien appliqué', async () => {
    const { registry, dispatcher, input } = setup();
    const a = fakeApplier('outil_a', async () => ({ effects: [] }));
    registry.register(a);
    const p = dispatcher.apply(input([{ tool: 'outil_a', arguments: { n: 'deux', extra: 1 } }]));
    await expect(p).rejects.toBeInstanceOf(WfEffectApplyError);
    await expect(p).rejects.toMatchObject({ code: 'invalid_arguments', tool: 'outil_a' });
    expect(a.apply).not.toHaveBeenCalled();
  });

  it('refus d’un applicateur : levée avec message et code ; compensations déjà collectées portées par l’erreur', async () => {
    const { registry, dispatcher, input } = setup();
    const undo = jest.fn(async () => undefined);
    registry.register(fakeApplier('outil_a', async () => ({ effects: [{ tool: 'outil_a', summary: {} }], compensate: undo })));
    const b = fakeApplier('outil_b', async () => {
      throw new EffectRefusedError('Destinataire n°3 non imputable.', 'recipient_not_imputable');
    });
    registry.register(b);
    const err = await dispatcher
      .apply(input([{ tool: 'outil_a', arguments: { n: 1 } }, { tool: 'outil_b', arguments: { n: 2 } }]))
      .catch((e: unknown) => e as WfEffectApplyError);
    expect(err).toBeInstanceOf(WfEffectApplyError);
    expect(err).toMatchObject({ message: 'Destinataire n°3 non imputable.', code: 'recipient_not_imputable', tool: 'outil_b' });
    await err.compensate!();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('erreur technique : message générique (jamais le texte de l’erreur), code effect_failed', async () => {
    const { registry, dispatcher, input } = setup();
    registry.register(
      fakeApplier('outil_a', async () => {
        throw new Error('objet confidentiel du courrier');
      }),
    );
    const err = (await dispatcher.apply(input([{ tool: 'outil_a', arguments: { n: 1 } }])).catch((e: unknown) => e)) as WfEffectApplyError;
    expect(err).toMatchObject({ code: 'effect_failed', tool: 'outil_a' });
    expect(err.message).not.toContain('confidentiel');
    expect(err.compensate).toBeUndefined();
  });

  it('compensations combinées en ordre inverse, isolées', async () => {
    const { registry, dispatcher, input } = setup();
    const order: string[] = [];
    registry.register(
      fakeApplier('outil_a', async (_c, args) => ({
        effects: [],
        compensate: async () => {
          order.push(`a${args.n}`);
          if (args.n === 2) throw new Error('x');
        },
      })),
    );
    const out = await dispatcher.apply(input([{ tool: 'outil_a', arguments: { n: 1 } }, { tool: 'outil_a', arguments: { n: 2 } }]));
    await out.compensate!();
    await out.compensate!();
    expect(order).toEqual(['a2', 'a1', 'a2', 'a1']);
  });

  it('lanceur désactivé, introuvable ou sans droit de lancer : refus, aucun applicateur appelé', async () => {
    for (const code of ['disabled', 'not_found', 'no_launch_right'] as const) {
      const { registry, dispatcher, input } = setup({ identityError: new AgentIdentityError(code, 'x') });
      const a = fakeApplier('outil_a', async () => ({ effects: [] }));
      registry.register(a);
      await expect(dispatcher.apply(input([{ tool: 'outil_a', arguments: { n: 1 } }]))).rejects.toMatchObject({
        code: `launcher_${code}`,
      });
      expect(a.apply).not.toHaveBeenCalled();
    }
  });

  it('valideur introuvable, désactivé ou incohérent : refus', async () => {
    const cases: Array<[unknown, string]> = [
      [null, 'validator_not_found'],
      [{ userId: 21, user: { username: 'v', fullName: null, isAdmin: false, isDisabled: true } }, 'validator_disabled'],
      [{ userId: 99, user: { username: 'v', fullName: null, isAdmin: false, isDisabled: false } }, 'validator_invalid'],
    ];
    for (const [row, code] of cases) {
      const { registry, dispatcher, input } = setup({ validatorRow: row });
      registry.register(fakeApplier('outil_a', async () => ({ effects: [] })));
      await expect(dispatcher.apply(input([{ tool: 'outil_a', arguments: { n: 1 } }]))).rejects.toMatchObject({ code });
    }
  });

  it('isAdmin du valideur relu en base (jamais celui du principal)', async () => {
    const { registry, dispatcher, input, rightsFactory } = setup({
      validatorRow: { userId: 21, user: { username: 'v', fullName: null, isAdmin: false, isDisabled: false } },
    });
    registry.register(fakeApplier('outil_a', async () => ({ effects: [] })));
    await dispatcher.apply(input([{ tool: 'outil_a', arguments: { n: 1 } }]));
    expect(rightsFactory.create.mock.calls[0][0]).toMatchObject({ isAdmin: false, userId: 21, userGroupId: 20 });
  });
});
