import { Logger } from '@nestjs/common';
import {
  AsstActionTool,
  AsstMessageRole,
  AsstProposalStatus,
  type AsstProposalDto,
  type AsstProposedAction,
} from '@archivage/types';
import { ActionApplierRegistry } from '../../workflow-agent-catalog/appliers/action-applier.registry';
import { EffectRefusedError, type ActionApplier, type ApplierContext } from '../../workflow-agent-catalog/catalog.contracts';
import { AsstError, type AsstIdentity, type AsstProposalTransition } from '../assistant.contracts';
import { FakeAsstIdentity, InMemoryProposalStore, makeAsstIdentity } from '../testing';
import { asstActionsHash } from './asst-actions-hash';
import { AsstExecutorService } from './asst-executor.service';

const T0 = new Date('2026-11-22T09:00:00.000Z');
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Magasin en mémoire SENSIBLE à la transaction : une transition écrite avec `db` est annulée si la transaction
// du faux Prisma est annulée (comme la base le ferait). Accès aux lignes internes : test seulement.
// ---------------------------------------------------------------------------

interface FakeTx {
  journal: Array<{ op: string; detail?: unknown }>;
  rollbackHooks: Array<() => void>;
  $queryRaw: jest.Mock;
  dataChangeAudit: { create: jest.Mock };
}

interface Row {
  status: number;
  actions: unknown;
  argsHash: string;
}

class TxAwareStore extends InMemoryProposalStore {
  rows(): Map<number, Row> {
    return (this as unknown as { proposals: Map<number, Row> }).proposals;
  }

  override async transitionProposal(t: AsstProposalTransition): Promise<AsstProposalDto | null> {
    const tx = t.db as FakeTx | undefined;
    const id = Number(t.proposalId);
    const rows = this.rows();
    const snapshot = tx && rows.has(id) ? structuredClone(rows.get(id) as Row) : undefined;
    const out = await super.transitionProposal(t);
    if (tx && out && snapshot) tx.rollbackHooks.push(() => rows.set(id, snapshot));
    return out;
  }
}

function makePrisma(opts: { emergencyStop?: boolean | 'error' } = {}) {
  const state = { committed: [] as FakeTx['journal'], rolledBack: 0, transactions: 0 };
  const prisma = {
    wfBudget: {
      findFirst: jest.fn(async () => {
        if (opts.emergencyStop === 'error') throw new Error('budget illisible');
        return { emergencyStop: opts.emergencyStop === true };
      }),
    },
    $transaction: jest.fn(async (fn: (tx: FakeTx) => Promise<unknown>) => {
      state.transactions += 1;
      const tx: FakeTx = {
        journal: [],
        rollbackHooks: [],
        $queryRaw: jest.fn(async (q: { sql: string; values: unknown[] }) => {
          tx.journal.push({ op: /FROM mail_inputation /.test(q.sql) ? 'lock:mail_inputation' : 'lock:mail', detail: q.values[0] });
          return [];
        }),
        dataChangeAudit: {
          create: jest.fn(async ({ data }: { data: unknown }) => {
            tx.journal.push({ op: 'audit', detail: data });
            return {};
          }),
        },
      };
      try {
        const out = await fn(tx);
        state.committed.push(...tx.journal);
        return out;
      } catch (err) {
        state.rolledBack += 1;
        for (const hook of tx.rollbackHooks.reverse()) hook();
        throw err;
      }
    }),
  };
  return { prisma, state };
}

// ---------------------------------------------------------------------------
// Applicateurs factices (clés réelles, sideEffect 1)
// ---------------------------------------------------------------------------

function fakeApplier(toolKey: string, summary: (args: Record<string, unknown>) => Record<string, unknown>) {
  const applier: ActionApplier<Record<string, unknown>> & { apply: jest.Mock } = {
    toolKey,
    sideEffect: 1,
    parse: (args: unknown) => args as Record<string, unknown>,
    apply: jest.fn(async (ctx: ApplierContext, args: Record<string, unknown>) => {
      (ctx.tx as unknown as FakeTx).journal.push({ op: `apply:${toolKey}` });
      return { effects: [{ tool: toolKey, summary: summary(args) }] };
    }),
  };
  return applier;
}

const imputation = (mailId = 30): AsstProposedAction => ({
  tool: AsstActionTool.ImputationCourrier,
  args: { mailId, recipients: [{ userGroupId: 17, mailInputationTypeId: 10, delayDays: 3 }], rationale: 'Pour suivi' },
});
const relance = (mailId = 12, mailInputationId = 900): AsstProposedAction => ({
  tool: AsstActionTool.Relance,
  args: { mailId, mailInputationId, recipientUserGroupId: 17, message: 'Merci de traiter' },
});
const brouillon = (): AsstProposedAction => ({
  tool: AsstActionTool.BrouillonReponse,
  args: { templateId: 'accuse-reception', label: 'Réponse', draftHtml: '<p>Texte du brouillon</p>', mailId: 12, spaceId: 4, decisionId: '777' },
});

function setup(opts: { emergencyStop?: boolean | 'error'; skip?: string[] } = {}) {
  let now = T0;
  const store = new TxAwareStore();
  const identities = new FakeAsstIdentity([makeAsstIdentity(1), makeAsstIdentity(2)]);
  const registry = new ActionApplierRegistry();
  const appliers = {
    imputation: fakeApplier(AsstActionTool.ImputationCourrier, (a) => ({ status: 'applied', mailId: a['mailId'], recipients: 1, created: [501] })),
    relance: fakeApplier(AsstActionTool.Relance, (a) => ({ mailId: a['mailId'], mailInputationId: a['mailInputationId'] })),
    brouillon: fakeApplier(AsstActionTool.BrouillonReponse, () => ({ documentId: 55, spaceId: 4, templateId: 'accuse-reception' })),
  };
  for (const a of Object.values(appliers)) if (!opts.skip?.includes(a.toolKey)) registry.register(a);
  const rightsFactory = {
    create: jest.fn((validator: unknown, launcher: unknown) => ({
      validator,
      launcher,
      requireAnyMenu: jest.fn(),
      requireMailReadable: jest.fn(),
    })),
  };
  const limiter = { consume: jest.fn() };
  const { prisma, state } = makePrisma(opts);
  const svc = new AsstExecutorService(prisma as never, registry, rightsFactory as never, identities, store, limiter as never);
  svc.clock = () => now;

  const seed = async (
    actions: AsstProposedAction[],
    o: { userId?: number; userGroupId?: number; at?: Date } = {},
  ): Promise<AsstProposalDto> => {
    const userId = o.userId ?? 1;
    const at = o.at ?? T0;
    const conv = await store.createConversation({ userId, userGroupId: userId * 10, now: at });
    const msg = await store.appendMessage(userId, { conversationId: conv.conversationId, role: AsstMessageRole.Assistant, content: 'Proposition' }, at);
    return store.createProposal(
      {
        conversationId: conv.conversationId,
        messageId: msg!.messageId,
        userId,
        userGroupId: o.userGroupId ?? userId * 10,
        actions,
        summary: 'Résumé de la proposition',
        argsHash: asstActionsHash(actions),
        expiresAt: new Date(at.getTime() + 15 * MIN),
      },
      at,
    );
  };
  const read = async (p: AsstProposalDto, userId = 1) => (await store.getProposal(userId, p.proposalId))!;
  const setNow = (d: Date) => {
    now = d;
  };
  const who = (userId = 1): AsstIdentity => makeAsstIdentity(userId);
  return { svc, store, identities, registry, appliers, rightsFactory, limiter, prisma, state, seed, read, setNow, who };
}

async function rejection(promise: Promise<unknown>): Promise<AsstError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AsstError) return err;
    throw err;
  }
  throw new Error('rejet attendu');
}

let warn: jest.SpyInstance;
let log: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// confirm
// ---------------------------------------------------------------------------

describe('AsstExecutorService.confirm — succès', () => {
  it('une action : effets, traçabilité, statut Appliquée, rowVersion 2', async () => {
    const { svc, seed, appliers, state, read, limiter } = setup();
    const p = await seed([imputation(30)]);
    const out = await svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash });
    expect(out.status).toBe(AsstProposalStatus.Applied);
    expect(out.rowVersion).toBe(2);
    expect(out.confirmedAt).toBe(T0.toISOString());
    expect(out.finishedAt).toBe(T0.toISOString());
    expect(out.result).toEqual({
      effects: [{ tool: 'proposer_imputation_courrier', summary: { status: 'applied', mailId: 30, recipients: 1, created: [501] } }],
    });
    expect(appliers.imputation.apply).toHaveBeenCalledTimes(1);
    expect(state.transactions).toBe(1);
    const audits = state.committed.filter((e) => e.op === 'audit');
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toMatchObject({ userGroupId: 10, actorFullName: 'user1', objectRef: 'mail:30' });
    expect((await read(p)).status).toBe(AsstProposalStatus.Applied);
    expect(limiter.consume).toHaveBeenCalledWith(1, T0);
  });

  it('trois actions : effets dans l’ordre, une trace par effet, verrous avant la première action', async () => {
    const { svc, seed, state, appliers } = setup();
    const p = await seed([relance(30, 900), imputation(12), brouillon()]);
    const out = await svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash });
    expect(out.status).toBe(AsstProposalStatus.Applied);
    expect(out.rowVersion).toBe(2);
    expect(out.result?.effects.map((e) => e.tool)).toEqual([
      'proposer_relance',
      'proposer_imputation_courrier',
      'preparer_brouillon_reponse',
    ]);
    const ops = state.committed.map((e) => (e.op.startsWith('lock') ? `${e.op}:${String(e.detail)}` : e.op));
    expect(ops).toEqual([
      'lock:mail:12',
      'lock:mail:30',
      'lock:mail_inputation:900',
      'apply:proposer_relance',
      'audit',
      'apply:proposer_imputation_courrier',
      'audit',
      'apply:preparer_brouillon_reponse',
      'audit',
    ]);
    const draftAudit = state.committed.filter((e) => e.op === 'audit')[2].detail as { newValue: string; objectRef: string };
    expect(draftAudit.objectRef).toBe(`asst_proposal:${p.proposalId}`);
    expect(draftAudit.newValue).toContain('décision IA 777');
    expect(draftAudit.newValue).not.toContain('Texte du brouillon');
    for (const a of Object.values(appliers)) expect(a.apply).toHaveBeenCalledTimes(1);
  });

  it('utilise l’identité RELUE (pas celle passée) et le même utilisateur dans les deux rôles', async () => {
    const { svc, seed, rightsFactory, appliers } = setup();
    const p = await seed([imputation()]);
    const stale = makeAsstIdentity(1, { isAdmin: true, groupIds: [99] });
    await svc.confirm(stale, p.proposalId, { argsHash: p.argsHash });
    const fresh = makeAsstIdentity(1);
    expect(rightsFactory.create).toHaveBeenCalledWith(fresh.user, fresh.user, expect.anything());
    const ctx = appliers.imputation.apply.mock.calls[0][0] as ApplierContext;
    expect(ctx.validatorPrincipal).toEqual(fresh.principal);
    expect(ctx.instanceId).toBe(`asst:${p.proposalId}`);
    expect(ctx.scratch).toBeInstanceOf(Map);
  });

  it('arrêt d’urgence actif : journalisé (identifiant seulement) et exécution quand même', async () => {
    const { svc, seed, prisma } = setup({ emergencyStop: true });
    const p = await seed([imputation()]);
    const out = await svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash });
    expect(out.status).toBe(AsstProposalStatus.Applied);
    expect(prisma.wfBudget.findFirst).toHaveBeenCalledWith({ where: { definitionId: null }, select: { emergencyStop: true } });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("arrêt d'urgence") && m.includes(p.proposalId))).toBe(true);
    expect(messages.join('\n')).not.toContain('Pour suivi');
  });

  it('lecture de l’arrêt d’urgence en échec : ne bloque pas', async () => {
    const { svc, seed } = setup({ emergencyStop: 'error' });
    const p = await seed([imputation()]);
    const out = await svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash });
    expect(out.status).toBe(AsstProposalStatus.Applied);
  });
});

describe('AsstExecutorService.confirm — refus avant exécution', () => {
  it('hash du corps différent => conflict, aucune écriture', async () => {
    const { svc, seed, read, prisma } = setup();
    const p = await seed([imputation()]);
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: 'b'.repeat(64) }));
    expect(err.errorCode).toBe('conflict');
    expect(err.message).toContain('relisez');
    expect(await read(p)).toEqual(p);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('hash stocké altéré (hash recalculé différent) => conflict, aucune écriture', async () => {
    const { svc, seed, store, read, prisma } = setup();
    const p = await seed([imputation()]);
    const forged = 'c'.repeat(64);
    store.rows().get(Number(p.proposalId))!.argsHash = forged;
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: forged }));
    expect(err.errorCode).toBe('conflict');
    expect((await read(p)).status).toBe(AsstProposalStatus.Proposed);
    expect((await read(p)).rowVersion).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('actions stockées modifiées sans changer le hash => conflict', async () => {
    const { svc, seed, store, prisma } = setup();
    const p = await seed([imputation(30)]);
    store.rows().get(Number(p.proposalId))!.actions = [imputation(31)];
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('conflict');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('outil hors liste blanche injecté dans le magasin => conflict par le schéma, rien appliqué', async () => {
    const { svc, seed, store, read, prisma, appliers } = setup();
    const p = await seed([imputation()]);
    const forged = [{ tool: 'proposer_delegation', args: { mailId: 1, mailInputationId: 2, delegateUserGroupId: 3, rationale: 'x' } }];
    const row = store.rows().get(Number(p.proposalId))!;
    row.actions = forged;
    row.argsHash = asstActionsHash(forged as unknown as AsstProposedAction[]);
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: row.argsHash }));
    expect(err.errorCode).toBe('conflict');
    expect((await read(p)).status).toBe(AsstProposalStatus.Proposed);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(appliers.imputation.apply).not.toHaveBeenCalled();
  });

  it('proposition expirée => passe en Expirée et proposal_expired (proposition close jointe)', async () => {
    const { svc, seed, read, setNow, prisma } = setup();
    const p = await seed([imputation()]);
    setNow(new Date(T0.getTime() + 15 * MIN));
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('proposal_expired');
    expect(err.proposal?.status).toBe(AsstProposalStatus.Expired);
    expect((await read(p)).status).toBe(AsstProposalStatus.Expired);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('expirée et clôture impossible : proposal_expired quand même, sans proposition jointe', async () => {
    const { svc, seed, store, setNow } = setup();
    const p = await seed([imputation()]);
    setNow(new Date(T0.getTime() + 16 * MIN));
    jest.spyOn(store, 'transitionProposal').mockRejectedValue(new Error('base indisponible'));
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('proposal_expired');
    expect(err.proposal).toBeUndefined();
  });

  it('échéance atteinte entre la lecture et le CAS (le déclencheur refuse 0->1) => proposal_expired', async () => {
    const { svc, seed, read, store } = setup();
    const p = await seed([imputation()]);
    let calls = 0;
    // Première lecture de l'horloge : avant l'échéance ; suivantes : après (le CAS arrive trop tard).
    svc.clock = () => (calls++ === 0 ? new Date(T0.getTime() + 15 * MIN - 1) : new Date(T0.getTime() + 15 * MIN));
    const original = store.transitionProposal.bind(store);
    jest.spyOn(store, 'transitionProposal').mockImplementation((t) =>
      original(t.to === AsstProposalStatus.Confirmed ? { ...t, now: new Date(T0.getTime() + 15 * MIN) } : t),
    );
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('proposal_expired');
    expect((await read(p)).status).toBe(AsstProposalStatus.Expired);
  });

  it('erreur du CAS sans échéance : relancée telle quelle', async () => {
    const { svc, seed, store } = setup();
    const p = await seed([imputation()]);
    jest.spyOn(store, 'transitionProposal').mockRejectedValueOnce(new Error('panne'));
    await expect(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash })).rejects.toThrow('panne');
  });

  it('déjà confirmée et appliquée => proposal_not_pending, jamais rejouée', async () => {
    const { svc, seed, appliers } = setup();
    const p = await seed([imputation()]);
    await svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash });
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('proposal_not_pending');
    expect(err.proposal?.status).toBe(AsstProposalStatus.Applied);
    expect(appliers.imputation.apply).toHaveBeenCalledTimes(1);
  });

  it('refusée => proposal_not_pending', async () => {
    const { svc, seed } = setup();
    const p = await seed([imputation()]);
    await svc.refuse(makeAsstIdentity(1), p.proposalId);
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('proposal_not_pending');
  });

  it('double confirmation concurrente : une seule exécution, l’autre conflict', async () => {
    const { svc, seed, appliers, read } = setup();
    const p = await seed([imputation()]);
    const results = await Promise.allSettled([
      svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }),
      svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const ko = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect((ko[0].reason as AsstError).errorCode).toBe('conflict');
    expect((ko[0].reason as AsstError).message).toContain("vient d'être traitée");
    expect(appliers.imputation.apply).toHaveBeenCalledTimes(1);
    expect((await read(p)).status).toBe(AsstProposalStatus.Applied);
  });

  it('proposition d’un autre utilisateur => not_found', async () => {
    const { svc, seed, read } = setup();
    const p = await seed([imputation()], { userId: 2 });
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('not_found');
    expect((await read(p, 2)).status).toBe(AsstProposalStatus.Proposed);
  });

  it('proposition inexistante => not_found', async () => {
    const { svc } = setup();
    const err = await rejection(svc.confirm(makeAsstIdentity(1), '999', { argsHash: 'a'.repeat(64) }));
    expect(err.errorCode).toBe('not_found');
  });

  it('acteur absent (masquage concurrent) => not_found', async () => {
    const { svc, seed, store } = setup();
    const p = await seed([imputation()]);
    jest.spyOn(store, 'getProposalActor').mockResolvedValueOnce(null);
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('not_found');
  });

  it('acteur différent (même utilisateur, autre userGroupId) => identity_refused, rien exécuté', async () => {
    const { svc, seed, read, appliers } = setup();
    const p = await seed([imputation()], { userGroupId: 99 });
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('identity_refused');
    expect((await read(p)).status).toBe(AsstProposalStatus.Proposed);
    expect(appliers.imputation.apply).not.toHaveBeenCalled();
  });

  it('compte devenu inactif entre-temps => identity_refused, rien lu ni exécuté', async () => {
    const { svc, seed, identities, store, limiter, appliers } = setup();
    const p = await seed([imputation()]);
    identities.refuse(1);
    const get = jest.spyOn(store, 'getProposal');
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('identity_refused');
    expect(get).not.toHaveBeenCalled();
    expect(limiter.consume).not.toHaveBeenCalled();
    expect(appliers.imputation.apply).not.toHaveBeenCalled();
  });

  it('identité machine (isScanAgent) => identity_refused', async () => {
    const { svc, seed, appliers } = setup();
    const p = await seed([imputation()]);
    const machine = makeAsstIdentity(1);
    const err = await rejection(
      svc.confirm({ ...machine, user: { ...machine.user, isScanAgent: true } }, p.proposalId, { argsHash: p.argsHash }),
    );
    expect(err.errorCode).toBe('identity_refused');
    expect(appliers.imputation.apply).not.toHaveBeenCalled();
  });

  it('limiteur qui lève budget_exceeded => aucune lecture ni écriture du magasin', async () => {
    const { svc, seed, store, limiter, prisma } = setup();
    const p = await seed([imputation()]);
    limiter.consume.mockImplementationOnce(() => {
      throw new AsstError('budget_exceeded', 'Trop de confirmations.');
    });
    const get = jest.spyOn(store, 'getProposal');
    const transition = jest.spyOn(store, 'transitionProposal');
    const err = await rejection(svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(err.errorCode).toBe('budget_exceeded');
    expect(get).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.wfBudget.findFirst).not.toHaveBeenCalled();
  });
});

describe('AsstExecutorService.confirm — échec à l’exécution', () => {
  async function failWith(err: Error, actions: AsstProposedAction[] = [imputation()]) {
    const ctx = setup();
    const p = await ctx.seed(actions);
    ctx.appliers.imputation.apply.mockRejectedValueOnce(err);
    const error = await rejection(ctx.svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    return { ...ctx, p, error, stored: await ctx.read(p) };
  }

  it('droits retirés entre-temps (menu_denied) => effect_forbidden, proposition en échec', async () => {
    const { error, stored, state } = await failWith(new EffectRefusedError("Le valideur n'a pas le droit d'imputer.", 'menu_denied'));
    expect(error.errorCode).toBe('effect_forbidden');
    expect(error.message).toBe("Le valideur n'a pas le droit d'imputer.");
    expect(error.proposal?.status).toBe(AsstProposalStatus.Failed);
    expect(error.proposal?.errorCode).toBe('menu_denied');
    expect(stored).toMatchObject({ status: AsstProposalStatus.Failed, errorCode: 'menu_denied', rowVersion: 2, result: null });
    expect(state.rolledBack).toBe(1);
    expect(state.committed).toEqual([]);
  });

  it('courrier devenu illisible => effect_forbidden', async () => {
    const { error, stored } = await failWith(new EffectRefusedError('Courrier illisible.', 'mail_not_readable'));
    expect(error.errorCode).toBe('effect_forbidden');
    expect(stored.errorCode).toBe('mail_not_readable');
  });

  it('doublon d’imputation (duplicate_recipient) => effect_failed', async () => {
    const { error, stored } = await failWith(new EffectRefusedError('Destinataire en double.', 'duplicate_recipient'));
    expect(error.errorCode).toBe('effect_failed');
    expect(stored).toMatchObject({ status: AsstProposalStatus.Failed, errorCode: 'duplicate_recipient', errorMessage: 'Destinataire en double.' });
  });

  it('relance non échue (not_late) => effect_failed avec le message de l’applicateur', async () => {
    const ctx = setup();
    const p = await ctx.seed([relance()]);
    ctx.appliers.relance.apply.mockRejectedValueOnce(new EffectRefusedError('Relance refusée : imputation pas en retard.', 'not_late'));
    const error = await rejection(ctx.svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(error.errorCode).toBe('effect_failed');
    expect(error.message).toBe('Relance refusée : imputation pas en retard.');
    expect(error.proposal).toMatchObject({ status: AsstProposalStatus.Failed, errorCode: 'not_late', errorMessage: 'Relance refusée : imputation pas en retard.' });
  });

  it('message d’erreur tronqué à 1000 caractères dans la proposition', async () => {
    const { stored } = await failWith(new EffectRefusedError('x'.repeat(1500), 'too_long'));
    expect(stored.errorMessage).toHaveLength(1000);
  });

  it('brouillon puis échec d’une action suivante : compensations en ordre inverse, une fois, isolées', async () => {
    const ctx = setup();
    const order: string[] = [];
    const draftUndo = jest.fn(async () => void order.push('brouillon'));
    const relanceUndo = jest.fn(async () => {
      order.push('relance');
      throw new Error('échec de compensation');
    });
    ctx.appliers.brouillon.apply.mockImplementationOnce(async () => ({ effects: [], compensate: draftUndo }));
    ctx.appliers.relance.apply.mockImplementationOnce(async () => ({ effects: [], compensate: relanceUndo }));
    ctx.appliers.imputation.apply.mockRejectedValueOnce(new EffectRefusedError('Destinataire en double.', 'duplicate_recipient'));
    const p = await ctx.seed([brouillon(), relance(), imputation()]);
    const error = await rejection(ctx.svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(error.errorCode).toBe('effect_failed');
    expect(order).toEqual(['relance', 'brouillon']);
    expect(draftUndo).toHaveBeenCalledTimes(1);
    expect(relanceUndo).toHaveBeenCalledTimes(1);
    expect((await ctx.read(p)).status).toBe(AsstProposalStatus.Failed);
  });

  it('outil sans applicateur enregistré => effect_failed no_applier, rien appliqué', async () => {
    const ctx = setup({ skip: [AsstActionTool.Relance] });
    const p = await ctx.seed([imputation(), relance()]);
    const error = await rejection(ctx.svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(error.errorCode).toBe('effect_failed');
    expect(error.proposal).toMatchObject({ status: AsstProposalStatus.Failed, errorCode: 'no_applier' });
    expect(ctx.appliers.imputation.apply).not.toHaveBeenCalled();
    expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('erreur technique générique => effect_failed sans fuite du message technique', async () => {
    const { error, stored } = await failWith(new Error('ECONNRESET corps du courrier : « confidentiel »'));
    expect(error.errorCode).toBe('effect_failed');
    expect(error.message).toBe("L'action n'a pas pu être appliquée (erreur technique) : rien n'a été enregistré.");
    expect(stored).toMatchObject({ errorCode: 'effect_failed', errorMessage: error.message });
    expect(JSON.stringify(stored)).not.toContain('confidentiel');
  });

  it('passage en échec impossible (balayage concurrent) : la proposition est relue et l’erreur levée quand même', async () => {
    const ctx = setup();
    const p = await ctx.seed([imputation()]);
    ctx.appliers.imputation.apply.mockImplementationOnce(async () => {
      // Le balayeur clôt la proposition pendant l'exécution.
      await ctx.svc.recoverInterrupted(new Date(T0.getTime() + 10 * MIN), 10, 0);
      throw new EffectRefusedError('Refus.', 'not_late');
    });
    const error = await rejection(ctx.svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(error.errorCode).toBe('effect_failed');
    expect(error.proposal).toMatchObject({ status: AsstProposalStatus.Failed, errorCode: 'execution_interrupted' });
  });

  it('transition 1->5 qui lève : relue et erreur levée avec la proposition relue', async () => {
    const ctx = setup();
    const p = await ctx.seed([imputation()]);
    ctx.appliers.imputation.apply.mockRejectedValueOnce(new EffectRefusedError('Refus.', 'not_late'));
    const original = ctx.store.transitionProposal.bind(ctx.store);
    jest.spyOn(ctx.store, 'transitionProposal').mockImplementation((t) =>
      t.to === AsstProposalStatus.Failed ? Promise.reject(new Error('panne')) : original(t),
    );
    const error = await rejection(ctx.svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(error.errorCode).toBe('effect_failed');
    expect(error.proposal?.status).toBe(AsstProposalStatus.Confirmed);
  });

  it('issue incertaine après COMMIT : proposition NON close (reste Confirmée), erreur effect_failed outcome uncertain', async () => {
    const ctx = setup();
    const p = await ctx.seed([imputation()]);
    const run = jest.spyOn(ctx.svc['runner'], 'run').mockResolvedValue({
      ok: false,
      failure: { kind: 'uncertain', errorCode: 'result_uncertain', message: "L'issue de l'exécution est incertaine." },
    } as never);
    const transition = jest.spyOn(ctx.store, 'transitionProposal');
    const error = await rejection(ctx.svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(error.errorCode).toBe('effect_failed');
    expect(error.message).toBe("L'issue de l'exécution est incertaine.");
    expect(error.details).toEqual({ outcome: 'uncertain' });
    expect(error.proposal?.status).toBe(AsstProposalStatus.Confirmed);
    expect((await ctx.read(p)).status).toBe(AsstProposalStatus.Confirmed);
    // Seule la transition 0 -> 1 a eu lieu : aucune vers Échec.
    expect(transition.mock.calls.map((c) => c[0].to)).toEqual([AsstProposalStatus.Confirmed]);
  });
});

// ---------------------------------------------------------------------------
// refuse
// ---------------------------------------------------------------------------

describe('AsstExecutorService.refuse', () => {
  it('succès : statut Refusée ; motif journalisé (une ligne, 500 caractères au plus), non stocké', async () => {
    const { svc, seed } = setup();
    const p = await seed([imputation()]);
    const out = await svc.refuse(makeAsstIdentity(1), p.proposalId, `Déjà traité\nhors application ${'z'.repeat(600)}`);
    expect(out).toMatchObject({ status: AsstProposalStatus.Refused, rowVersion: 1, finishedAt: T0.toISOString(), errorMessage: null });
    const line = String(log.mock.calls.at(-1)?.[0]);
    expect(line).toContain(`proposition ${p.proposalId} refusée`);
    expect(line).toContain('Déjà traité hors application');
    expect(line).not.toContain('\n');
    expect(line.split('motif : ')[1]).toHaveLength(500);
  });

  it('sans motif', async () => {
    const { svc, seed } = setup();
    const p = await seed([imputation()]);
    expect((await svc.refuse(makeAsstIdentity(1), p.proposalId)).status).toBe(AsstProposalStatus.Refused);
  });

  it('expirée => clôturée (4) et proposal_expired', async () => {
    const { svc, seed, setNow, read } = setup();
    const p = await seed([imputation()]);
    setNow(new Date(T0.getTime() + 20 * MIN));
    const err = await rejection(svc.refuse(makeAsstIdentity(1), p.proposalId));
    expect(err.errorCode).toBe('proposal_expired');
    expect((await read(p)).status).toBe(AsstProposalStatus.Expired);
  });

  it('autre statut => proposal_not_pending', async () => {
    const { svc, seed } = setup();
    const p = await seed([imputation()]);
    await svc.confirm(makeAsstIdentity(1), p.proposalId, { argsHash: p.argsHash });
    expect((await rejection(svc.refuse(makeAsstIdentity(1), p.proposalId))).errorCode).toBe('proposal_not_pending');
  });

  it('autre utilisateur => not_found', async () => {
    const { svc, seed } = setup();
    const p = await seed([imputation()], { userId: 2 });
    expect((await rejection(svc.refuse(makeAsstIdentity(1), p.proposalId))).errorCode).toBe('not_found');
  });

  it('autre acteur => identity_refused', async () => {
    const { svc, seed } = setup();
    const p = await seed([imputation()], { userGroupId: 99 });
    expect((await rejection(svc.refuse(makeAsstIdentity(1), p.proposalId))).errorCode).toBe('identity_refused');
  });

  it('CAS perdu => conflict', async () => {
    const { svc, seed, store } = setup();
    const p = await seed([imputation()]);
    jest.spyOn(store, 'transitionProposal').mockResolvedValueOnce(null);
    expect((await rejection(svc.refuse(makeAsstIdentity(1), p.proposalId))).errorCode).toBe('conflict');
  });

  it('compte inactif => identity_refused', async () => {
    const { svc, seed, identities } = setup();
    const p = await seed([imputation()]);
    identities.refuse(1);
    expect((await rejection(svc.refuse(makeAsstIdentity(1), p.proposalId))).errorCode).toBe('identity_refused');
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('AsstExecutorService.get', () => {
  it('non échue : renvoyée telle quelle', async () => {
    const { svc, seed } = setup();
    const p = await seed([imputation()]);
    expect(await svc.get(makeAsstIdentity(1), p.proposalId)).toEqual(p);
  });

  it('échue : clôturée à la lecture (4)', async () => {
    const { svc, seed, setNow, read } = setup();
    const p = await seed([imputation()]);
    setNow(new Date(T0.getTime() + 15 * MIN));
    const out = await svc.get(makeAsstIdentity(1), p.proposalId);
    expect(out).toMatchObject({ status: AsstProposalStatus.Expired, rowVersion: 1 });
    expect((await read(p)).status).toBe(AsstProposalStatus.Expired);
  });

  it('échue et clôture impossible : PRÉSENTÉE comme expirée', async () => {
    const { svc, seed, setNow, store } = setup();
    const p = await seed([imputation()]);
    setNow(new Date(T0.getTime() + 15 * MIN));
    jest.spyOn(store, 'transitionProposal').mockRejectedValueOnce(new Error('panne'));
    const out = await svc.get(makeAsstIdentity(1), p.proposalId);
    expect(out.status).toBe(AsstProposalStatus.Expired);
  });

  it('introuvable ou à un autre utilisateur => not_found', async () => {
    const { svc, seed } = setup();
    const p = await seed([imputation()], { userId: 2 });
    expect((await rejection(svc.get(makeAsstIdentity(1), p.proposalId))).errorCode).toBe('not_found');
    expect((await rejection(svc.get(makeAsstIdentity(1), '424242'))).errorCode).toBe('not_found');
  });

  it('compte inactif => identity_refused', async () => {
    const { svc, seed, identities } = setup();
    const p = await seed([imputation()]);
    identities.refuse(1);
    expect((await rejection(svc.get(makeAsstIdentity(1), p.proposalId))).errorCode).toBe('identity_refused');
  });
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

describe('AsstExecutorService.expireDue', () => {
  it('clôt les propositions échues et retourne le nombre réellement expiré', async () => {
    const { svc, seed, read } = setup();
    const a = await seed([imputation()]);
    const b = await seed([imputation()], { userId: 2 });
    const fresh = await seed([imputation()], { at: new Date(T0.getTime() + 10 * MIN) });
    expect(await svc.expireDue(new Date(T0.getTime() + 16 * MIN), 50)).toBe(2);
    expect((await read(a)).status).toBe(AsstProposalStatus.Expired);
    expect((await read(b, 2)).status).toBe(AsstProposalStatus.Expired);
    expect((await read(fresh)).status).toBe(AsstProposalStatus.Proposed);
  });

  it('isole les erreurs et respecte la borne', async () => {
    const { svc, seed, store, read } = setup();
    const a = await seed([imputation()]);
    const b = await seed([imputation()]);
    const c = await seed([imputation()]);
    const original = store.transitionProposal.bind(store);
    jest
      .spyOn(store, 'transitionProposal')
      .mockImplementation((t) => (t.proposalId === a.proposalId ? Promise.reject(new Error('panne')) : original(t)));
    const at = new Date(T0.getTime() + 16 * MIN);
    expect(await svc.expireDue(at, 2)).toBe(1);
    expect((await read(b)).status).toBe(AsstProposalStatus.Expired);
    expect((await read(c)).status).toBe(AsstProposalStatus.Proposed);
    expect(warn.mock.calls.some((call) => String(call[0]).includes(a.proposalId))).toBe(true);
  });
});

describe('AsstExecutorService.recoverInterrupted', () => {
  async function confirmedOnly(ctx: ReturnType<typeof setup>, at: Date) {
    const p = await ctx.seed([imputation()]);
    await ctx.store.transitionProposal({
      proposalId: p.proposalId,
      expectedRowVersion: 0,
      expectedStatus: AsstProposalStatus.Proposed,
      to: AsstProposalStatus.Confirmed,
      now: at,
    });
    return p;
  }

  it('clôt en échec (execution_interrupted) les propositions confirmées depuis plus du délai de grâce', async () => {
    const ctx = setup();
    const p = await confirmedOnly(ctx, T0);
    expect(await ctx.svc.recoverInterrupted(new Date(T0.getTime() + 60_000), 10)).toBe(0);
    expect(await ctx.svc.recoverInterrupted(new Date(T0.getTime() + 120_001), 10)).toBe(1);
    expect(await ctx.read(p)).toMatchObject({
      status: AsstProposalStatus.Failed,
      errorCode: 'execution_interrupted',
      errorMessage:
        "L'exécution a été interrompue : aucun effet sur les courriers n'a été validé. Vérifiez l'état (un brouillon a pu être créé) puis refaites la demande.",
    });
  });

  it('délai de grâce paramétrable, erreurs isolées', async () => {
    const ctx = setup();
    const a = await confirmedOnly(ctx, T0);
    const b = await confirmedOnly(ctx, T0);
    const original = ctx.store.transitionProposal.bind(ctx.store);
    jest
      .spyOn(ctx.store, 'transitionProposal')
      .mockImplementation((t) => (t.proposalId === a.proposalId ? Promise.reject(new Error('panne')) : original(t)));
    expect(await ctx.svc.recoverInterrupted(new Date(T0.getTime() + 1_000), 10, 500)).toBe(1);
    expect((await ctx.read(b)).status).toBe(AsstProposalStatus.Failed);
    expect((await ctx.read(a)).status).toBe(AsstProposalStatus.Confirmed);
  });
});
