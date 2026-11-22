import { PrismaClient } from '@prisma/client';
import type { WfGraph } from '@archivage/types';
import { MailsService } from '../../courriers/mails.service';
import { DocumentsService } from '../../documents/documents.service';
import { AgentIdentityService } from '../../workflow-agents/identity/agent-identity.service';
import { AgentDataAdapter } from '../../workflow-agents/tools/agent-data.adapter';
import { WfEffectApplierHolder } from '../../workflows/engine/effect-applier';
import { WorkflowEngine } from '../../workflows/engine/engine';
import type { WfDirectory, WfExecutorOutcome, WfPrincipal } from '../../workflows/engine/engine.types';
import { WfExecutorRegistry } from '../../workflows/engine/executor-registry';
import { PrincipalService } from '../../workflows/principal.service';
import { EffectRefusedError, type ActionApplier } from '../catalog.contracts';
import { ActionApplierRegistry } from './action-applier.registry';
import { ApplierRightsService } from './applier-rights';
import { EffectDispatcher } from './effect-dispatcher';
import { ImputableActorsService } from './imputable-actors.service';
import { ImputationBaseApplier, ImputationCourrierApplier } from './imputation.applier';

// Test d'intégration PostgreSQL de l'applicateur d'effets (lot W6) : vrai moteur, vrai répartiteur, vrais
// applicateurs d'imputation, vraie identité (lanceur relu en base), vrais droits (menus, lecture du courrier) ;
// seul l'exécuteur d'agent est factice (il PROPOSE une imputation). Ne s'exécute que si WF_TEST_DATABASE_URL est
// définie (JAMAIS la base de développement : refus si elle est égale à DATABASE_URL). Données de test préfixées
// « wf6t » ; rien n'est supprimé (journal en ajout seul). À lancer en série (`-i`).

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'Applicateur d’effets — intégration PostgreSQL'
  : 'Applicateur d’effets — intégration PostgreSQL (IGNORÉ : définir WF_TEST_DATABASE_URL)';

const TAG = `wf6t-${Date.now()}`;

suite(title, () => {
  jest.setTimeout(120_000);

  let prisma: PrismaClient;
  let engine: WorkflowEngine;
  let executors: WfExecutorRegistry;
  let seq = 0;
  let next: () => WfExecutorOutcome = () => ({ kind: 'wait' });
  const ids: Record<'V' | 'L' | 'R' | 'N' | 'V2' | 'L2', { userId: number; userGroupId: number }> = {} as never;
  const principal = (who: keyof typeof ids): WfPrincipal => ({ userGroupId: ids[who].userGroupId, userId: ids[who].userId, groupIds: [], roleId: null });

  const compensate = jest.fn(async () => undefined);
  const directory: WfDirectory = { isUserGroupActive: () => Promise.resolve(true) };

  // Applicateurs FACTICES (clés propres au test) : écrit puis lève ; provoque un conflit de version après application.
  const writesThenThrows: ActionApplier = {
    toolKey: 'wf6t_ecrit_puis_leve',
    sideEffect: 1,
    parse: (a) => a,
    apply: async (ctx) => {
      await ctx.tx.notification.create({ data: { recipientUserGroupId: ids.R.userGroupId, message: `${TAG} ne doit pas rester`, targetType: 'wf6t' } });
      throw new EffectRefusedError('Refus factice après écriture.', 'wf6t_refus');
    },
  };
  const bumpsVersion: ActionApplier = {
    toolKey: 'wf6t_conflit_version',
    sideEffect: 1,
    parse: (a) => a,
    apply: async (ctx) => {
      // Simule une modification concurrente de l'instance : la mise à jour finale (row_version) échouera.
      await ctx.tx.wfInstance.update({ where: { wfInstanceId: BigInt(ctx.instanceId) }, data: { rowVersion: { increment: 1 } } });
      return { effects: [{ tool: 'wf6t_conflit_version', summary: {} }], compensate };
    },
  };

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();

    // Référentiel des types d'imputation (valeurs figées du seed), créé seulement s'il manque.
    await prisma.mailInputationType.createMany({
      data: [
        { mailInputationTypeId: 5, label: 'Validation DG', suivi: false },
        { mailInputationTypeId: 10, label: 'Pour Suivi', suivi: true },
        { mailInputationTypeId: 14, label: 'Validation Direction', suivi: false },
        { mailInputationTypeId: 17, label: 'En copie', suivi: true },
      ],
      skipDuplicates: true,
    });

    const group = await prisma.appGroup.create({ data: { name: `${TAG} groupe` } });
    const role = async (name: string, menus: string[]) =>
      prisma.role.create({ data: { name: `${TAG} ${name}`, menus: { create: menus.map((menuKey) => ({ menuKey })) } } });
    const rValid = await role('valideur', ['/courriers/parapheur', '/courriers/suivi']);
    const rLaunch = await role('lanceur', ['/workflows/lancer', '/courriers/controle', '/courriers/suivi']);
    const rRecip = await role('destinataire', ['/courriers/suivi-dc']);
    const rNone = await role('sans-courrier', ['/ged/recherche']);
    const rSuivi = await role('suivi-seul', ['/courriers/suivi']);
    const user = async (key: keyof typeof ids, roleId: number) => {
      const u = await prisma.appUser.create({
        data: { username: `${TAG}-${key}`, firstName: 'Test', lastName: `${TAG} ${key}`, roleId },
      });
      const ug = await prisma.appUserGroup.create({ data: { userId: u.userId, groupId: group.groupId } });
      ids[key] = { userId: u.userId, userGroupId: ug.userGroupId };
    };
    await user('V', rValid.roleId);
    await user('L', rLaunch.roleId);
    await user('R', rRecip.roleId);
    await user('N', rNone.roleId);
    await user('V2', rSuivi.roleId);
    await user('L2', rLaunch.roleId);

    const applierRegistry = new ActionApplierRegistry();
    const actors = new ImputableActorsService(prisma as never);
    applierRegistry.register(new ImputationCourrierApplier(actors));
    applierRegistry.register(new ImputationBaseApplier(actors));
    applierRegistry.register(writesThenThrows);
    applierRegistry.register(bumpsVersion);
    const identity = new AgentIdentityService(prisma as never, new PrincipalService(prisma as never));
    const mails = new MailsService(prisma as never, {} as never, {} as never);
    const adapter = new AgentDataAdapter(prisma as never, {} as never, {} as never, mails, new DocumentsService(prisma as never, {} as never, {} as never));
    const holder = new WfEffectApplierHolder();
    holder.set(new EffectDispatcher(applierRegistry, identity, new ApplierRightsService(adapter)));

    executors = new WfExecutorRegistry();
    executors.register({ taskType: 'agent', execute: () => Promise.resolve(next()) });
    engine = new WorkflowEngine(prisma, { registry: executors, directory, effects: holder });
  });

  afterAll(async () => {
    await engine?.whenIdle();
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    compensate.mockClear();
  });

  async function newMail(): Promise<number> {
    seq += 1;
    const m = await prisma.mail.create({
      data: { title: `${TAG} courrier ${seq}`, date: new Date('2026-11-20'), mailType: 0, status: 0, destinataireExpediteur: ids.V.userGroupId },
    });
    return m.mailId;
  }

  async function publish(assignee: number): Promise<number> {
    seq += 1;
    const graph = {
      schemaVersion: 1,
      start: 'aiguiller',
      steps: [
        {
          key: 'aiguiller',
          name: 'Aiguiller le courrier',
          type: 'agent',
          assignee: { kind: 'user', id: assignee },
          agent: { objective: 'Imputer le courrier', tools: ['proposer_imputation_courrier'], confidenceThreshold: 0.8, autonomy: 'agit_avec_validation' },
          next: [{ to: 'fin' }],
        },
        { key: 'fin', name: 'Fin', type: 'checklist', assignee: { kind: 'user', id: assignee }, config: { items: [{ key: 'ok' }] }, next: [] },
      ],
    } as unknown as WfGraph;
    const def = await prisma.wfDefinition.create({ data: { name: `${TAG}-wf-${seq}`, status: 1 } });
    await prisma.wfDefinitionVersion.create({
      data: { definitionId: def.wfDefinitionId, versionNumber: 1, status: 1, graph: graph as object, publishedAt: new Date(), publishedBy: 1 },
    });
    return def.wfDefinitionId;
  }

  const imputation = (mailId: number, userGroupId: number) => ({
    tool: 'proposer_imputation_courrier',
    arguments: { mailId, recipients: [{ userGroupId, mailInputationTypeId: 10, instructions: 'Pour traitement' }], rationale: 'Compétence RH' },
    sideEffect: 1,
    requiresValidation: true,
    preview: `Imputer le courrier ${mailId}`,
  });
  const proposeWith = (actions: unknown[]): WfExecutorOutcome => ({
    kind: 'propose',
    proposal: { mode: 'action', result: { service: 'RH' }, preparedActions: actions, suspicion_injection: false, autonomy: 1, reason: 'validation_required' },
    explanation: 'Imputer au service RH.',
    confidence: 0.9,
  });

  /** Lance une instance (agent qui propose `actions`) et renvoie l'élément kind 1 ouvert. */
  async function startWith(actions: unknown[], opts: { assignee?: keyof typeof ids; launcher?: keyof typeof ids } = {}) {
    next = () => proposeWith(actions);
    const definitionId = await publish(ids[opts.assignee ?? 'V'].userGroupId);
    const res = await engine.startInstance({ definitionId, startedBy: ids[opts.launcher ?? 'L'].userGroupId, subjectType: 'mail', subjectId: '1' });
    await engine.whenIdle();
    const instanceId = res.instance.wfInstanceId;
    const item = await prisma.wfInboxItem.findFirstOrThrow({ where: { instanceId: BigInt(instanceId), kind: 1, status: 0 } });
    return { instanceId, item };
  }

  const events = (id: string) => prisma.wfEventLog.findMany({ where: { instanceId: BigInt(id) }, orderBy: { wfEventLogId: 'asc' } });
  const imputationsOf = (mailId: number) => prisma.mailInputation.findMany({ where: { mailId } });

  async function expectUntouched(instanceId: string, itemId: bigint, before: number, mailId?: number) {
    const item = await prisma.wfInboxItem.findUniqueOrThrow({ where: { wfInboxItemId: itemId } });
    expect(item.status).toBe(0);
    const task = await prisma.wfTask.findUniqueOrThrow({ where: { wfTaskId: item.taskId } });
    expect(task.status).toBeLessThanOrEqual(1);
    expect(task.completedAt).toBeNull();
    expect(await events(instanceId)).toHaveLength(before);
    if (mailId !== undefined) expect(await imputationsOf(mailId)).toHaveLength(0);
  }

  it('agit avec validation : validation => imputation écrite, notification in-app, agent.acted + validation.accepted + task.completed', async () => {
    const mailId = await newMail();
    const { instanceId, item } = await startWith([imputation(mailId, ids.R.userGroupId)]);
    await engine.completeTask({ taskId: item.taskId.toString(), principal: principal('V'), result: item.proposal as Record<string, unknown> });

    const rows = await imputationsOf(mailId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: ids.R.userGroupId, mailInputationTypeId: 10, createdBy: ids.V.userGroupId, dateTreated: null, deadline: null, instructions: 'Pour traitement' });
    const notes = await prisma.notification.findMany({ where: { recipientUserGroupId: ids.R.userGroupId, targetType: 'mail', targetId: mailId } });
    expect(notes).toHaveLength(1);
    const mail = await prisma.mail.findUniqueOrThrow({ where: { mailId } });
    expect(notes[0].message).toBe(`Courrier imputé : ${mail.title}`);

    const ev = await events(instanceId);
    const type = ev.map((e) => e.eventType);
    const acted = ev.find((e) => e.eventType === 'agent.acted')!;
    const completed = ev.find((e) => e.eventType === 'task.completed' && e.stepKey === 'aiguiller')!;
    const accepted = ev.find((e) => e.eventType === 'validation.accepted')!;
    expect(acted).toMatchObject({ actorKind: 2, validatedBy: ids.V.userGroupId, stepKey: 'aiguiller' });
    expect(acted.decision).toMatchObject({
      kind: 'effects_applied',
      validatedBy: ids.V.userGroupId,
      effects: [{ tool: 'proposer_imputation_courrier', summary: { status: 'applied', mailId, recipients: 1, created: [rows[0].mailInputationId] } }],
    });
    expect(JSON.stringify(acted.decision)).not.toContain('Pour traitement');
    expect(type.indexOf('agent.acted')).toBeLessThan(type.indexOf('task.completed'));
    // Même transaction : même horodatage de transition pour l'acte, la clôture et la validation.
    expect(acted.occurredAt.getTime()).toBe(completed.occurredAt.getTime());
    expect(accepted.occurredAt.getTime()).toBe(completed.occurredAt.getTime());
    expect(accepted.validatedBy).toBe(ids.V.userGroupId);

    // Plafond de relances : le format `decision.kind / effects[].tool` est lisible en SQL.
    const n = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM wf_event_log e CROSS JOIN LATERAL jsonb_array_elements(e.decision -> 'effects') x
       WHERE e.instance_id = ${BigInt(instanceId)} AND e.decision ->> 'kind' = 'effects_applied' AND x ->> 'tool' = 'proposer_imputation_courrier'`;
    expect(Number(n[0].n)).toBe(1);
  });

  it('destinataire non imputable : refus expliqué, ROLLBACK complet (tâche, élément, journal, imputation)', async () => {
    const mailId = await newMail();
    const { instanceId, item } = await startWith([imputation(mailId, ids.N.userGroupId)]);
    const before = (await events(instanceId)).length;
    await expect(
      engine.completeTask({ taskId: item.taskId.toString(), principal: principal('V'), result: item.proposal as Record<string, unknown> }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining(`n°${ids.N.userGroupId}`),
      details: { code: 'recipient_not_imputable', tool: 'proposer_imputation_courrier' },
    });
    await expectUntouched(instanceId, item.wfInboxItemId, before, mailId);
  });

  it('applicateur qui lève APRÈS avoir écrit : tout est annulé (imputation et notification comprises)', async () => {
    const mailId = await newMail();
    const { instanceId, item } = await startWith([imputation(mailId, ids.R.userGroupId), { tool: 'wf6t_ecrit_puis_leve', arguments: {}, sideEffect: 1, requiresValidation: true, preview: 'x' }]);
    const before = (await events(instanceId)).length;
    await expect(
      engine.completeTask({ taskId: item.taskId.toString(), principal: principal('V'), result: item.proposal as Record<string, unknown> }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { code: 'wf6t_refus', tool: 'wf6t_ecrit_puis_leve' } });
    await expectUntouched(instanceId, item.wfInboxItemId, before, mailId);
    expect(await prisma.notification.count({ where: { message: `${TAG} ne doit pas rester` } })).toBe(0);
    expect(await prisma.notification.count({ where: { targetType: 'mail', targetId: mailId } })).toBe(0);
  });

  it('transaction en échec APRÈS l’application (conflit de version) : compensation appelée, rien enregistré', async () => {
    const mailId = await newMail();
    const { instanceId, item } = await startWith([
      imputation(mailId, ids.R.userGroupId),
      { tool: 'wf6t_conflit_version', arguments: {}, sideEffect: 1, requiresValidation: true, preview: 'x' },
    ]);
    const before = (await events(instanceId)).length;
    const rowVersion = (await prisma.wfInstance.findUniqueOrThrow({ where: { wfInstanceId: BigInt(instanceId) } })).rowVersion;
    await expect(
      engine.completeTask({ taskId: item.taskId.toString(), principal: principal('V'), result: item.proposal as Record<string, unknown> }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await engine.whenIdle();
    expect(compensate).toHaveBeenCalledTimes(1);
    await expectUntouched(instanceId, item.wfInboxItemId, before, mailId);
    expect((await prisma.wfInstance.findUniqueOrThrow({ where: { wfInstanceId: BigInt(instanceId) } })).rowVersion).toBe(rowVersion);
  });

  it('valideur sans menu d’imputation : refus, rien enregistré', async () => {
    const mailId = await newMail();
    const { instanceId, item } = await startWith([imputation(mailId, ids.R.userGroupId)], { assignee: 'V2' });
    const before = (await events(instanceId)).length;
    await expect(
      engine.completeTask({ taskId: item.taskId.toString(), principal: principal('V2'), result: item.proposal as Record<string, unknown> }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('valideur'), details: { code: 'menu_denied' } });
    await expectUntouched(instanceId, item.wfInboxItemId, before, mailId);
  });

  it('lanceur désactivé depuis le lancement : refus, rien enregistré', async () => {
    const mailId = await newMail();
    const { instanceId, item } = await startWith([imputation(mailId, ids.R.userGroupId)], { launcher: 'L2' });
    await prisma.appUser.update({ where: { userId: ids.L2.userId }, data: { isDisabled: true } });
    const before = (await events(instanceId)).length;
    await expect(
      engine.completeTask({ taskId: item.taskId.toString(), principal: principal('V'), result: item.proposal as Record<string, unknown> }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { code: 'launcher_disabled' } });
    await expectUntouched(instanceId, item.wfInboxItemId, before, mailId);
  });

  it('outil sans applicateur dans un lot mixte : refus `no_applier`, ROLLBACK complet (aucune imputation)', async () => {
    const mailId = await newMail();
    const { instanceId, item } = await startWith([
      imputation(mailId, ids.R.userGroupId),
      { tool: 'wf6t_sans_applicateur', arguments: { a: 1 }, sideEffect: 1, requiresValidation: true, preview: 'x' },
    ]);
    const before = (await events(instanceId)).length;
    await expect(
      engine.completeTask({ taskId: item.taskId.toString(), principal: principal('V'), result: item.proposal as Record<string, unknown> }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('wf6t_sans_applicateur'),
      details: { code: 'no_applier', tool: 'wf6t_sans_applicateur' },
    });
    await expectUntouched(instanceId, item.wfInboxItemId, before, mailId);
    expect(await prisma.notification.count({ where: { targetType: 'mail', targetId: mailId } })).toBe(0);
  });

  it('aucun applicateur branché sur le moteur : refus `no_applier` ; niveau 0 et proposition sans action inchangés', async () => {
    const bare = new WorkflowEngine(prisma, { registry: executors, directory });
    const run = async (outcome: WfExecutorOutcome) => {
      next = () => outcome;
      const definitionId = await publish(ids.V.userGroupId);
      const res = await bare.startInstance({ definitionId, startedBy: ids.L.userGroupId, subjectType: 'mail', subjectId: '1' });
      await bare.whenIdle();
      const id = res.instance.wfInstanceId;
      const item = await prisma.wfInboxItem.findFirstOrThrow({ where: { instanceId: BigInt(id), kind: 1, status: 0 } });
      return { id, item };
    };
    const mailId = await newMail();
    const withActions = await run(proposeWith([imputation(mailId, ids.R.userGroupId)]));
    const before = (await events(withActions.id)).length;
    await expect(
      bare.completeTask({ taskId: withActions.item.taskId.toString(), principal: principal('V'), result: withActions.item.proposal as Record<string, unknown> }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { code: 'no_applier', tool: 'proposer_imputation_courrier' } });
    await expectUntouched(withActions.id, withActions.item.wfInboxItemId, before, mailId);

    const suggestion = await run({
      kind: 'propose',
      proposal: { mode: 'suggestion', result: {}, suggestedActions: [imputation(mailId, ids.R.userGroupId)], suspicion_injection: false, autonomy: 0 },
      explanation: 'Suggestion.',
      confidence: 0.9,
    });
    await bare.completeTask({ taskId: suggestion.item.taskId.toString(), principal: principal('V'), result: suggestion.item.proposal as Record<string, unknown> });
    const noAction = await run(proposeWith([]));
    await bare.completeTask({ taskId: noAction.item.taskId.toString(), principal: principal('V'), result: noAction.item.proposal as Record<string, unknown> });
    for (const id of [suggestion.id, noAction.id]) {
      const type = (await events(id)).map((e) => e.eventType);
      expect(type).toContain('validation.accepted');
      expect(type).not.toContain('agent.acted');
    }
    expect(await imputationsOf(mailId)).toHaveLength(0);
    await bare.whenIdle();
  });

  it('outil de base proposer_imputation : cible « user » imputée (type rapproché par libellé)', async () => {
    const mailId = await newMail();
    const { item } = await startWith([
      {
        tool: 'proposer_imputation',
        arguments: { mailId, target: { kind: 'user', id: ids.R.userGroupId }, imputationType: 'validation dg', rationale: 'r' },
        sideEffect: 1,
        requiresValidation: true,
        preview: 'x',
      },
    ]);
    await engine.completeTask({ taskId: item.taskId.toString(), principal: principal('V'), result: item.proposal as Record<string, unknown> });
    const rows = await imputationsOf(mailId);
    expect(rows).toHaveLength(1);
    expect(rows[0].mailInputationTypeId).toBe(5);
    expect(rows[0].deadline).not.toBeNull(); // validation DG : +2 jours par défaut
  });
});
