import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import type { AuditService } from '../../audit/audit.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SubjectAccessRegistry } from '../../workflows/extension/subject-access';
import type { WfTriggerStartInput } from '../../workflows/extension/trigger-starter';
import type { PrincipalService } from '../../workflows/principal.service';
import { WorkflowEventBus } from '../bus/workflow-event-bus';
import { WF_TRIGGER_MAX_CONSECUTIVE_FAILURES, type WfDomainEvent } from '../domain/contracts';
import { mailArrivedEvent } from '../domain/events';
import type { WfEmergencyStopGate } from './emergency-stop';
import { TriggerFailureTracker } from './trigger-failure-tracker';
import { WorkflowTriggerDispatcher } from './triggers.dispatcher';

interface FakeTrigger {
  wfTriggerId: number;
  definitionId: number;
  eventType: string;
  conditions: unknown;
  runAsUserGroupId: number;
  isActive: boolean;
  updatedAt: Date;
  lastFiredAt: Date | null;
}
interface FakeInstance {
  wfInstanceId: string;
  definitionId: number;
  triggerId: number | null;
  idempotencyKey: string | null;
  status: number;
  startedAt: Date;
}

const T0 = Date.parse('2026-11-21T10:00:00Z');
const MIN = 60_000;

function makeHarness() {
  let now = T0;
  let seq = 100;
  const triggers: FakeTrigger[] = [];
  const instances: FakeInstance[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const starts: WfTriggerStartInput[] = [];

  const addTrigger = (over: Partial<FakeTrigger> = {}): FakeTrigger => {
    const t: FakeTrigger = {
      wfTriggerId: triggers.length + 1,
      definitionId: 50,
      eventType: 'mail.arrived',
      conditions: {},
      runAsUserGroupId: 9,
      isActive: true,
      updatedAt: new Date(T0 - 3_600_000),
      lastFiredAt: null,
      ...over,
    };
    triggers.push(t);
    return t;
  };

  const prisma = {
    wfTrigger: {
      findMany: jest.fn(({ where, take }: { where: { isActive: boolean; eventType: string; wfTriggerId?: number }; take: number }) =>
        Promise.resolve(
          triggers
            .filter(
              (t) =>
                t.isActive === where.isActive &&
                t.eventType === where.eventType &&
                (where.wfTriggerId === undefined || t.wfTriggerId === where.wfTriggerId),
            )
            .sort((a, b) => a.wfTriggerId - b.wfTriggerId)
            .slice(0, take)
            .map((t) => ({ ...t })),
        ),
      ),
      updateMany: jest.fn(({ where, data }: { where: { wfTriggerId: number; isActive: boolean }; data: { isActive: boolean } }) => {
        const hit = triggers.filter((t) => t.wfTriggerId === where.wfTriggerId && t.isActive === where.isActive);
        hit.forEach((t) => {
          t.isActive = data.isActive;
        });
        return Promise.resolve({ count: hit.length });
      }),
    },
    // touchLastFired : UPDATE direct de last_fired_at (jamais updated_at). Valeurs : date, id.
    $executeRaw: jest.fn((_strings: TemplateStringsArray, at: Date, id: number) => {
      const t = triggers.find((x) => x.wfTriggerId === id);
      if (t) t.lastFiredAt = at;
      return Promise.resolve(t ? 1 : 0);
    }),
    wfInstance: {
      findFirst: jest.fn(({ where }: { where: { definitionId: number; idempotencyKey: string } }) =>
        Promise.resolve(
          instances.find((i) => i.definitionId === where.definitionId && i.idempotencyKey === where.idempotencyKey) ?? null,
        ),
      ),
      findMany: jest.fn(({ where, take }: { where: { triggerId: number; startedAt?: { gt: Date } }; take: number }) =>
        Promise.resolve(
          instances
            .filter(
              (i) =>
                i.triggerId === where.triggerId &&
                (where.startedAt === undefined || i.startedAt.getTime() > where.startedAt.gt.getTime()),
            )
            .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
            .slice(0, take)
            .map((i) => ({ status: i.status })),
        ),
      ),
      count: jest.fn(({ where }: { where: { triggerId: number; startedAt: { gte: Date } } }) =>
        Promise.resolve(
          instances.filter((i) => i.triggerId === where.triggerId && i.startedAt.getTime() >= where.startedAt.gte.getTime()).length,
        ),
      ),
    },
  };

  const principals = { canLaunch: jest.fn((_id: number) => Promise.resolve(true)) };
  const subjects = { assertAccess: jest.fn((..._args: unknown[]) => Promise.resolve()) };
  const gate = { isStopped: jest.fn((_definitionId: number) => Promise.resolve(false)) };
  const audit = {
    dataChange: jest.fn((entry: Record<string, unknown>) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };
  const starter = {
    start: jest.fn((input: WfTriggerStartInput) => {
      starts.push(input);
      const existing = instances.find((i) => i.definitionId === input.definitionId && i.idempotencyKey === input.idempotencyKey);
      if (existing) return Promise.resolve({ created: false, instance: { wfInstanceId: existing.wfInstanceId } });
      seq += 1;
      instances.push({
        wfInstanceId: String(seq),
        definitionId: input.definitionId,
        triggerId: input.triggerId ?? null,
        idempotencyKey: input.idempotencyKey,
        status: 1,
        startedAt: new Date(now),
      });
      return Promise.resolve({ created: true, instance: { wfInstanceId: String(seq) } });
    }),
  };

  const tracker = new TriggerFailureTracker();
  const bus = new WorkflowEventBus();
  const dispatcher = new WorkflowTriggerDispatcher(
    prisma as unknown as PrismaService,
    bus,
    principals as unknown as PrincipalService,
    subjects as unknown as SubjectAccessRegistry,
    starter as never,
    gate as WfEmergencyStopGate,
    audit as unknown as AuditService,
    tracker,
    () => now,
  );

  return {
    triggers,
    instances,
    audits,
    starts,
    addTrigger,
    prisma,
    principals,
    subjects,
    gate,
    audit,
    starter,
    tracker,
    bus,
    dispatcher,
    advance: (ms: number) => {
      now += ms;
    },
    event: (over: Partial<WfDomainEvent> = {}, mailId = 42): WfDomainEvent => ({
      ...mailArrivedEvent({ mailId, mailType: 0, status: 1, mailNatureId: 3, confidentialiteId: 2 }, { now: new Date(T0), hasDocument: true }),
      ...over,
    }),
  };
}

describe('WorkflowTriggerDispatcher', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("démarre une instance avec la clé trg:… et les droits du lanceur (startedBy = run_as)", async () => {
    const h = makeHarness();
    const t = h.addTrigger({ runAsUserGroupId: 9 });
    const ev = h.event();
    const out = await h.dispatcher.handle(ev);
    expect(out).toEqual([{ triggerId: t.wfTriggerId, status: 'started', instanceId: '101' }]);
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toMatchObject({
      definitionId: 50,
      startedBy: 9,
      idempotencyKey: 'trg:1:mail.arrived:mail:42',
      triggerId: 1,
      subjectType: 'mail',
      subjectId: '42',
    });
    expect(h.principals.canLaunch).toHaveBeenCalledWith(9);
    expect(h.subjects.assertAccess).toHaveBeenCalledWith({ userGroupId: 9 }, 'mail', '42');
    expect(h.triggers[0]!.lastFiredAt).toEqual(new Date(T0));
    // updatedAt est conservé : un lancement n'est pas une modification humaine.
    expect(h.triggers[0]!.updatedAt).toEqual(new Date(T0 - 3_600_000));
  });

  it("l'occurrenceKey fait partie de la clé d'idempotence", async () => {
    const h = makeHarness();
    h.addTrigger();
    await h.dispatcher.handle(h.event({ occurrenceKey: '2026-12-01' }));
    expect(h.starts[0]!.idempotencyKey).toBe('trg:1:mail.arrived:mail:42:2026-12-01');
  });

  it('condition non satisfaite : aucun lancement, aucun journal', async () => {
    const h = makeHarness();
    h.addTrigger({ conditions: { match: [{ field: 'subject.mailNatureId', op: 'eq', value: 999 }] } });
    const out = await h.dispatcher.handle(h.event());
    expect(out[0]!.status).toBe('no_match');
    expect(h.starter.start).not.toHaveBeenCalled();
    expect(h.audit.dataChange).not.toHaveBeenCalled();
    expect(h.principals.canLaunch).not.toHaveBeenCalled();
  });

  it('condition satisfaite : lancement', async () => {
    const h = makeHarness();
    h.addTrigger({ conditions: { match: [{ field: 'subject.mailNatureId', op: 'eq', value: 3 }] } });
    expect((await h.dispatcher.handle(h.event()))[0]!.status).toBe('started');
  });

  it('conditions invalides : invalid_config, journal, échec compté, aucun lancement', async () => {
    const h = makeHarness();
    const t = h.addTrigger({ conditions: { match: [{ field: 'subject.objet', op: 'eq', value: 'x' }] } });
    const out = await h.dispatcher.handle(h.event());
    expect(out[0]!.status).toBe('invalid_config');
    expect(h.starter.start).not.toHaveBeenCalled();
    expect(h.audit.dataChange).toHaveBeenCalledTimes(1);
    expect(h.tracker.count(t.wfTriggerId)).toBe(1);
  });

  it("rejeu : 'duplicate' sans appel au starter, sans journal, sans compter pour le plafond", async () => {
    const h = makeHarness();
    h.addTrigger({ conditions: { limits: { maxLaunches: 1, windowMinutes: 60 } } });
    const ev = h.event();
    expect((await h.dispatcher.handle(ev))[0]!.status).toBe('started');
    h.starter.start.mockClear();
    h.audit.dataChange.mockClear();
    const again = await h.dispatcher.handle(ev);
    expect(again[0]!.status).toBe('duplicate');
    expect(h.starter.start).not.toHaveBeenCalled();
    expect(h.audit.dataChange).not.toHaveBeenCalled();
    expect(h.instances).toHaveLength(1);
  });

  it("le starter qui répond created=false donne 'duplicate'", async () => {
    const h = makeHarness();
    h.addTrigger();
    h.starter.start.mockResolvedValueOnce({ created: false, instance: { wfInstanceId: '7' } } as never);
    const out = await h.dispatcher.handle(h.event());
    expect(out[0]).toEqual({ triggerId: 1, status: 'duplicate', instanceId: '7' });
    expect(h.tracker.count(1)).toBe(0);
  });

  it('plafond atteint : aucun lancement, journal rate-limité, pas un échec, pas de désactivation', async () => {
    const h = makeHarness();
    const t = h.addTrigger({ conditions: { limits: { maxLaunches: 2, windowMinutes: 60 } } });
    expect((await h.dispatcher.handle(h.event({}, 1)))[0]!.status).toBe('started');
    expect((await h.dispatcher.handle(h.event({}, 2)))[0]!.status).toBe('started');
    for (const id of [3, 4, 5]) expect((await h.dispatcher.handle(h.event({}, id)))[0]!.status).toBe('cap_reached');
    expect(h.instances).toHaveLength(2);
    // Une seule entrée de journal malgré trois refus (rate-limit 5 min).
    expect(h.audits.filter((a) => a.oldValue === 'cap_reached')).toHaveLength(1);
    expect(h.tracker.count(t.wfTriggerId)).toBe(0);
    expect(h.triggers[0]!.isActive).toBe(true);
  });

  it('fenêtre glissante : le plafond se libère quand les lancements sortent de la fenêtre', async () => {
    const h = makeHarness();
    h.addTrigger({ conditions: { limits: { maxLaunches: 1, windowMinutes: 10 } } });
    expect((await h.dispatcher.handle(h.event({}, 1)))[0]!.status).toBe('started');
    h.advance(5 * MIN);
    expect((await h.dispatcher.handle(h.event({}, 2)))[0]!.status).toBe('cap_reached');
    h.advance(6 * MIN);
    expect((await h.dispatcher.handle(h.event({}, 3)))[0]!.status).toBe('started');
    expect(h.instances).toHaveLength(2);
  });

  it('lanceur désactivé ou sans menu Lancer : aucun lancement, journal, échec compté', async () => {
    const h = makeHarness();
    const t = h.addTrigger();
    h.principals.canLaunch.mockResolvedValue(false);
    const out = await h.dispatcher.handle(h.event());
    expect(out[0]!.status).toBe('launcher_inactive');
    expect(h.starter.start).not.toHaveBeenCalled();
    expect(h.audits.filter((a) => a.oldValue === 'launcher_inactive')).toHaveLength(1);
    expect(h.tracker.count(t.wfTriggerId)).toBe(1);
    expect(h.subjects.assertAccess).not.toHaveBeenCalled();
  });

  it("accès à l'objet refusé : aucun lancement, journal, PAS d'échec compté", async () => {
    const h = makeHarness();
    const t = h.addTrigger();
    h.subjects.assertAccess.mockRejectedValue(new ForbiddenException('Accès refusé'));
    for (let i = 0; i < WF_TRIGGER_MAX_CONSECUTIVE_FAILURES + 2; i += 1) {
      expect((await h.dispatcher.handle(h.event({}, 100 + i)))[0]!.status).toBe('subject_denied');
    }
    expect(h.starter.start).not.toHaveBeenCalled();
    expect(h.tracker.count(t.wfTriggerId)).toBe(0);
    expect(h.triggers[0]!.isActive).toBe(true);
    expect(h.audits.filter((a) => a.oldValue === 'subject_denied')).toHaveLength(1);
  });

  it("ForbiddenException du starter : 'subject_denied' par défaut, 'launcher_inactive' si le compte est en cause, jamais d'échec compté", async () => {
    const h = makeHarness();
    const t = h.addTrigger();
    h.starter.start.mockRejectedValueOnce(new ForbiddenException('Accès refusé à l\'objet lié.'));
    expect((await h.dispatcher.handle(h.event({}, 1)))[0]!.status).toBe('subject_denied');
    h.starter.start.mockRejectedValueOnce(
      new ForbiddenException("Le compte d'exécution du déclencheur n'est pas autorisé à lancer des workflows."),
    );
    expect((await h.dispatcher.handle(h.event({}, 2)))[0]!.status).toBe('launcher_inactive');
    expect(h.tracker.count(t.wfTriggerId)).toBe(0);
  });

  it("arrêt d'urgence (global ou par workflow) : aucun lancement, pas un échec", async () => {
    const h = makeHarness();
    const t = h.addTrigger({ definitionId: 50 });
    h.gate.isStopped.mockImplementation((definitionId: number) => Promise.resolve(definitionId === 50));
    for (let i = 0; i < WF_TRIGGER_MAX_CONSECUTIVE_FAILURES + 1; i += 1) {
      expect((await h.dispatcher.handle(h.event({}, i + 1)))[0]!.status).toBe('stopped');
    }
    expect(h.gate.isStopped).toHaveBeenCalledWith(50);
    expect(h.starter.start).not.toHaveBeenCalled();
    expect(h.tracker.count(t.wfTriggerId)).toBe(0);
    expect(h.triggers[0]!.isActive).toBe(true);
    // Barrière levée : le déclencheur repart.
    h.gate.isStopped.mockResolvedValue(false);
    expect((await h.dispatcher.handle(h.event({}, 99)))[0]!.status).toBe('started');
  });

  it('barrière en erreur : fail-closed (stopped), Logger.error, aucun lancement', async () => {
    const h = makeHarness();
    h.addTrigger();
    h.gate.isStopped.mockRejectedValue(new Error('db down'));
    const out = await h.dispatcher.handle(h.event());
    expect(out[0]!.status).toBe('stopped');
    expect(Logger.prototype.error).toHaveBeenCalled();
    expect(h.starter.start).not.toHaveBeenCalled();
    expect(h.tracker.count(1)).toBe(0);
  });

  it("désactivation automatique après N échecs consécutifs (lanceur inactif), puis plus aucun lancement", async () => {
    const h = makeHarness();
    h.addTrigger();
    h.principals.canLaunch.mockResolvedValue(false);
    const statuses: string[] = [];
    for (let i = 1; i <= WF_TRIGGER_MAX_CONSECUTIVE_FAILURES; i += 1) {
      statuses.push((await h.dispatcher.handle(h.event({}, i)))[0]!.status);
    }
    expect(statuses.slice(0, -1).every((s) => s === 'launcher_inactive')).toBe(true);
    expect(statuses[statuses.length - 1]).toBe('auto_disabled');
    expect(h.triggers[0]!.isActive).toBe(false);
    expect(h.prisma.wfTrigger.updateMany).toHaveBeenCalledWith({ where: { wfTriggerId: 1, isActive: true }, data: { isActive: false } });
    const disable = h.audits.find((a) => a.oldValue === 'auto_disabled');
    expect(disable).toMatchObject({
      userGroupId: null,
      actorFullName: 'Déclencheur workflow',
      objectRef: 'wf_trigger:1',
      newValue: 'Désactivation automatique du déclencheur n° 1 : launcher_inactive',
    });
    // Même si le compte redevient valide, un déclencheur désactivé n'est plus évalué.
    h.principals.canLaunch.mockResolvedValue(true);
    expect(await h.dispatcher.handle(h.event({}, 500))).toEqual([]);
    expect(h.starter.start).not.toHaveBeenCalled();
  });

  it('un lancement réussi rompt la série d\'échecs', async () => {
    const h = makeHarness();
    h.addTrigger();
    h.principals.canLaunch.mockResolvedValue(false);
    for (let i = 1; i < WF_TRIGGER_MAX_CONSECUTIVE_FAILURES; i += 1) await h.dispatcher.handle(h.event({}, i));
    expect(h.tracker.count(1)).toBe(WF_TRIGGER_MAX_CONSECUTIVE_FAILURES - 1);
    h.principals.canLaunch.mockResolvedValue(true);
    expect((await h.dispatcher.handle(h.event({}, 200)))[0]!.status).toBe('started');
    expect(h.tracker.count(1)).toBe(0);
  });

  it("réactivation par un humain (updatedAt change) : le compteur repart de zéro", async () => {
    const h = makeHarness();
    const t = h.addTrigger();
    h.principals.canLaunch.mockResolvedValue(false);
    for (let i = 1; i < WF_TRIGGER_MAX_CONSECUTIVE_FAILURES; i += 1) await h.dispatcher.handle(h.event({}, i));
    expect(h.tracker.count(1)).toBe(WF_TRIGGER_MAX_CONSECUTIVE_FAILURES - 1);
    // Un humain modifie le déclencheur.
    t.updatedAt = new Date(T0 + 1000);
    expect((await h.dispatcher.handle(h.event({}, 300)))[0]!.status).toBe('launcher_inactive');
    expect(h.tracker.count(1)).toBe(1);
    expect(h.triggers[0]!.isActive).toBe(true);
  });

  it('désactivation quand les N dernières instances du déclencheur sont toutes échouées', async () => {
    const h = makeHarness();
    h.addTrigger({ updatedAt: new Date(T0 - 5 * 3_600_000) });
    for (let i = 0; i < WF_TRIGGER_MAX_CONSECUTIVE_FAILURES; i += 1) {
      h.instances.push({
        wfInstanceId: String(i + 1),
        definitionId: 50,
        triggerId: 1,
        idempotencyKey: `trg:1:mail.arrived:mail:${i + 1}`,
        status: 3,
        startedAt: new Date(T0 - (i + 1) * 20 * MIN),
      });
    }
    const out = await h.dispatcher.handle(h.event({}, 777));
    expect(out[0]!.status).toBe('auto_disabled');
    expect(h.triggers[0]!.isActive).toBe(false);
    expect(h.starter.start).not.toHaveBeenCalled();
    expect(h.audits.find((a) => a.oldValue === 'auto_disabled')?.newValue).toBe(
      'Désactivation automatique du déclencheur n° 1 : instances_en_echec',
    );
  });

  it('réactivation après instances_en_echec : les anciennes instances échouées ne comptent plus, N nouvelles redésactivent', async () => {
    const h = makeHarness();
    const t = h.addTrigger({ updatedAt: new Date(T0 - 5 * 3_600_000) });
    for (let i = 0; i < WF_TRIGGER_MAX_CONSECUTIVE_FAILURES; i += 1) {
      h.instances.push({
        wfInstanceId: String(i + 1),
        definitionId: 50,
        triggerId: 1,
        idempotencyKey: `trg:1:mail.arrived:mail:${i + 1}`,
        status: 3,
        startedAt: new Date(T0 - (i + 1) * 20 * MIN),
      });
    }
    expect((await h.dispatcher.handle(h.event({}, 777)))[0]!.status).toBe('auto_disabled');
    // Réactivation humaine : isActive et updatedAt (Prisma @updatedAt) avancent.
    t.isActive = true;
    t.updatedAt = new Date(T0 + MIN);
    expect((await h.dispatcher.handle(h.event({}, 778)))[0]!.status).toBe('started');
    expect(t.isActive).toBe(true);
    // N nouvelles instances échouées après la réactivation : nouvelle désactivation.
    h.instances.length = 0;
    for (let i = 0; i < WF_TRIGGER_MAX_CONSECUTIVE_FAILURES; i += 1) {
      h.instances.push({
        wfInstanceId: String(500 + i),
        definitionId: 50,
        triggerId: 1,
        idempotencyKey: `trg:1:mail.arrived:mail:${900 + i}`,
        status: 3,
        startedAt: new Date(T0 + (i + 2) * MIN),
      });
    }
    expect((await h.dispatcher.handle(h.event({}, 779)))[0]!.status).toBe('auto_disabled');
    expect(t.isActive).toBe(false);
  });

  it("pas de désactivation si une des N dernières instances n'est pas échouée", async () => {
    const h = makeHarness();
    h.addTrigger({ updatedAt: new Date(T0 - 5 * 3_600_000) });
    for (let i = 0; i < WF_TRIGGER_MAX_CONSECUTIVE_FAILURES; i += 1) {
      h.instances.push({
        wfInstanceId: String(i + 1),
        definitionId: 50,
        triggerId: 1,
        idempotencyKey: `trg:1:mail.arrived:mail:${i + 1}`,
        status: i === 2 ? 2 : 3,
        startedAt: new Date(T0 - (i + 1) * 20 * MIN),
      });
    }
    expect((await h.dispatcher.handle(h.event({}, 777)))[0]!.status).toBe('started');
  });

  it("définition non publiée (ConflictException) : 'definition_unavailable', journal, échec compté", async () => {
    const h = makeHarness();
    h.addTrigger();
    h.starter.start.mockRejectedValue(new ConflictException('non publiée'));
    const out = await h.dispatcher.handle(h.event());
    expect(out[0]!.status).toBe('definition_unavailable');
    expect(h.tracker.count(1)).toBe(1);
    expect(h.audits.filter((a) => a.oldValue === 'definition_unavailable')).toHaveLength(1);
  });

  it("erreur inattendue du starter : 'error', Logger.error, échec compté", async () => {
    const h = makeHarness();
    h.addTrigger();
    h.starter.start.mockRejectedValue(new Error('boom'));
    const out = await h.dispatcher.handle(h.event());
    expect(out[0]!.status).toBe('error');
    expect(Logger.prototype.error).toHaveBeenCalled();
    expect(h.tracker.count(1)).toBe(1);
  });

  it("l'échec de mise à jour de lastFiredAt est ignoré", async () => {
    const h = makeHarness();
    h.addTrigger();
    h.prisma.$executeRaw.mockRejectedValueOnce(new Error('verrou'));
    expect((await h.dispatcher.handle(h.event()))[0]!.status).toBe('started');
  });

  it("l'échec du journal d'audit ne bloque rien et ne remonte pas", async () => {
    const h = makeHarness();
    h.addTrigger();
    h.principals.canLaunch.mockResolvedValue(false);
    h.audit.dataChange.mockRejectedValue(new Error('audit indisponible'));
    const out = await h.dispatcher.handle(h.event());
    expect(out[0]!.status).toBe('launcher_inactive');
    expect(h.audit.dataChange).toHaveBeenCalledTimes(1);
  });

  it("le journal est rate-limité à une entrée par (déclencheur, nature) et par 5 minutes", async () => {
    const h = makeHarness();
    h.addTrigger();
    h.principals.canLaunch.mockResolvedValue(false);
    await h.dispatcher.handle(h.event({}, 1));
    await h.dispatcher.handle(h.event({}, 2));
    expect(h.audit.dataChange).toHaveBeenCalledTimes(1);
    h.advance(5 * MIN + 1);
    await h.dispatcher.handle(h.event({}, 3));
    expect(h.audit.dataChange).toHaveBeenCalledTimes(2);
  });

  it('handle() ne lève jamais, même si Prisma lève', async () => {
    const h = makeHarness();
    h.addTrigger();
    h.prisma.wfTrigger.findMany.mockRejectedValueOnce(new Error('db'));
    await expect(h.dispatcher.handle(h.event())).resolves.toEqual([]);
    h.prisma.wfInstance.findFirst.mockRejectedValueOnce(new Error('db'));
    await expect(h.dispatcher.handle(h.event())).resolves.toEqual([{ triggerId: 1, status: 'error' }]);
    // Une panne de base n'est pas un échec du déclencheur.
    expect(h.tracker.count(1)).toBe(0);
    expect(h.triggers[0]!.isActive).toBe(true);
  });

  it('un déclencheur qui plante n\'empêche pas les suivants', async () => {
    const h = makeHarness();
    h.addTrigger();
    h.addTrigger({ definitionId: 51 });
    h.prisma.wfInstance.findFirst.mockRejectedValueOnce(new Error('db'));
    const out = await h.dispatcher.handle(h.event());
    expect(out.map((o) => o.status)).toEqual(['error', 'started']);
  });

  it("event.triggerId restreint l'évaluation au seul déclencheur", async () => {
    const h = makeHarness();
    h.addTrigger();
    h.addTrigger({ definitionId: 51 });
    const out = await h.dispatcher.handle(h.event({ triggerId: 2 }));
    expect(out.map((o) => o.triggerId)).toEqual([2]);
    expect(h.starts.map((s) => s.triggerId)).toEqual([2]);
  });

  it("ignore les déclencheurs inactifs et ceux d'un autre type d'événement", async () => {
    const h = makeHarness();
    h.addTrigger({ isActive: false });
    h.addTrigger({ eventType: 'document.deposited' });
    expect(await h.dispatcher.handle(h.event())).toEqual([]);
  });

  it('plafonne à 200 déclencheurs par événement, dans l\'ordre des identifiants', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i += 1) h.addTrigger();
    await h.dispatcher.handle(h.event());
    expect(h.prisma.wfTrigger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200, orderBy: { wfTriggerId: 'asc' }, where: { isActive: true, eventType: 'mail.arrived' } }),
    );
  });

  it("le contexte d'instance ne contient que des champs structurés (aucun texte libre)", async () => {
    const h = makeHarness();
    h.addTrigger();
    const ev = h.event();
    await h.dispatcher.handle(ev);
    const ctx = h.starts[0]!.context as { trigger: object; event: object; subject: Record<string, unknown> };
    expect(Object.keys(ctx).sort()).toEqual(['event', 'subject', 'trigger']);
    expect(ctx.trigger).toEqual({ id: 1, eventType: 'mail.arrived' });
    expect(ctx.event).toEqual({ type: 'mail.arrived', subjectType: 'mail', subjectId: '42', occurredAt: ev.occurredAt });
    for (const v of Object.values(ctx.subject)) {
      expect(['number', 'boolean', 'string'].includes(typeof v) || v === null).toBe(true);
    }
    // Aucune chaîne libre : les seules chaînes possibles sont la date butoir ISO (absente ici).
    expect(Object.values(ctx.subject).filter((v) => typeof v === 'string')).toEqual([]);
  });

  it("les messages de journal ne contiennent aucun texte venant de l'événement", async () => {
    const h = makeHarness();
    h.addTrigger();
    h.principals.canLaunch.mockResolvedValue(false);
    const ev = h.event({ occurrenceKey: 'SECRET-OCC' });
    await h.dispatcher.handle(ev);
    const text = JSON.stringify(h.audits);
    expect(text).not.toContain('SECRET-OCC');
    expect(text).toContain('wf_trigger:1');
  });

  it('onModuleInit abonne le répartiteur au bus ; onModuleDestroy le désabonne', async () => {
    const h = makeHarness();
    h.addTrigger();
    h.dispatcher.onModuleInit();
    h.bus.emit(h.event({}, 1));
    await h.bus.idle();
    expect(h.starter.start).toHaveBeenCalledTimes(1);
    h.dispatcher.onModuleDestroy();
    h.bus.emit(h.event({}, 2));
    await h.bus.idle();
    expect(h.starter.start).toHaveBeenCalledTimes(1);
  });
});
