import { Logger } from '@nestjs/common';
import { AsstActionTool, AsstProposalStatus, type AsstProposalDto, type AsstProposedAction } from '@archivage/types';
import { ActionApplierRegistry } from '../../workflow-agent-catalog/appliers/action-applier.registry';
import {
  EffectRefusedError,
  type ActionApplier,
  type ApplierContext,
  type ApplierResult,
} from '../../workflow-agent-catalog/catalog.contracts';
import type { AsstProposalStore, AsstProposalTransition } from '../assistant.contracts';
import { makeAsstIdentity } from '../testing';
import { ASST_EFFECT_TX_OPTIONS, AsstEffectRunner, lockTargets } from './asst-effect-runner';

const NOW = new Date('2026-11-22T09:00:00.000Z');

// ---------------------------------------------------------------------------
// Faux client Prisma : transaction journalisée, annulation simulée
// ---------------------------------------------------------------------------

type JournalEntry =
  | { op: 'lock'; table: 'mail' | 'mail_inputation'; id: number }
  | { op: 'apply'; tool: string }
  | { op: 'audit'; data: Record<string, unknown> }
  | { op: 'transition'; to: number };

interface FakeTx {
  journal: JournalEntry[];
  $queryRaw: jest.Mock;
  dataChangeAudit: { create: jest.Mock };
}

function makePrisma(opts: { failCommit?: boolean; failAudit?: boolean } = {}) {
  const state = { committed: [] as JournalEntry[], rolledBack: 0, txs: [] as FakeTx[] };
  const makeTx = (): FakeTx => {
    const tx: FakeTx = {
      journal: [],
      $queryRaw: jest.fn(async (q: { sql: string; values: unknown[] }) => {
        const table = /FROM mail_inputation /.test(q.sql) ? 'mail_inputation' : 'mail';
        tx.journal.push({ op: 'lock', table, id: Number(q.values[0]) });
        return [];
      }),
      dataChangeAudit: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (opts.failAudit) throw new Error('audit indisponible');
          tx.journal.push({ op: 'audit', data });
          return {};
        }),
      },
    };
    return tx;
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (tx: FakeTx) => Promise<unknown>, _options?: unknown) => {
      const tx = makeTx();
      state.txs.push(tx);
      try {
        const out = await fn(tx);
        if (opts.failCommit) throw new Error('validation de la transaction impossible');
        state.committed.push(...tx.journal);
        return out;
      } catch (err) {
        state.rolledBack += 1;
        throw err;
      }
    }),
  };
  return { prisma, state };
}

// ---------------------------------------------------------------------------
// Applicateurs factices (clés réelles des trois outils)
// ---------------------------------------------------------------------------

type Impl = (ctx: ApplierContext, args: Record<string, unknown>) => Promise<ApplierResult>;

function fakeApplier(toolKey: string, impl?: Impl): ActionApplier<Record<string, unknown>> & { apply: jest.Mock; parse: jest.Mock } {
  return {
    toolKey,
    sideEffect: 1,
    parse: jest.fn((args: unknown) => args as Record<string, unknown>),
    apply: jest.fn(async (ctx: ApplierContext, args: Record<string, unknown>) => {
      (ctx.tx as unknown as FakeTx).journal.push({ op: 'apply', tool: toolKey });
      if (impl) return impl(ctx, args);
      return { effects: [{ tool: toolKey, summary: { mailId: args['mailId'] } }] };
    }),
  };
}

const imputation = (mailId = 30): AsstProposedAction => ({
  tool: AsstActionTool.ImputationCourrier,
  args: { mailId, recipients: [{ userGroupId: 17, mailInputationTypeId: 10 }], rationale: 'Pour suivi' },
});
const relance = (mailId = 12, mailInputationId = 900): AsstProposedAction => ({
  tool: AsstActionTool.Relance,
  args: { mailId, mailInputationId, recipientUserGroupId: 17, message: 'Merci de traiter' },
});
const brouillon = (over: { mailId?: number; decisionId?: string } = {}): AsstProposedAction => ({
  tool: AsstActionTool.BrouillonReponse,
  args: { templateId: 'accuse-reception', label: 'Réponse', draftHtml: '<p>Contenu confidentiel</p>', spaceId: 4, ...over },
});

function confirmedProposal(actions: AsstProposedAction[]): AsstProposalDto {
  return {
    proposalId: '41',
    conversationId: '3',
    messageId: '8',
    status: AsstProposalStatus.Confirmed,
    actions,
    summary: 'Résumé',
    argsHash: 'a'.repeat(64),
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    confirmedAt: NOW.toISOString(),
    finishedAt: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    rowVersion: 1,
  };
}

function setup(opts: { failCommit?: boolean; failAudit?: boolean; transitionNull?: boolean; skip?: string[] } = {}) {
  const { prisma, state } = makePrisma(opts);
  const registry = new ActionApplierRegistry();
  const appliers = {
    imputation: fakeApplier(AsstActionTool.ImputationCourrier),
    relance: fakeApplier(AsstActionTool.Relance),
    brouillon: fakeApplier(AsstActionTool.BrouillonReponse, async () => ({ effects: [{ tool: AsstActionTool.BrouillonReponse, summary: { documentId: 55, spaceId: 4 } }] })),
  };
  for (const a of Object.values(appliers)) if (!opts.skip?.includes(a.toolKey)) registry.register(a);
  const rightsFactory = {
    create: jest.fn((validator: unknown, launcher: unknown, db: unknown) => ({
      validator,
      launcher,
      db,
      requireAnyMenu: jest.fn(),
      requireMailReadable: jest.fn(),
    })),
  };
  const transitions: AsstProposalTransition[] = [];
  const store = {
    transitionProposal: jest.fn(async (t: AsstProposalTransition) => {
      transitions.push(t);
      if (opts.transitionNull) return null;
      (t.db as FakeTx).journal.push({ op: 'transition', to: t.to });
      return { ...confirmedProposal([]), status: t.to, rowVersion: t.expectedRowVersion + 1, result: t.result ?? null };
    }),
  } as unknown as AsstProposalStore & { transitionProposal: jest.Mock };
  const runner = new AsstEffectRunner(prisma as never, registry, rightsFactory as never, store);
  runner.retryDelaysMs = [0, 0];
  const identity = makeAsstIdentity(1, { username: 'agent.dupont' });
  const run = (actions: AsstProposedAction[]) =>
    runner.run({ identity, proposal: confirmedProposal(actions), actions, now: NOW });
  return { prisma, state, registry, appliers, rightsFactory, store, transitions, runner, identity, run };
}

afterEach(() => jest.restoreAllMocks());

describe('lockTargets', () => {
  it('retient les courriers et imputations distincts, triés par ordre croissant, et le premier courrier dans l’ordre des actions', () => {
    const out = lockTargets([relance(30, 900), imputation(12), relance(12, 500), brouillon({ mailId: 30 }), brouillon()]);
    expect(out).toEqual({ mailIds: [12, 30], inputationIds: [500, 900], firstMailId: 30 });
  });

  it('sans courrier : aucun verrou et sujet vide', () => {
    expect(lockTargets([brouillon()])).toEqual({ mailIds: [], inputationIds: [], firstMailId: null });
  });
});

describe('AsstEffectRunner', () => {
  it('applique dans une transaction bornée, verrous en ordre fixe AVANT la première action, transition finale en dernier', async () => {
    const { run, state, prisma, transitions } = setup();
    const out = await run([relance(30, 900), imputation(12), relance(12, 500), brouillon({ mailId: 30 })]);
    expect(out.ok).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual(ASST_EFFECT_TX_OPTIONS);
    expect(ASST_EFFECT_TX_OPTIONS).toEqual({ maxWait: 5000, timeout: 15000 });
    const ops = state.committed.map((e) =>
      e.op === 'lock' ? `lock:${e.table}:${e.id}` : e.op === 'apply' ? `apply:${e.tool}` : e.op === 'transition' ? `transition:${e.to}` : 'audit',
    );
    expect(ops.slice(0, 4)).toEqual(['lock:mail:12', 'lock:mail:30', 'lock:mail_inputation:500', 'lock:mail_inputation:900']);
    expect(ops[4]).toBe('apply:proposer_relance');
    expect(ops[ops.length - 1]).toBe('transition:2');
    expect(ops.filter((o) => o === 'audit')).toHaveLength(4);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      proposalId: '41',
      expectedRowVersion: 1,
      expectedStatus: AsstProposalStatus.Confirmed,
      to: AsstProposalStatus.Applied,
      now: NOW,
    });
    expect(transitions[0].db).toBe(state.txs[0]);
    expect(transitions[0].result?.effects.map((e) => e.tool)).toEqual([
      'proposer_relance',
      'proposer_imputation_courrier',
      'proposer_relance',
      'preparer_brouillon_reponse',
    ]);
  });

  it('fabrique le contexte : sentinelle non numérique, même utilisateur dans les deux rôles, principal, scratch partagé', async () => {
    const { run, appliers, rightsFactory, identity, state } = setup();
    appliers.imputation.apply.mockImplementationOnce(async (ctx: ApplierContext) => {
      ctx.scratch.set('memo', 'partagé');
      return { effects: [] };
    });
    await run([imputation(30), relance(12, 900)]);
    const ctx1 = appliers.imputation.apply.mock.calls[0][0] as ApplierContext;
    const ctx2 = appliers.relance.apply.mock.calls[0][0] as ApplierContext;
    expect(ctx1).toBe(ctx2);
    expect(ctx2.scratch.get('memo')).toBe('partagé');
    expect(ctx1.instanceId).toBe('asst:41');
    expect(/^[1-9]\d{0,17}$/.test(ctx1.instanceId)).toBe(false);
    expect(ctx1.taskId).toBe('asst:41');
    expect(ctx1.stepKey).toBe('assistant');
    expect(ctx1.definitionVersionId).toBe(0);
    expect(ctx1.subject).toEqual({ type: 'mail', id: '30' });
    expect(ctx1.input).toEqual({});
    expect(ctx1.stepConfig).toEqual({});
    expect(ctx1.now).toBe(NOW);
    expect(ctx1.tx).toBe(state.txs[0]);
    expect(ctx1.validatorPrincipal).toBe(identity.principal);
    expect(rightsFactory.create).toHaveBeenCalledTimes(1);
    expect(rightsFactory.create).toHaveBeenCalledWith(identity.user, identity.user, state.txs[0]);
    expect(ctx1.rights).toBe(rightsFactory.create.mock.results[0].value);
  });

  it('sujet vide quand aucune action ne vise un courrier', async () => {
    const { run, appliers } = setup();
    await run([brouillon()]);
    expect((appliers.brouillon.apply.mock.calls[0][0] as ApplierContext).subject).toEqual({ type: null, id: null });
  });

  it('trace chaque effet dans la transaction, sans contenu de brouillon, avec la décision IA', async () => {
    const { run, state } = setup();
    await run([imputation(30), brouillon({ decisionId: '777' })]);
    const audits = state.committed.filter((e): e is Extract<JournalEntry, { op: 'audit' }> => e.op === 'audit').map((e) => e.data);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toEqual({
      userGroupId: 10,
      actorFullName: 'agent.dupont',
      objectRef: 'mail:30',
      newValue: 'via assistant ; proposition 41 ; outil proposer_imputation_courrier ; {"mailId":30}',
    });
    expect(audits[1]).toMatchObject({ objectRef: 'asst_proposal:41' });
    expect(audits[1].newValue).toBe(
      'via assistant ; proposition 41 ; outil preparer_brouillon_reponse ; décision IA 777 ; {"documentId":55,"spaceId":4}',
    );
    expect(JSON.stringify(audits)).not.toContain('Contenu confidentiel');
  });

  it('borne le nom de l’acteur (200) et préfère fullName', async () => {
    const identity = makeAsstIdentity(1);
    const long = { ...identity, user: { ...identity.user, fullName: 'N'.repeat(300) } };
    const { prisma, state } = makePrisma();
    const registry = new ActionApplierRegistry();
    registry.register(fakeApplier(AsstActionTool.ImputationCourrier));
    const store = {
      transitionProposal: jest.fn(async () => confirmedProposal([])),
    } as unknown as AsstProposalStore;
    const r = new AsstEffectRunner(prisma as never, registry, { create: jest.fn(() => ({})) } as never, store);
    await r.run({ identity: long, proposal: confirmedProposal([imputation()]), actions: [imputation()], now: NOW });
    const audit = state.committed.find((e) => e.op === 'audit') as Extract<JournalEntry, { op: 'audit' }>;
    expect(String(audit.data.actorFullName)).toHaveLength(200);
  });

  it('effet sans outil : l’outil de l’action est retenu ; le résumé est une copie', async () => {
    const { run, appliers, transitions } = setup();
    const summary = { mailId: 30 };
    appliers.imputation.apply.mockImplementationOnce(async () => ({ effects: [{ tool: undefined as unknown as string, summary }] }));
    await run([imputation(30)]);
    const effect = transitions[0].result?.effects[0];
    expect(effect).toEqual({ tool: 'proposer_imputation_courrier', summary: { mailId: 30 } });
    expect(effect?.summary).not.toBe(summary);
  });

  it('refuse un outil hors liste blanche AVANT toute transaction', async () => {
    const { run, prisma, appliers } = setup();
    const out = await run([imputation(), { tool: 'proposer_delegation', args: {} } as unknown as AsstProposedAction]);
    expect(out).toEqual({ ok: false, failure: expect.objectContaining({ kind: 'failed', errorCode: 'tool_not_allowed' }) });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(appliers.imputation.apply).not.toHaveBeenCalled();
  });

  it('refuse un outil sans applicateur (registre seul) AVANT toute transaction', async () => {
    const { run, prisma, appliers } = setup({ skip: [AsstActionTool.Relance] });
    const out = await run([imputation(), relance()]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toMatchObject({ kind: 'failed', errorCode: 'no_applier' });
    expect(out.failure.message).toContain('proposer_relance');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(appliers.imputation.parse).not.toHaveBeenCalled();
    expect(appliers.imputation.apply).not.toHaveBeenCalled();
  });

  it('relit TOUS les arguments avant la première application : arguments invalides => invalid_arguments, rien appliqué', async () => {
    const { run, prisma, appliers } = setup();
    appliers.relance.parse.mockImplementationOnce(() => {
      throw new Error('zod');
    });
    const out = await run([brouillon(), relance()]);
    expect(out).toEqual({ ok: false, failure: expect.objectContaining({ kind: 'failed', errorCode: 'invalid_arguments' }) });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(appliers.brouillon.apply).not.toHaveBeenCalled();
  });

  it('un refus explicable de parse est conservé tel quel', async () => {
    const { run, appliers } = setup();
    appliers.relance.parse.mockImplementationOnce(() => {
      throw new EffectRefusedError('Arguments refusés.', 'custom_refusal');
    });
    const out = await run([relance()]);
    expect(out).toEqual({ ok: false, failure: { kind: 'failed', errorCode: 'custom_refusal', message: 'Arguments refusés.' } });
  });

  it.each([
    'menu_denied',
    'mail_not_readable',
    'recipient_not_imputable',
    'space_denied',
    'relance_not_allowed',
    'account_inactive',
  ])('refus de droits « %s » => forbidden, transaction annulée', async (code) => {
    const { run, appliers, state } = setup();
    appliers.relance.apply.mockRejectedValueOnce(new EffectRefusedError('Refus de droits.', code));
    const out = await run([imputation(), relance()]);
    expect(out).toEqual({ ok: false, failure: { kind: 'forbidden', errorCode: code, message: 'Refus de droits.' } });
    expect(state.rolledBack).toBe(1);
    expect(state.committed).toEqual([]);
  });

  it('autre refus métier => failed avec son code et son message', async () => {
    const { run, appliers } = setup();
    appliers.relance.apply.mockRejectedValueOnce(new EffectRefusedError('Relance refusée : imputation pas en retard.', 'not_late'));
    const out = await run([relance()]);
    expect(out).toEqual({
      ok: false,
      failure: { kind: 'failed', errorCode: 'not_late', message: 'Relance refusée : imputation pas en retard.' },
    });
  });

  it('code de refus non conforme => effect_failed (contrainte de la colonne)', async () => {
    const { run, appliers } = setup();
    appliers.relance.apply.mockRejectedValueOnce(new EffectRefusedError('Refus.', 'Code-Invalide'));
    const out = await run([relance()]);
    expect(out).toEqual({ ok: false, failure: { kind: 'failed', errorCode: 'effect_failed', message: 'Refus.' } });
  });

  it('erreur technique : message générique, jamais le message technique ; journal sans détail', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { run, appliers } = setup();
    appliers.imputation.apply.mockRejectedValueOnce(new TypeError('SELECT secret FROM mail WHERE corps = "confidentiel"'));
    const out = await run([imputation()]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.errorCode).toBe('effect_failed');
    expect(out.failure.message).toBe("L'action n'a pas pu être appliquée (erreur technique) : rien n'a été enregistré.");
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0][0])).toContain('TypeError');
    expect(String(errorLog.mock.calls[0][0])).not.toContain('confidentiel');
  });

  it('compensations en ordre inverse, une seule fois chacune ; une compensation qui lève n’empêche pas les autres', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { run, appliers } = setup();
    const order: string[] = [];
    const c1 = jest.fn(async () => void order.push('brouillon'));
    const c2 = jest.fn(async () => {
      order.push('relance');
      throw new Error('compensation cassée');
    });
    appliers.brouillon.apply.mockImplementationOnce(async () => ({ effects: [], compensate: c1 }));
    appliers.relance.apply.mockImplementationOnce(async () => ({ effects: [], compensate: c2 }));
    appliers.imputation.apply.mockRejectedValueOnce(new EffectRefusedError('Doublon.', 'duplicate_recipient'));
    const out = await run([brouillon(), relance(), imputation()]);
    expect(out.ok).toBe(false);
    expect(order).toEqual(['relance', 'brouillon']);
    expect(c1).toHaveBeenCalledTimes(1);
    expect(c2).toHaveBeenCalledTimes(1);
  });

  it('transition finale perdue (CAS) : transaction annulée, compensation, échec explicable', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { run, appliers, state } = setup({ transitionNull: true });
    const c = jest.fn(async () => undefined);
    appliers.brouillon.apply.mockImplementationOnce(async () => ({ effects: [], compensate: c }));
    const out = await run([brouillon()]);
    expect(out).toEqual({ ok: false, failure: expect.objectContaining({ kind: 'failed', errorCode: 'proposal_state_changed' }) });
    expect(state.rolledBack).toBe(1);
    expect(state.committed).toEqual([]);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('échec à la validation de la transaction : compensations appelées une fois, échec technique', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { run, appliers, state, store } = setup({ failCommit: true });
    (store as unknown as { getProposal: jest.Mock }).getProposal = jest.fn(async () => confirmedProposal([]));
    const c = jest.fn(async () => undefined);
    appliers.brouillon.apply.mockImplementationOnce(async () => ({ effects: [], compensate: c }));
    const out = await run([brouillon()]);
    expect(out).toEqual({ ok: false, failure: expect.objectContaining({ errorCode: 'effect_failed' }) });
    expect(state.rolledBack).toBe(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('issue ambiguë (COMMIT validé puis erreur côté client) : proposition déjà Appliquée => succès, AUCUNE compensation', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { run, appliers, store } = setup({ failCommit: true });
    const applied = { ...confirmedProposal([]), status: AsstProposalStatus.Applied, rowVersion: 2 };
    (store as unknown as { getProposal: jest.Mock }).getProposal = jest.fn(async () => applied);
    const c = jest.fn(async () => undefined);
    appliers.brouillon.apply.mockImplementationOnce(async () => ({ effects: [], compensate: c }));
    const out = await run([brouillon()]);
    expect(out).toEqual({ ok: true, proposal: applied });
    expect(c).not.toHaveBeenCalled();
  });

  it('issue ambiguë et relecture en échec (plusieurs essais) : AUCUNE compensation, résultat incertain', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { run, appliers, store } = setup({ failCommit: true });
    const getProposal = jest.fn(async () => {
      throw new Error('base injoignable');
    });
    (store as unknown as { getProposal: jest.Mock }).getProposal = getProposal;
    const c = jest.fn(async () => undefined);
    appliers.brouillon.apply.mockImplementationOnce(async () => ({ effects: [], compensate: c }));
    const out = await run([brouillon()]);
    expect(out).toEqual({ ok: false, failure: { kind: 'uncertain', errorCode: 'result_uncertain', message: expect.stringContaining('Résultat incertain') } });
    expect(getProposal).toHaveBeenCalledTimes(3);
    expect(c).not.toHaveBeenCalled();
  });

  it('issue ambiguë : la relecture réussit au 2e essai sur « Appliquée » => succès sans compensation', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { run, appliers, store } = setup({ failCommit: true });
    const applied = { ...confirmedProposal([]), status: AsstProposalStatus.Applied, rowVersion: 2 };
    const getProposal = jest.fn().mockRejectedValueOnce(new Error('coupure')).mockResolvedValue(applied);
    (store as unknown as { getProposal: jest.Mock }).getProposal = getProposal;
    const c = jest.fn(async () => undefined);
    appliers.brouillon.apply.mockImplementationOnce(async () => ({ effects: [], compensate: c }));
    expect(await run([brouillon()])).toEqual({ ok: true, proposal: applied });
    expect(c).not.toHaveBeenCalled();
  });

  it('échec AVANT la fin du callback : annulation certaine, compensation sans relecture', async () => {
    const { run, appliers, store } = setup();
    const getProposal = jest.fn();
    (store as unknown as { getProposal: jest.Mock }).getProposal = getProposal;
    const c = jest.fn(async () => undefined);
    appliers.brouillon.apply.mockImplementationOnce(async () => ({ effects: [], compensate: c }));
    appliers.imputation.apply.mockRejectedValueOnce(new EffectRefusedError('refus', 'duplicate_recipient'));
    const out = await run([brouillon(), imputation()]);
    expect(out.ok).toBe(false);
    expect(c).toHaveBeenCalledTimes(1);
    expect(getProposal).not.toHaveBeenCalled();
  });

  it('échec de la traçabilité : tout est annulé (atomicité avec les effets)', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { run, state, transitions } = setup({ failAudit: true });
    const out = await run([imputation()]);
    expect(out.ok).toBe(false);
    expect(state.rolledBack).toBe(1);
    expect(transitions).toHaveLength(0);
  });
});
