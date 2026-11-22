import type { AuthUser } from '../../auth/auth.types';
import { EffectRefusedError, type ApplierContext, type ApplierRights, type ImputableActorsPort } from '../catalog.contracts';
import { IMPUTATION_MENU_KEYS } from './imputable-actors.service';
import { ImputationBaseApplier, ImputationCourrierApplier, SCRATCH_IMPUTATIONS_CREATED } from './imputation.applier';

const NOW = new Date('2026-11-22T09:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const validator: AuthUser = { userId: 21, username: 'v', isAdmin: false, userGroupId: 20 };
const launcher: AuthUser = { userId: 11, username: 'l', isAdmin: false, userGroupId: 10 };

function setup(opts: {
  imputable?: (imputer: AuthUser, id: number) => boolean;
  mail?: { mailId: number; title: string } | null;
  activeTypes?: Array<{ mailInputationTypeId: number; label: string }>;
  existing?: (where: { userId: number; mailInputationTypeId: number }) => { mailInputationId: number } | null;
  rights?: Partial<ApplierRights>;
} = {}) {
  let nextId = 500;
  const writes: string[] = [];
  const activeTypes = opts.activeTypes ?? [
    { mailInputationTypeId: 5, label: 'Validation DG' },
    { mailInputationTypeId: 10, label: 'Pour Suivi' },
    { mailInputationTypeId: 14, label: 'Validation Direction' },
    { mailInputationTypeId: 17, label: 'En copie' },
  ];
  const tx = {
    mail: { findFirst: jest.fn(async () => (opts.mail === undefined ? { mailId: 5, title: 'Demande de congé' } : opts.mail)) },
    mailInputationType: {
      findMany: jest.fn(async ({ where }: { where: { mailInputationTypeId?: { in: number[] }; isActive: boolean } }) =>
        activeTypes.filter((t) => !where.mailInputationTypeId || where.mailInputationTypeId.in.includes(t.mailInputationTypeId)),
      ),
    },
    mailInputation: {
      findFirst: jest.fn(async ({ where }: { where: { userId: number; mailInputationTypeId: number } }) => opts.existing?.(where) ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(`imputation:${String(data.userId)}`);
        return { mailInputationId: nextId++ };
      }),
    },
    notification: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(`notification:${String(data.recipientUserGroupId)}`);
        return { notificationId: 1 };
      }),
    },
  };
  const rights: ApplierRights = {
    validator,
    launcher,
    requireAnyMenu: jest.fn(async () => undefined),
    requireMailReadable: jest.fn(async () => undefined),
    ...opts.rights,
  };
  const actors: ImputableActorsPort = {
    canImpute: jest.fn(async () => true),
    isImputable: jest.fn(async (u: AuthUser, id: number) => (opts.imputable ? opts.imputable(u, id) : true)),
    list: jest.fn(async () => []),
  };
  const ctx: ApplierContext = {
    tx: tx as never,
    now: NOW,
    instanceId: '1',
    taskId: '9',
    stepKey: 'ia',
    definitionVersionId: 50,
    subject: { type: 'mail', id: '5' },
    input: {},
    stepConfig: {},
    validatorPrincipal: { userGroupId: 20, userId: 21, groupIds: [], roleId: null },
    rights,
    scratch: new Map(),
  };
  return { tx, rights, actors, ctx, writes, courrier: new ImputationCourrierApplier(actors), base: new ImputationBaseApplier(actors) };
}

const args = (recipients: Array<Record<string, unknown>>) => ({ mailId: 5, recipients, rationale: 'Compétence du service' });

describe('ImputationCourrierApplier', () => {
  it('parse STRICT : clés inconnues, délai hors bornes, plus de 5 destinataires refusés', () => {
    const { courrier } = setup();
    expect(courrier.toolKey).toBe('proposer_imputation_courrier');
    expect(courrier.sideEffect).toBe(1);
    expect(() => courrier.parse({ ...args([{ userGroupId: 30, mailInputationTypeId: 10 }]), extra: 1 })).toThrow(EffectRefusedError);
    expect(() => courrier.parse(args([{ userGroupId: 30, mailInputationTypeId: 10, delayDays: 91 }]))).toThrow(EffectRefusedError);
    expect(() =>
      courrier.parse(args(Array.from({ length: 6 }, (_, i) => ({ userGroupId: 30 + i, mailInputationTypeId: 10 })))),
    ).toThrow(EffectRefusedError);
    expect(courrier.parse(args([{ userGroupId: 30, mailInputationTypeId: 10 }]))).toMatchObject({ mailId: 5 });
  });

  it('écrit par ctx.tx : imputation (auteur = valideur, échéances) puis notification in-app, effets sans contenu', async () => {
    const { courrier, ctx, tx, rights, writes } = setup();
    const res = await courrier.apply(
      ctx,
      courrier.parse(
        args([
          { userGroupId: 30, mailInputationTypeId: 10, instructions: 'Traiter vite', delayDays: 3 },
          { userGroupId: 31, mailInputationTypeId: 5 },
          { userGroupId: 32, mailInputationTypeId: 17 },
        ]),
      ),
    );
    expect(rights.requireAnyMenu).toHaveBeenCalledWith(IMPUTATION_MENU_KEYS, 'imputer un courrier');
    expect(rights.requireMailReadable).toHaveBeenCalledWith(5);
    expect(writes).toEqual(['imputation:30', 'notification:30', 'imputation:31', 'notification:31', 'imputation:32', 'notification:32']);
    const data = tx.mailInputation.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(data[0]).toMatchObject({ mailId: 5, userId: 30, mailInputationTypeId: 10, instructions: 'Traiter vite', createdBy: 20 });
    expect(data[0].deadline).toEqual(new Date(NOW.getTime() + 3 * DAY));
    expect(data[1].deadline).toEqual(new Date(NOW.getTime() + 2 * DAY)); // validation DG : +48 h par défaut
    expect(data[2].deadline).toBeNull();
    expect(tx.notification.create.mock.calls[0][0]).toEqual({
      data: { recipientUserGroupId: 30, message: 'Courrier imputé : Demande de congé', targetType: 'mail', targetId: 5, createdAt: NOW },
    });
    expect(res.effects).toEqual([
      {
        tool: 'proposer_imputation_courrier',
        summary: { status: 'applied', mailId: 5, recipients: 3, created: [500, 501, 502], alreadyPresent: [] },
      },
    ]);
    expect(JSON.stringify(res.effects)).not.toContain('congé');
    expect(JSON.stringify(res.effects)).not.toContain('Traiter');
    expect(ctx.scratch.get(SCRATCH_IMPUTATIONS_CREATED)).toEqual([500, 501, 502]);
  });

  it('imputation identique encore ouverte : pas de doublon (already_present)', async () => {
    const { courrier, ctx, tx } = setup({ existing: (w) => (w.userId === 30 ? { mailInputationId: 77 } : null) });
    const res = await courrier.apply(ctx, courrier.parse(args([{ userGroupId: 30, mailInputationTypeId: 10 }])));
    expect(tx.mailInputation.create).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(res.effects[0].summary).toMatchObject({ status: 'already_present', created: [], alreadyPresent: [77] });
    expect(tx.mailInputation.findFirst.mock.calls[0][0]).toEqual({
      where: { mailId: 5, userId: 30, mailInputationTypeId: 10, dateTreated: null },
      select: { mailInputationId: true },
    });
  });

  it('un destinataire non imputable (par le valideur OU le lanceur) : refus de TOUTE l’action, rien écrit', async () => {
    for (const blocked of [validator, launcher]) {
      const { courrier, ctx, writes } = setup({ imputable: (u, id) => !(u === blocked && id === 31) });
      const p = courrier.apply(ctx, courrier.parse(args([{ userGroupId: 30, mailInputationTypeId: 10 }, { userGroupId: 31, mailInputationTypeId: 10 }])));
      await expect(p).rejects.toMatchObject({ code: 'recipient_not_imputable', message: expect.stringContaining('n°31') });
      expect(writes).toEqual([]);
    }
  });

  it('type inactif ou inconnu, doublon dans l’action, courrier supprimé : refus, rien écrit', async () => {
    const inactive = setup({ activeTypes: [{ mailInputationTypeId: 10, label: 'Pour Suivi' }] });
    await expect(
      inactive.courrier.apply(inactive.ctx, inactive.courrier.parse(args([{ userGroupId: 30, mailInputationTypeId: 14 }]))),
    ).rejects.toMatchObject({ code: 'inputation_type_invalid' });

    const dup = setup();
    await expect(
      dup.courrier.apply(dup.ctx, dup.courrier.parse(args([{ userGroupId: 30, mailInputationTypeId: 10 }, { userGroupId: 30, mailInputationTypeId: 10 }]))),
    ).rejects.toMatchObject({ code: 'duplicate_recipient' });

    const gone = setup({ mail: null });
    await expect(gone.courrier.apply(gone.ctx, gone.courrier.parse(args([{ userGroupId: 30, mailInputationTypeId: 10 }])))).rejects.toMatchObject({
      code: 'mail_not_found',
    });
    for (const s of [inactive, dup, gone]) expect(s.writes).toEqual([]);
  });

  it('droits refusés (menu ou lecture du courrier) : levée avant toute lecture ou écriture', async () => {
    const noMenu = setup({
      rights: { requireAnyMenu: jest.fn(async () => Promise.reject(new EffectRefusedError('Le valideur n’a pas le droit.', 'menu_denied'))) },
    });
    await expect(noMenu.courrier.apply(noMenu.ctx, noMenu.courrier.parse(args([{ userGroupId: 30, mailInputationTypeId: 10 }])))).rejects.toMatchObject({
      code: 'menu_denied',
    });
    expect(noMenu.tx.mail.findFirst).not.toHaveBeenCalled();

    const blind = setup({
      rights: { requireMailReadable: jest.fn(async () => Promise.reject(new EffectRefusedError('Illisible.', 'mail_not_readable'))) },
    });
    await expect(blind.courrier.apply(blind.ctx, blind.courrier.parse(args([{ userGroupId: 30, mailInputationTypeId: 10 }])))).rejects.toMatchObject({
      code: 'mail_not_readable',
    });
    expect(blind.writes).toEqual([]);
  });
});

describe('ImputationBaseApplier (outil de base proposer_imputation)', () => {
  it('cible « user » : type rapproché par libellé (casse ignorée), sinon « Pour Suivi » (10)', async () => {
    const matched = setup();
    const res = await matched.base.apply(
      matched.ctx,
      matched.base.parse({ mailId: 5, target: { kind: 'user', id: 30 }, imputationType: '  validation   direction ', rationale: 'r' }),
    );
    expect(matched.tx.mailInputation.create.mock.calls[0][0]).toMatchObject({ data: { userId: 30, mailInputationTypeId: 14, createdBy: 20 } });
    expect(res.effects[0]).toMatchObject({ tool: 'proposer_imputation', summary: { recipients: 1, created: [500] } });

    const fallback = setup();
    await fallback.base.apply(fallback.ctx, fallback.base.parse({ mailId: 5, target: { kind: 'user', id: 30 }, imputationType: 'Urgent', rationale: 'r' }));
    expect(fallback.tx.mailInputation.create.mock.calls[0][0]).toMatchObject({ data: { mailInputationTypeId: 10 } });

    const none = setup();
    await none.base.apply(none.ctx, none.base.parse({ mailId: 5, target: { kind: 'user', id: 30 }, rationale: 'r' }));
    expect(none.tx.mailInputation.create.mock.calls[0][0]).toMatchObject({ data: { mailInputationTypeId: 10 } });
  });

  it('cible « role » : refus explicable ; arguments inconnus : refus', async () => {
    const { base, ctx, writes } = setup();
    await expect(base.apply(ctx, base.parse({ mailId: 5, target: { kind: 'role', id: 4 }, rationale: 'r' }))).rejects.toThrow(
      /rôle non prise en charge/,
    );
    expect(writes).toEqual([]);
    expect(() => base.parse({ mailId: 5, target: { kind: 'user', id: 4 }, rationale: 'r', autre: true })).toThrow(EffectRefusedError);
  });
});
