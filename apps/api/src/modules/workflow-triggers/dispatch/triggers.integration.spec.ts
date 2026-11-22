import { PrismaClient } from '@prisma/client';
import { validateWorkflowGraph } from '@archivage/types';
import type { AuditService } from '../../audit/audit.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { WorkflowEngine } from '../../workflows/engine/engine';
import { SubjectAccessRegistry } from '../../workflows/extension/subject-access';
import { WorkflowTriggerStarterService } from '../../workflows/extension/trigger-starter';
import { WorkflowEventsPublisher } from '../../workflows/extension/workflow-events';
import { PrincipalService } from '../../workflows/principal.service';
import { WorkflowEventBus } from '../bus/workflow-event-bus';
import type { WfDomainEvent } from '../domain/contracts';
import { mailArrivedEvent } from '../domain/events';
import { WfBudgetEmergencyStopGate } from './emergency-stop';
import { TriggerFailureTracker } from './trigger-failure-tracker';
import { WorkflowTriggerDispatcher } from './triggers.dispatcher';

// Intégration du répartiteur de déclencheurs sur une VRAIE base PostgreSQL JETABLE : vrai moteur, vrai
// PrincipalService, vrai démarreur de déclencheurs. Ne s'exécute que si WF_TEST_DATABASE_URL est définie (base
// migrée jusqu'à 20261121120000_add_workflow_foundations) ; refuse la base de développement (DATABASE_URL).
// Chaque test crée ses propres définitions, déclencheurs, utilisateurs et courriers factices ; en fin de suite, les
// déclencheurs créés sont supprimés (les instances gardent trigger_id NULL). Jamais de DELETE sur wf_event_log
// (journal en ajout seul) ; si la suppression est impossible, les déclencheurs sont désactivés.

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'Déclencheurs workflow — intégration PostgreSQL'
  : 'Déclencheurs workflow — intégration PostgreSQL (IGNORÉ : définir WF_TEST_DATABASE_URL vers une base jetable)';

/** Base d'identifiants propre à cette exécution : la base jetable peut contenir les données d'exécutions précédentes. */
const RUN = (Math.floor(Date.now() / 1000) % 1_000_000) * 1000;

suite(title, () => {
  let prisma: PrismaClient;
  let engine: WorkflowEngine;
  let principals: PrincipalService;
  let events: WorkflowEventsPublisher;
  let groupId: number;
  let activeAdmin: number; // user_group_id d'un administrateur actif
  let disabledAdmin: number; // user_group_id d'un administrateur désactivé
  let seq = 0;
  /** Dernier déclencheur créé : les événements de test le visent (comme le balayage du worker) pour ne pas évaluer
   * les déclencheurs `mail.arrived` laissés actifs par d'autres tests ou d'autres exécutions dans la base jetable. */
  let currentTrigger = 0;
  /** Déclencheurs créés par cette suite, à nettoyer en fin d'exécution. */
  const createdTriggers: number[] = [];
  /** Courriers « accessibles » du contrôleur factice ; tout autre identifiant est refusé. */
  const deniedMails = new Set<string>();

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    principals = new PrincipalService(prisma as unknown as PrismaService);
    events = new WorkflowEventsPublisher();
    engine = new WorkflowEngine(prisma, { directory: principals });

    const group = await prisma.appGroup.create({ data: { name: `wf-trg-${RUN}` } });
    groupId = group.groupId;
    activeAdmin = await createUserGroup(`wf-trg-admin-${RUN}`, false);
    disabledAdmin = await createUserGroup(`wf-trg-off-${RUN}`, true);
  });

  afterAll(async () => {
    await engine?.whenIdle();
    if (prisma && createdTriggers.length > 0) {
      try {
        await prisma.wfTrigger.deleteMany({ where: { wfTriggerId: { in: createdTriggers } } });
      } catch {
        await prisma.wfTrigger.updateMany({ where: { wfTriggerId: { in: createdTriggers } }, data: { isActive: false } });
      }
    }
    await prisma?.$disconnect();
  });

  async function createUserGroup(username: string, isDisabled: boolean): Promise<number> {
    const user = await prisma.appUser.create({
      data: { username, firstName: 'Test', lastName: 'Declencheur', isAdmin: true, isDisabled },
    });
    const ug = await prisma.appUserGroup.create({ data: { userId: user.userId, groupId } });
    return ug.userGroupId;
  }

  async function publish(): Promise<number> {
    const graph = {
      schemaVersion: 1,
      start: 'saisie',
      steps: [
        {
          key: 'saisie',
          name: 'Saisie',
          type: 'formulaire',
          assignee: { kind: 'user', id: activeAdmin },
          config: { fields: [{ key: 'note' }] },
          next: [],
        },
      ],
    };
    expect(validateWorkflowGraph(graph).issues).toEqual([]);
    seq += 1;
    const def = await prisma.wfDefinition.create({ data: { name: `wf-trg-${Date.now()}-${seq}`, status: 1 } });
    await prisma.wfDefinitionVersion.create({
      data: {
        definitionId: def.wfDefinitionId,
        versionNumber: 1,
        status: 1,
        graph,
        publishedAt: new Date(),
        publishedBy: 1,
      },
    });
    return def.wfDefinitionId;
  }

  async function createTrigger(definitionId: number, runAs: number, conditions: object = {}): Promise<number> {
    seq += 1;
    const t = await prisma.wfTrigger.create({
      data: {
        definitionId,
        name: `trg-${RUN}-${seq}`,
        eventType: 'mail.arrived',
        conditions,
        runAsUserGroupId: runAs,
        isActive: true,
      },
    });
    currentTrigger = t.wfTriggerId;
    createdTriggers.push(t.wfTriggerId);
    return t.wfTriggerId;
  }

  /** Répartiteur de test câblé comme en production, avec le VRAI moteur et le VRAI démarreur. */
  /** Appelé pendant le traitement d'un événement (entre la lecture du déclencheur et `lastFiredAt`). */
  let beforeAccessHook: (() => Promise<void>) | null = null;

  function makeDispatcher() {
    const subjects = new SubjectAccessRegistry();
    subjects.register({
      subjectType: 'mail',
      canAccess: async (_actor, subjectId) => {
        await beforeAccessHook?.();
        return !deniedMails.has(subjectId);
      },
    });
    const starter = new WorkflowTriggerStarterService(engine, principals, subjects, events);
    const audits: Array<Record<string, unknown>> = [];
    const audit = {
      dataChange: (entry: Record<string, unknown>) => {
        audits.push(entry);
        return Promise.resolve();
      },
    } as unknown as AuditService;
    const dispatcher = new WorkflowTriggerDispatcher(
      prisma as unknown as PrismaService,
      new WorkflowEventBus(),
      principals,
      subjects,
      starter,
      new WfBudgetEmergencyStopGate(prisma as unknown as PrismaService),
      audit,
      new TriggerFailureTracker(),
    );
    return { dispatcher, audits };
  }

  const nextMail = (): number => RUN + 100_000 + (seq += 1);
  const mailEvent = (mailId: number): WfDomainEvent =>
    mailArrivedEvent(
      { mailId, mailType: 0, status: 1, mailNatureId: 3, confidentialiteId: 2 },
      { hasDocument: true, now: new Date() },
    );
  const mailEventForTrigger = (mailId: number): WfDomainEvent => ({ ...mailEvent(mailId), triggerId: currentTrigger });
  const instancesOf = (definitionId: number) => prisma.wfInstance.findMany({ where: { definitionId } });

  // -------------------------------------------------------------------------

  it('mail.arrived : instance créée avec lanceur, déclencheur, clé trg:, objet lié et contexte structuré', async () => {
    const definitionId = await publish();
    const triggerId = await createTrigger(definitionId, activeAdmin);
    const { dispatcher } = makeDispatcher();
    const mailId = nextMail();

    const out = await dispatcher.handle(mailEventForTrigger(mailId));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ triggerId, status: 'started' });

    const rows = await instancesOf(definitionId);
    expect(rows).toHaveLength(1);
    const inst = rows[0]!;
    expect(inst.startedBy).toBe(activeAdmin);
    expect(inst.triggerId).toBe(triggerId);
    expect(inst.idempotencyKey).toBe(`trg:${triggerId}:mail.arrived:mail:${mailId}`);
    expect(inst.subjectType).toBe('mail');
    expect(inst.subjectId).toBe(BigInt(mailId));
    const input = (inst.context as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      trigger: { id: triggerId, eventType: 'mail.arrived' },
      event: { type: 'mail.arrived', subjectType: 'mail', subjectId: String(mailId) },
      subject: { mailType: 0, status: 1, mailNatureId: 3, confidentialiteId: 2, hasDocument: true, hasDeadline: false },
    });
    const trigger = await prisma.wfTrigger.findUniqueOrThrow({ where: { wfTriggerId: triggerId } });
    expect(trigger.lastFiredAt).not.toBeNull();
  });

  it('même événement rejoué : toujours UNE seule instance', async () => {
    const definitionId = await publish();
    await createTrigger(definitionId, activeAdmin);
    const { dispatcher } = makeDispatcher();
    const ev = mailEventForTrigger(nextMail());
    expect((await dispatcher.handle(ev))[0]!.status).toBe('started');
    expect((await dispatcher.handle(ev))[0]!.status).toBe('duplicate');
    expect((await dispatcher.handle(ev))[0]!.status).toBe('duplicate');
    expect(await instancesOf(definitionId)).toHaveLength(1);
  });

  it('deux événements concurrents identiques : une seule instance', async () => {
    const definitionId = await publish();
    await createTrigger(definitionId, activeAdmin);
    const a = makeDispatcher().dispatcher;
    const b = makeDispatcher().dispatcher; // deux répartiteurs : pas de sérialisation en mémoire
    const ev = mailEventForTrigger(nextMail());
    const [ra, rb] = await Promise.all([a.handle(ev), b.handle(ev)]);
    const statuses = [ra[0]!.status, rb[0]!.status].sort();
    expect(statuses).toEqual(['duplicate', 'started']);
    expect(await instancesOf(definitionId)).toHaveLength(1);
  });

  it('lanceur désactivé : aucune instance', async () => {
    const definitionId = await publish();
    const triggerId = await createTrigger(definitionId, disabledAdmin);
    const { dispatcher, audits } = makeDispatcher();
    expect(await principals.canLaunch(activeAdmin)).toBe(true);
    expect(await principals.canLaunch(disabledAdmin)).toBe(false);
    const out = await dispatcher.handle(mailEventForTrigger(nextMail()));
    expect(out[0]).toMatchObject({ triggerId, status: 'launcher_inactive' });
    expect(await instancesOf(definitionId)).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ objectRef: `wf_trigger:${triggerId}`, oldValue: 'launcher_inactive' });
  });

  it('plafond (maxLaunches = 2) : le troisième événement est refusé', async () => {
    const definitionId = await publish();
    await createTrigger(definitionId, activeAdmin, { limits: { maxLaunches: 2, windowMinutes: 60 } });
    const { dispatcher } = makeDispatcher();
    expect((await dispatcher.handle(mailEventForTrigger(nextMail())))[0]!.status).toBe('started');
    expect((await dispatcher.handle(mailEventForTrigger(nextMail())))[0]!.status).toBe('started');
    expect((await dispatcher.handle(mailEventForTrigger(nextMail())))[0]!.status).toBe('cap_reached');
    expect(await instancesOf(definitionId)).toHaveLength(2);
  });

  it('objet refusé par le contrôleur : aucune instance', async () => {
    const definitionId = await publish();
    const triggerId = await createTrigger(definitionId, activeAdmin);
    const { dispatcher } = makeDispatcher();
    const mailId = nextMail();
    deniedMails.add(String(mailId));
    const out = await dispatcher.handle(mailEventForTrigger(mailId));
    expect(out[0]).toMatchObject({ triggerId, status: 'subject_denied' });
    expect(await instancesOf(definitionId)).toHaveLength(0);
    // Le déclencheur reste actif : un courrier confidentiel n'est pas une panne.
    const t = await prisma.wfTrigger.findUniqueOrThrow({ where: { wfTriggerId: triggerId } });
    expect(t.isActive).toBe(true);
  });

  it("arrêt d'urgence (wf_budget.emergency_stop) : aucune instance, puis reprise une fois levé", async () => {
    const definitionId = await publish();
    await createTrigger(definitionId, activeAdmin);
    const { dispatcher } = makeDispatcher();
    const budget = await prisma.wfBudget.create({ data: { definitionId, emergencyStop: true, emergencyStopAt: new Date() } });
    try {
      const out = await dispatcher.handle(mailEventForTrigger(nextMail()));
      expect(out[0]!.status).toBe('stopped');
      expect(await instancesOf(definitionId)).toHaveLength(0);
    } finally {
      await prisma.wfBudget.update({ where: { wfBudgetId: budget.wfBudgetId }, data: { emergencyStop: false } });
    }
    expect((await dispatcher.handle(mailEventForTrigger(nextMail())))[0]!.status).toBe('started');
    expect(await instancesOf(definitionId)).toHaveLength(1);
  });

  it('réactivation après désactivation automatique (instances_en_echec) : compteur neuf', async () => {
    const definitionId = await publish();
    const triggerId = await createTrigger(definitionId, activeAdmin);
    const version = await prisma.wfDefinitionVersion.findFirstOrThrow({ where: { definitionId } });
    await new Promise((r) => setTimeout(r, 1100)); // horodatages à la seconde : instances strictement après le déclencheur
    for (let i = 0; i < 5; i += 1) {
      await prisma.wfInstance.create({
        data: {
          definitionId,
          definitionVersionId: version.wfDefinitionVersionId,
          status: 3,
          finishedAt: new Date(),
          errorMessage: 'échec simulé',
          startedBy: activeAdmin,
          triggerId,
          idempotencyKey: `trg:${triggerId}:mail.arrived:mail:${RUN + 500_000 + i}`,
        },
      });
    }
    const { dispatcher } = makeDispatcher();
    expect((await dispatcher.handle(mailEventForTrigger(nextMail())))[0]!.status).toBe('auto_disabled');
    expect((await prisma.wfTrigger.findUniqueOrThrow({ where: { wfTriggerId: triggerId } })).isActive).toBe(false);
    // Réactivation humaine : isActive et updated_at avancent ; les anciennes instances échouées ne comptent plus.
    await new Promise((r) => setTimeout(r, 1100)); // started_at est à la seconde (timestamptz(0))
    await prisma.wfTrigger.update({ where: { wfTriggerId: triggerId }, data: { isActive: true } });
    expect((await dispatcher.handle(mailEventForTrigger(nextMail())))[0]!.status).toBe('started');
  });

  it('un lancement ne réécrit pas updated_at : une modification humaine concurrente est conservée', async () => {
    const definitionId = await publish();
    const triggerId = await createTrigger(definitionId, activeAdmin);
    await new Promise((r) => setTimeout(r, 1100)); // horodatages à la seconde
    let humanUpdatedAt: Date | null = null;
    beforeAccessHook = async () => {
      const row = await prisma.wfTrigger.update({ where: { wfTriggerId: triggerId }, data: { name: 'modifié par un humain' } });
      humanUpdatedAt = row.updatedAt;
    };
    try {
      const { dispatcher } = makeDispatcher();
      expect((await dispatcher.handle(mailEventForTrigger(nextMail())))[0]!.status).toBe('started');
    } finally {
      beforeAccessHook = null;
    }
    const after = await prisma.wfTrigger.findUniqueOrThrow({ where: { wfTriggerId: triggerId } });
    expect(humanUpdatedAt).not.toBeNull();
    expect(after.updatedAt.getTime()).toBe((humanUpdatedAt as unknown as Date).getTime());
    expect(after.name).toBe('modifié par un humain');
    expect(after.lastFiredAt).not.toBeNull();
  });
});
