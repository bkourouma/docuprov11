import type { AuthUser } from '../../auth/auth.types';
import { EffectRefusedError, type ApplierContext, type ImputableActorsPort } from '../catalog.contracts';
import { DelegationApplier } from './delegation.applier';
import { IMPUTATION_MENU_KEYS } from './imputable-actors.service';

const validator: AuthUser = { userId: 1, username: 'val', isAdmin: false, userGroupId: 10 };
const launcher: AuthUser = { userId: 2, username: 'lan', isAdmin: false, userGroupId: 20 };
const DEADLINE = new Date('2026-11-25T00:00:00Z');

interface Source {
  mailId: number;
  userId: number;
  dateTreated: Date | null;
  deadline: Date | null;
  instructions: string | null;
  mailInputationTypeId: number;
}

function setup(opts: {
  source?: Source | null;
  existing?: { mailInputationId: number } | null;
  delegates?: unknown;
  canImpute?: (u: AuthUser) => boolean;
  isImputable?: (u: AuthUser, id: number) => boolean;
  rights?: Partial<ApplierContext['rights']>;
  title?: string | null;
} = {}) {
  /** Journal ordonné des accès : verrous de ligne, recherche de doublon, création. */
  const order: string[] = [];
  const source: Source | null =
    opts.source === undefined
      ? { mailId: 3, userId: 30, dateTreated: null, deadline: DEADLINE, instructions: 'Voir pièce jointe', mailInputationTypeId: 10 }
      : opts.source;
  const tx = {
    $queryRaw: jest.fn(async (query: { sql: string; values: unknown[] }) => {
      if (/FROM mail WHERE mail_id = \? FOR UPDATE/.test(query.sql)) order.push(`lock:mail:${String(query.values[0])}`);
      else if (/FROM mail_inputation WHERE mail_inputation_id = \? FOR UPDATE/.test(query.sql)) order.push(`lock:inputation:${String(query.values[0])}`);
      else order.push('lock:unexpected');
      return [{}];
    }),
    mailInputation: {
      findUnique: jest.fn(async () => {
        order.push('read:source');
        return source;
      }),
      findFirst: jest.fn(async () => {
        order.push('find-duplicate');
        return opts.existing ?? null;
      }),
      create: jest.fn(async () => {
        order.push('create');
        return { mailInputationId: 900 };
      }),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({})),
    },
    mail: { findUnique: jest.fn(async () => ({ title: opts.title === undefined ? 'Objet du courrier' : opts.title })) },
    notification: { create: jest.fn(async () => ({})) },
  };
  const rights = {
    validator,
    launcher,
    requireAnyMenu: jest.fn(async () => undefined),
    requireMailReadable: jest.fn(async () => undefined),
    ...opts.rights,
  } as ApplierContext['rights'];
  const ctx = {
    tx,
    now: new Date('2026-11-21T10:00:00Z'),
    instanceId: '100',
    taskId: '7',
    stepKey: 'agent',
    definitionVersionId: 1,
    subject: { type: 'mail', id: '3' },
    input: {},
    stepConfig: { delegates: opts.delegates === undefined ? [{ userGroupId: 40, forUserGroupId: 30 }] : opts.delegates },
    validatorPrincipal: { userGroupId: 10, userId: 1, groupIds: [], roleId: null },
    rights,
    scratch: new Map<string, unknown>(),
  } as unknown as ApplierContext;
  const actors: ImputableActorsPort = {
    canImpute: jest.fn(async (u: AuthUser) => (opts.canImpute ? opts.canImpute(u) : true)),
    isImputable: jest.fn(async (u: AuthUser, id: number) => (opts.isImputable ? opts.isImputable(u, id) : true)),
    list: jest.fn(async () => []),
  };
  return { tx, ctx, rights, actors, order, applier: new DelegationApplier(actors) };
}

const validArgs = { mailId: 3, mailInputationId: 50, delegateUserGroupId: 40, rationale: 'Absence du titulaire' };

describe('DelegationApplier', () => {
  it('cas nominal : nouvelle imputation (mêmes type, consignes, échéance), notification interne, source intacte', async () => {
    const { applier, ctx, tx, rights } = setup();
    const res = await applier.apply(ctx, applier.parse(validArgs));
    expect(rights.requireMailReadable).toHaveBeenCalledWith(3);
    expect(rights.requireAnyMenu).toHaveBeenCalledWith(IMPUTATION_MENU_KEYS, expect.any(String));
    expect(tx.mailInputation.create).toHaveBeenCalledWith({
      data: { mailId: 3, userId: 40, mailInputationTypeId: 10, instructions: 'Voir pièce jointe', deadline: DEADLINE, createdBy: 10 },
      select: { mailInputationId: true },
    });
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: { recipientUserGroupId: 40, message: 'Courrier imputé : Objet du courrier', targetType: 'mail', targetId: 3 },
    });
    expect(res.effects).toEqual([
      {
        tool: 'proposer_delegation',
        summary: { status: 'created', mailId: 3, sourceMailInputationId: 50, mailInputationId: 900, delegateUserGroupId: 40 },
      },
    ]);
    expect(JSON.stringify(res.effects)).not.toContain('Absence');
    // imputation source : jamais modifiée ni supprimée
    for (const m of ['update', 'delete', 'deleteMany', 'updateMany'] as const) expect(tx.mailInputation[m]).not.toHaveBeenCalled();
  });

  it('arguments invalides : clé en trop, id négatif, justification vide', () => {
    const { applier } = setup();
    expect(() => applier.parse({ ...validArgs, extra: 1 })).toThrow(EffectRefusedError);
    expect(() => applier.parse({ ...validArgs, delegateUserGroupId: -4 })).toThrow(EffectRefusedError);
    expect(() => applier.parse({ ...validArgs, rationale: '' })).toThrow(EffectRefusedError);
  });

  it('délégataire non déclaré : refus', async () => {
    const { applier, ctx, tx } = setup({ delegates: [{ userGroupId: 41 }] });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('délégataire non déclaré');
    expect(tx.mailInputation.create).not.toHaveBeenCalled();
  });

  it.each([[undefined], ['x'], [[{ userGroupId: 40, autre: true }]], [[]]])('déclaration absente ou invalide (%p) : refus fermé', async (d) => {
    const s = setup();
    (s.ctx as { stepConfig: Record<string, unknown> }).stepConfig = d === undefined ? {} : { delegates: d };
    await expect(s.applier.apply(s.ctx, s.applier.parse(validArgs))).rejects.toThrow('délégataire non déclaré');
  });

  it('déclaré pour un autre imputé : refus ; déclaré pour tous : accepté', async () => {
    const a = setup({ delegates: [{ userGroupId: 40, forUserGroupId: 31 }] });
    await expect(a.applier.apply(a.ctx, a.applier.parse(validArgs))).rejects.toThrow('délégataire non déclaré');
    const b = setup({ delegates: [{ userGroupId: 40 }] });
    await expect(b.applier.apply(b.ctx, b.applier.parse(validArgs))).resolves.toBeDefined();
  });

  it('courrier non lisible : refus relayé', async () => {
    const { applier, ctx, tx } = setup({ rights: { requireMailReadable: jest.fn(async () => { throw new EffectRefusedError('Courrier non lisible.'); }) } });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('Courrier non lisible');
    expect(tx.mailInputation.create).not.toHaveBeenCalled();
  });

  it('menu d imputation manquant (valideur ou lanceur) : refus relayé', async () => {
    const { applier, ctx, tx } = setup({ rights: { requireAnyMenu: jest.fn(async () => { throw new EffectRefusedError('Menu requis.'); }) } });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('Menu requis');
    expect(tx.mailInputation.create).not.toHaveBeenCalled();
  });

  it('le lanceur ne peut pas imputer : refus désignant le lanceur', async () => {
    const { applier, ctx, tx } = setup({ canImpute: (u) => u.userId !== launcher.userId });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('lanceur ne peut pas imputer');
    expect(tx.mailInputation.create).not.toHaveBeenCalled();
  });

  it('le valideur ne peut pas imputer : refus désignant le valideur', async () => {
    const { applier, ctx } = setup({ canImpute: (u) => u.userId !== validator.userId });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('valideur ne peut pas imputer');
  });

  it('délégataire non imputable pour le lanceur (ou inactif) : refus', async () => {
    const { applier, ctx, tx, actors } = setup({ isImputable: (u) => u.userId !== launcher.userId });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('n’est pas imputable par le lanceur');
    expect(actors.isImputable).toHaveBeenCalledWith(validator, 40);
    expect(actors.isImputable).toHaveBeenCalledWith(launcher, 40);
    expect(tx.mailInputation.create).not.toHaveBeenCalled();
  });

  it.each([
    ['inconnue', { source: null }, 'imputation introuvable'],
    ['autre courrier', { source: { mailId: 4, userId: 30, dateTreated: null, deadline: null, instructions: null, mailInputationTypeId: 10 } }, 'imputation introuvable'],
    ['déjà traitée', { source: { mailId: 3, userId: 30, dateTreated: new Date(), deadline: null, instructions: null, mailInputationTypeId: 10 } }, 'déjà traitée'],
  ])('imputation source %s : refus', async (_n, over, msg) => {
    const { applier, ctx, tx } = setup(over);
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow(msg);
    expect(tx.mailInputation.create).not.toHaveBeenCalled();
  });

  it('doublon : imputation ouverte identique => already_present, rien créé ni notifié', async () => {
    const { applier, ctx, tx } = setup({ existing: { mailInputationId: 777 } });
    const res = await applier.apply(ctx, applier.parse(validArgs));
    expect(res.effects[0].summary).toMatchObject({ status: 'already_present', mailInputationId: 777 });
    expect(tx.mailInputation.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(tx.mailInputation.findFirst).toHaveBeenCalledWith({
      where: { mailId: 3, userId: 40, mailInputationTypeId: 10, dateTreated: null },
      select: { mailInputationId: true },
    });
  });

  it('verrous de ligne : courrier PUIS imputation source, avant lecture de la source et recherche de doublon', async () => {
    const { applier, ctx, order } = setup();
    await applier.apply(ctx, applier.parse(validArgs));
    expect(order).toEqual(['lock:mail:3', 'lock:inputation:50', 'read:source', 'find-duplicate', 'create']);
  });

  it('titre du courrier tronqué à 300 caractères dans la notification (comme l imputation)', async () => {
    const { applier, ctx, tx } = setup({ title: `  ${'é'.repeat(350)}  ` });
    await applier.apply(ctx, applier.parse(validArgs));
    const message = (tx.notification.create.mock.calls[0] as unknown as [{ data: { message: string } }])[0].data.message;
    expect(message).toBe(`Courrier imputé : ${'é'.repeat(299)}…`);
    expect(Array.from(message.replace('Courrier imputé : ', ''))).toHaveLength(300);
  });

  it('titre vide : repli sur le numéro du courrier', async () => {
    const { applier, ctx, tx } = setup({ title: '   ' });
    await applier.apply(ctx, applier.parse(validArgs));
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: { recipientUserGroupId: 40, message: 'Courrier imputé : #3', targetType: 'mail', targetId: 3 },
    });
  });

  it('valideur sans profil actif : refus', async () => {
    const s = setup();
    (s.rights as { validator: AuthUser }).validator = { ...validator, userGroupId: null };
    await expect(s.applier.apply(s.ctx, s.applier.parse(validArgs))).rejects.toThrow('profil actif');
  });
});
