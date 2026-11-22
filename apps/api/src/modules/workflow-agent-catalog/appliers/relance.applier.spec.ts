import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthUser } from '../../auth/auth.types';
import { EffectRefusedError, type ApplierContext } from '../catalog.contracts';
import { RELANCE_MESSAGE_PREFIX } from '../shared/relance-cap';
import { RELANCE_BATCH_COUNT_KEY, RelanceApplier } from './relance.applier';

const validator: AuthUser = { userId: 1, username: 'val', isAdmin: false, userGroupId: 10 };
const launcher: AuthUser = { userId: 2, username: 'lan', isAdmin: false, userGroupId: 20 };
const NOW = new Date('2026-11-21T10:00:00Z');
const LATE = new Date('2026-11-20T10:00:00Z');

interface FakeState {
  inputation: { mailId: number; userId: number; dateTreated: Date | null; deadline: Date | null; createdBy: number | null } | null;
  disabled: Set<number>;
  targetToday: number;
  instanceToday: number;
  /** Menus par userId : 'imput' = menu d'imputation, 'admin' = administrateur, absent = aucun. */
  menus: Record<number, 'imput' | 'admin' | undefined>;
}

function makeTx(state: FakeState) {
  const created: Array<{ recipientUserGroupId: number; message: string; targetType: string; targetId: number }> = [];
  return {
    created,
    mailInputation: {
      findUnique: jest.fn(async () => state.inputation),
      update: jest.fn(async () => ({})),
    },
    appUserGroup: {
      findUnique: jest.fn(async ({ where }: { where: { userGroupId: number } }) =>
        where.userGroupId === 999 ? null : { user: { isDisabled: state.disabled.has(where.userGroupId) } },
      ),
    },
    notification: {
      count: jest.fn(async () => state.targetToday),
      create: jest.fn(async ({ data }: { data: (typeof created)[number] }) => {
        created.push(data);
        return {};
      }),
    },
    appUser: {
      findUnique: jest.fn(async ({ where }: { where: { userId: number } }) => {
        const m = state.menus[where.userId];
        if (!m) return { isAdmin: false, isDisabled: false, role: null };
        return {
          isAdmin: m === 'admin',
          isDisabled: false,
          role: m === 'admin' ? null : { isActive: true, isSystem: false, menus: [{ menuKey: '/courriers/controle' }] },
        };
      }),
    },
    $queryRaw: jest.fn(async () => [{ n: BigInt(state.instanceToday) }]),
  };
}

function setup(over: Partial<FakeState> = {}, ctxOver: { scratch?: Map<string, unknown>; rights?: Partial<ApplierContext['rights']> } = {}) {
  const state: FakeState = {
    inputation: { mailId: 3, userId: 30, dateTreated: null, deadline: LATE, createdBy: 11 },
    disabled: new Set(),
    targetToday: 0,
    instanceToday: 0,
    menus: { 1: 'imput', 2: 'imput' },
    ...over,
  };
  const tx = makeTx(state);
  const rights = {
    validator,
    launcher,
    requireAnyMenu: jest.fn(async () => undefined),
    requireMailReadable: jest.fn(async () => undefined),
    ...ctxOver.rights,
  } as ApplierContext['rights'];
  const ctx = {
    tx,
    now: NOW,
    instanceId: '100',
    taskId: '7',
    stepKey: 'agent',
    definitionVersionId: 1,
    subject: { type: 'mail', id: '3' },
    input: {},
    stepConfig: {},
    validatorPrincipal: { userGroupId: 10, userId: 1, groupIds: [], roleId: null },
    rights,
    scratch: ctxOver.scratch ?? new Map<string, unknown>(),
  } as unknown as ApplierContext;
  return { state, tx, ctx, rights, applier: new RelanceApplier() };
}

const validArgs = { mailId: 3, mailInputationId: 50, recipientUserGroupId: 30, message: 'Merci de traiter ce courrier.' };

describe('RelanceApplier', () => {
  it('cas nominal : notification interne préfixée, lastReminderSent, effet sans contenu', async () => {
    const { applier, ctx, tx, rights } = setup();
    const res = await applier.apply(ctx, applier.parse(validArgs));
    expect(rights.requireMailReadable).toHaveBeenCalledWith(3);
    expect(tx.created).toEqual([
      { recipientUserGroupId: 30, message: `${RELANCE_MESSAGE_PREFIX}Merci de traiter ce courrier.`, targetType: 'mail', targetId: 3 },
    ]);
    expect(tx.mailInputation.update).toHaveBeenCalledWith({ where: { mailInputationId: 50 }, data: { lastReminderSent: NOW } });
    expect(res.effects).toEqual([
      { tool: 'proposer_relance', summary: { mailId: 3, mailInputationId: 50, recipientUserGroupId: 30, escalated: false } },
    ]);
    expect(JSON.stringify(res.effects)).not.toContain('Merci');
    expect(ctx.scratch.get(RELANCE_BATCH_COUNT_KEY)).toBe(1);
  });

  it('jamais d e-mail : le module n importe aucun service de notification et n écrit que par tx.notification', () => {
    const src = readFileSync(join(__dirname, 'relance.applier.ts'), 'utf8');
    expect(src).not.toMatch(/notifications\.service|NotificationsService|MailService|nodemailer/i);
  });

  it('escalade vers l auteur de l imputation : deuxième notification interne', async () => {
    const { applier, ctx, tx } = setup();
    const res = await applier.apply(ctx, applier.parse({ ...validArgs, escalateToUserGroupId: 11 }));
    expect(tx.created.map((n) => n.recipientUserGroupId)).toEqual([30, 11]);
    expect(res.effects[0].summary).toMatchObject({ escalated: true });
  });

  it('escalade vers un tiers libre : refus, rien écrit', async () => {
    const { applier, ctx, tx } = setup();
    await expect(applier.apply(ctx, applier.parse({ ...validArgs, escalateToUserGroupId: 12 }))).rejects.toThrow('auteur de l’imputation');
    expect(tx.created).toHaveLength(0);
    expect(tx.mailInputation.update).not.toHaveBeenCalled();
  });

  it('arguments invalides : clé en trop, id négatif, message vide', () => {
    const { applier } = setup();
    expect(() => applier.parse({ ...validArgs, email: 'a@b.c' })).toThrow(EffectRefusedError);
    expect(() => applier.parse({ ...validArgs, mailId: -1 })).toThrow(EffectRefusedError);
    expect(() => applier.parse({ ...validArgs, message: '   ' })).toThrow(EffectRefusedError);
  });

  it('courrier non lisible (valideur ou lanceur) : refus relayé, rien écrit', async () => {
    const { applier, ctx, tx } = setup({}, { rights: { requireMailReadable: jest.fn(async () => { throw new EffectRefusedError('Courrier non lisible par le lanceur.'); }) } });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('non lisible par le lanceur');
    expect(tx.created).toHaveLength(0);
  });

  it.each([
    ['imputation inconnue', { inputation: null }, 'imputation introuvable'],
    ['autre courrier', { inputation: { mailId: 4, userId: 30, dateTreated: null, deadline: LATE, createdBy: 11 } }, 'imputation introuvable'],
    ['déjà traitée', { inputation: { mailId: 3, userId: 30, dateTreated: NOW, deadline: LATE, createdBy: 11 } }, 'déjà traitée'],
    ['autre imputé', { inputation: { mailId: 3, userId: 31, dateTreated: null, deadline: LATE, createdBy: 11 } }, 'n’est pas l’imputé'],
    ['compte désactivé', { disabled: new Set([30]) }, 'pas actif'],
    ['sans échéance', { inputation: { mailId: 3, userId: 30, dateTreated: null, deadline: null, createdBy: 11 } }, 'pas en retard'],
    ['échéance future', { inputation: { mailId: 3, userId: 30, dateTreated: null, deadline: new Date('2026-12-01T00:00:00Z'), createdBy: 11 } }, 'pas en retard'],
    ['échéance égale à maintenant', { inputation: { mailId: 3, userId: 30, dateTreated: null, deadline: NOW, createdBy: 11 } }, 'pas en retard'],
  ] as Array<[string, Partial<FakeState>, string]>)('refus : %s', async (_n, over, msg) => {
    const { applier, ctx, tx } = setup(over);
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow(msg);
    expect(tx.created).toHaveLength(0);
    expect(tx.mailInputation.update).not.toHaveBeenCalled();
  });

  describe('droit de relancer (valideur et lanceur)', () => {
    const byAuthor = { mailId: 3, userId: 30, dateTreated: null, deadline: LATE, createdBy: 10 };

    it('valideur sans menu mais auteur de l imputation : accepté', async () => {
      const { applier, ctx } = setup({ menus: { 1: undefined, 2: 'imput' }, inputation: byAuthor });
      await expect(applier.apply(ctx, applier.parse(validArgs))).resolves.toBeDefined();
    });

    it('administrateur sans rôle : accepté', async () => {
      const { applier, ctx } = setup({ menus: { 1: 'admin', 2: 'admin' } });
      await expect(applier.apply(ctx, applier.parse(validArgs))).resolves.toBeDefined();
    });

    it('valideur sans menu et non auteur : refus nommant le valideur', async () => {
      const { applier, ctx, tx } = setup({ menus: { 1: undefined, 2: 'imput' } });
      await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('le valideur n’a ni le droit d’imputer');
      expect(tx.created).toHaveLength(0);
    });

    it('lanceur sans menu et non auteur : refus nommant le lanceur', async () => {
      const { applier, ctx, tx } = setup({ menus: { 1: 'imput', 2: undefined } });
      await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('le lanceur n’a ni le droit d’imputer');
      expect(tx.created).toHaveLength(0);
    });

    it('valideur auteur mais lanceur sans menu : refus (jamais plus que le lanceur)', async () => {
      const { applier, ctx } = setup({ menus: { 1: undefined, 2: undefined }, inputation: byAuthor });
      await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('le lanceur');
    });
  });

  it('plafond par cible : déjà relancé aujourd hui => refus', async () => {
    const { applier, ctx, tx } = setup({ targetToday: 1 });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toThrow('plafond quotidien atteint pour cet imputé');
    expect(tx.created).toHaveLength(0);
  });

  it('plafond par instance : 5 relances déjà journalisées => refus', async () => {
    const { applier, ctx, tx } = setup({ instanceToday: 5 });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toMatchObject({ code: 'relance_cap_instance' });
    expect(tx.created).toHaveLength(0);
  });

  it('plafond du lot : journal (3) + lot (2) = 5 => refus', async () => {
    const { applier, ctx } = setup({ instanceToday: 3 }, { scratch: new Map([[RELANCE_BATCH_COUNT_KEY, 2]]) });
    await expect(applier.apply(ctx, applier.parse(validArgs))).rejects.toMatchObject({ code: 'relance_cap_instance' });
  });

  it('plafond du lot : la 5e relance du lot passe, la 6e est refusée (messages explicables)', async () => {
    const scratch = new Map<string, unknown>();
    const results: unknown[] = [];
    let refused: unknown;
    for (let i = 0; i < 6; i++) {
      const { applier, ctx } = setup({}, { scratch });
      try {
        results.push(await applier.apply(ctx, applier.parse(validArgs)));
      } catch (e) {
        refused = e;
      }
    }
    expect(results).toHaveLength(5);
    expect(refused).toBeInstanceOf(EffectRefusedError);
    expect((refused as Error).message).toContain('Tout le lot est annulé');
  });

  it('messages de refus : aucun contenu de courrier ni message de relance', async () => {
    const { applier, ctx } = setup({ targetToday: 1 });
    try {
      await applier.apply(ctx, applier.parse({ ...validArgs, message: 'CONTENU-SENSIBLE' }));
      throw new Error('attendu un refus');
    } catch (e) {
      expect((e as Error).message).not.toContain('CONTENU-SENSIBLE');
    }
  });
});
