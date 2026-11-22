// Docu-Flow W3 - balayages d'échéances et de seuils sur PostgreSQL RÉEL.
// Exécuté seulement si WF_TEST_DATABASE_URL pointe une base JETABLE où toutes les migrations sont appliquées.
// Refuse de tourner si WF_TEST_DATABASE_URL === DATABASE_URL (jamais la base de développement).
// Les données créées ici portent un identifiant unique d'exécution (RUN) et sont retirées en fin de test, sauf ce
// qui est en ajout seul (`wf_event_log`, non utilisé ici).
import { Prisma, PrismaClient } from '@prisma/client';
import {
  createSweepCursors,
  runDeadlineSweep,
  runThresholdSweep,
} from './workflow-deadlines.processor';
import { triggerIdempotencyKey } from './workflow-deadlines.keys';
import type { WfEventPayload } from './workflow-deadlines.events';

const url = process.env.WF_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('balayages W3 sur PostgreSQL', () => {
  let prisma: PrismaClient;
  const RUN = `w3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const hour = 3_600_000;
  // `timestamptz(0)` arrondit à la seconde : dates butoirs à la seconde entière, avec marge d'une demi-heure pour que
  // `hoursOverdue` (heures entières, arrondi bas) reste stable quel que soit l'instant d'exécution.
  const wholeSecondsAgo = (ms: number) => new Date(Math.floor((Date.now() - ms) / 1000) * 1000);
  const cleanups: Array<() => Promise<unknown>> = [];

  const ids = {
    roleId: 0,
    definitionId: 0,
    versionId: 0,
    deadlineTriggerId: 0,
    thresholdTriggerId: 0,
    mailId: 0,
    otherMailId: 0,
    metaDataId: 0,
    documentId: 0,
    smallDocumentId: 0,
    badDocumentId: 0,
  };
  const instanceIds: bigint[] = [];

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasources: { db: { url: url as string } } });

    const role = await prisma.role.create({ data: { name: `role-${RUN}` } });
    ids.roleId = role.roleId;
    const def = await prisma.wfDefinition.create({ data: { name: `def-${RUN}` } });
    ids.definitionId = def.wfDefinitionId;
    const version = await prisma.wfDefinitionVersion.create({
      data: {
        definitionId: def.wfDefinitionId,
        versionNumber: 1,
        graph: { schemaVersion: 1, start: 'a', steps: [{ key: 'a', name: 'A', type: 'formulaire', next: [] }] },
      },
    });
    ids.versionId = version.wfDefinitionVersionId;

    const meta = await prisma.metaData.create({ data: { label: `meta-${RUN}`, dataType: 2 } });
    ids.metaDataId = meta.metaDataId;

    const dTrigger = await prisma.wfTrigger.create({
      data: {
        definitionId: def.wfDefinitionId,
        name: `echeance-${RUN}`,
        eventType: 'deadline.reached',
        conditions: {},
        runAsUserGroupId: 1,
      },
    });
    ids.deadlineTriggerId = dTrigger.wfTriggerId;
    const tTrigger = await prisma.wfTrigger.create({
      data: {
        definitionId: def.wfDefinitionId,
        name: `seuil-${RUN}`,
        eventType: 'threshold.crossed',
        conditions: { threshold: { metaDataId: meta.metaDataId, op: 'gt', value: 1000 } },
        runAsUserGroupId: 1,
      },
    });
    ids.thresholdTriggerId = tTrigger.wfTriggerId;

    // Courrier échu (3 h) + courrier déjà traité (ne doit jamais être émis).
    const mail = await prisma.mail.create({
      data: {
        title: `mail-${RUN}`,
        date: new Date(),
        destinataireRoleId: role.roleId,
        dateButoire: wholeSecondsAgo(3 * hour + hour / 2),
      },
    });
    ids.mailId = mail.mailId;
    const done = await prisma.mail.create({
      data: {
        title: `mail-traite-${RUN}`,
        date: new Date(),
        destinataireRoleId: role.roleId,
        dateButoire: wholeSecondsAgo(3 * hour + hour / 2),
        dateTraited: new Date(),
      },
    });
    ids.otherMailId = done.mailId;

    // Trois documents : au-dessus du seuil, sous le seuil, valeur non numérique.
    const mkDoc = async (suffix: string, value: string) => {
      const doc = await prisma.document.create({ data: { label: `doc-${suffix}-${RUN}` } });
      await prisma.documentMetadataValue.create({
        data: { documentId: doc.documentId, metaDataId: meta.metaDataId, value },
      });
      return doc.documentId;
    };
    ids.documentId = await mkDoc('haut', '1500');
    ids.smallDocumentId = await mkDoc('bas', '999');
    ids.badDocumentId = await mkDoc('texte', '12abc');
  });

  afterAll(async () => {
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* nettoyage au mieux : base jetable */
      }
    };
    await attempt(() => prisma.wfInstance.deleteMany({ where: { wfInstanceId: { in: instanceIds } } }));
    await attempt(() =>
      prisma.wfTrigger.deleteMany({ where: { wfTriggerId: { in: [ids.deadlineTriggerId, ids.thresholdTriggerId] } } }),
    );
    await attempt(() => prisma.wfDefinitionVersion.deleteMany({ where: { wfDefinitionVersionId: ids.versionId } }));
    await attempt(() => prisma.wfDefinition.deleteMany({ where: { wfDefinitionId: ids.definitionId } }));
    await attempt(() =>
      prisma.document.deleteMany({ where: { documentId: { in: [ids.documentId, ids.smallDocumentId, ids.badDocumentId] } } }),
    );
    await attempt(() => prisma.metaData.deleteMany({ where: { metaDataId: ids.metaDataId } }));
    await attempt(() => prisma.mail.deleteMany({ where: { mailId: { in: [ids.mailId, ids.otherMailId] } } }));
    await attempt(() => prisma.role.deleteMany({ where: { roleId: ids.roleId } }));
    await prisma.$disconnect();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      try {
        await cleanups.pop()!();
      } catch {
        /* nettoyage au mieux : base jetable */
      }
    }
  });

  const mine = (events: WfEventPayload[], triggerId: number) =>
    events.filter((e) => e.triggerId === triggerId);

  it("émet pour l'échéance échue, puis plus une fois l'instance de la clé créée", async () => {
    const now = new Date();
    const first: WfEventPayload[] = [];
    await runDeadlineSweep(prisma, now, (e) => void first.push(e));
    const events = mine(first, ids.deadlineTriggerId);
    expect(events.map((e) => e.subjectId)).toEqual([String(ids.mailId)]); // le courrier traité est exclu
    const e = events[0]!;
    expect(e).toMatchObject({ type: 'deadline.reached', subjectType: 'mail', triggerId: ids.deadlineTriggerId });
    expect(e.fields.destinataireRoleId).toBe(ids.roleId);
    expect(e.fields.hoursOverdue).toBe(3);
    expect(e.occurrenceKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const key = triggerIdempotencyKey(ids.deadlineTriggerId, e);
    const instance = await prisma.wfInstance.create({
      data: {
        definitionId: ids.definitionId,
        definitionVersionId: ids.versionId,
        startedBy: 1,
        triggerId: ids.deadlineTriggerId,
        idempotencyKey: key,
      },
    });
    instanceIds.push(instance.wfInstanceId);

    const second: WfEventPayload[] = [];
    await runDeadlineSweep(prisma, now, (ev) => void second.push(ev));
    expect(mine(second, ids.deadlineTriggerId)).toHaveLength(0);
  });

  it("émet pour le document au-dessus du seuil seulement, puis plus une fois l'instance créée", async () => {
    const now = new Date();
    const first: WfEventPayload[] = [];
    await runThresholdSweep(prisma, now, (e) => void first.push(e));
    const events = mine(first, ids.thresholdTriggerId);
    expect(events.map((e) => e.subjectId)).toEqual([String(ids.documentId)]);
    expect(events[0]!.fields).toMatchObject({ metaDataId: ids.metaDataId, value: 1500, thresholdValue: 1000 });

    const instance = await prisma.wfInstance.create({
      data: {
        definitionId: ids.definitionId,
        definitionVersionId: ids.versionId,
        startedBy: 1,
        triggerId: ids.thresholdTriggerId,
        idempotencyKey: triggerIdempotencyKey(ids.thresholdTriggerId, events[0]!),
      },
    });
    instanceIds.push(instance.wfInstanceId);

    const second: WfEventPayload[] = [];
    await runThresholdSweep(prisma, now, (ev) => void second.push(ev));
    expect(mine(second, ids.thresholdTriggerId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Conditions `match` reportées en SQL et pagination à curseur
  // -------------------------------------------------------------------------

  const mkDeadlineTrigger = async (match: Prisma.InputJsonValue[]) => {
    const t = await prisma.wfTrigger.create({
      data: {
        definitionId: ids.definitionId,
        name: `echeance-match-${RUN}-${Math.floor(Math.random() * 1e6)}`,
        eventType: 'deadline.reached',
        conditions: { match },
        runAsUserGroupId: 1,
      },
    });
    cleanups.push(() => prisma.wfTrigger.deleteMany({ where: { wfTriggerId: t.wfTriggerId } }));
    return t.wfTriggerId;
  };

  const mkMails = async (count: number, status: number, dueMsAgo: number) => {
    const data = Array.from({ length: count }, (_, i) => ({
      title: `mail-bulk-${RUN}-${status}-${i}`,
      date: new Date(),
      destinataireRoleId: ids.roleId,
      status,
      dateButoire: wholeSecondsAgo(dueMsAgo),
    }));
    await prisma.mail.createMany({ data });
    cleanups.push(() => prisma.mail.deleteMany({ where: { title: { startsWith: `mail-bulk-${RUN}-${status}-` } } }));
  };

  const mkThresholdTrigger = async (metaDataId: number, match: Prisma.InputJsonValue[]) => {
    const t = await prisma.wfTrigger.create({
      data: {
        definitionId: ids.definitionId,
        name: `seuil-match-${RUN}-${Math.floor(Math.random() * 1e6)}`,
        eventType: 'threshold.crossed',
        conditions: { threshold: { metaDataId, op: 'gt', value: 1000 }, match },
        runAsUserGroupId: 1,
      },
    });
    cleanups.push(() => prisma.wfTrigger.deleteMany({ where: { wfTriggerId: t.wfTriggerId } }));
    return t.wfTriggerId;
  };

  /** Une métadonnée entière dédiée (ou fournie) + `count` documents de valeur donnée, isolés des autres tests. */
  const mkDocuments = async (tag: string, count: number, value: number, meta?: number) => {
    let metaDataId = meta;
    if (metaDataId === undefined) {
      const m = await prisma.metaData.create({ data: { label: `meta-${tag}-${RUN}`, dataType: 2 } });
      metaDataId = m.metaDataId;
      cleanups.push(() => prisma.metaData.deleteMany({ where: { metaDataId: m.metaDataId } }));
    }
    await prisma.document.createMany({
      data: Array.from({ length: count }, (_, i) => ({ label: `doc-${tag}-${RUN}-${value}-${i}` })),
    });
    const docs = await prisma.document.findMany({
      where: { label: { startsWith: `doc-${tag}-${RUN}-${value}-` } },
      select: { documentId: true },
      orderBy: { documentId: 'asc' },
    });
    await prisma.documentMetadataValue.createMany({
      data: docs.map((d) => ({ documentId: d.documentId, metaDataId: metaDataId as number, value: String(value) })),
    });
    cleanups.push(() => prisma.document.deleteMany({ where: { documentId: { in: docs.map((d) => d.documentId) } } }));
    return { metaDataId, documentIds: docs.map((d) => d.documentId) };
  };

  it('beaucoup de courriers non conformes ne masquent pas un courrier conforme (échéances)', async () => {
    // 230 courriers non conformes (statut 0), plus anciens donc triés AVANT le conforme (statut 3).
    await mkMails(230, 0, 20 * hour);
    await mkMails(1, 3, 2 * hour);
    const triggerId = await mkDeadlineTrigger([{ field: 'subject.status', op: 'eq', value: 3 }]);
    const events: WfEventPayload[] = [];
    const res = await runDeadlineSweep(prisma, new Date(), (e) => void events.push(e), undefined, createSweepCursors());
    const mineEvents = mine(events, triggerId);
    expect(mineEvents).toHaveLength(1);
    expect(mineEvents[0]!.fields.status).toBe(3);
    expect(res.errors).toBe(0);
  });

  it('neq et exists reportés en SQL : un champ NULL passe neq, pas exists', async () => {
    await mkMails(2, 1, 2 * hour); // confidentialite_id NULL
    const neq = await mkDeadlineTrigger([
      { field: 'subject.status', op: 'eq', value: 1 },
      { field: 'subject.confidentialiteId', op: 'neq', value: 5 },
    ]);
    const exists = await mkDeadlineTrigger([
      { field: 'subject.status', op: 'eq', value: 1 },
      { field: 'subject.confidentialiteId', op: 'exists' },
    ]);
    const events: WfEventPayload[] = [];
    await runDeadlineSweep(prisma, new Date(), (e) => void events.push(e), undefined, createSweepCursors());
    expect(mine(events, neq)).toHaveLength(2);
    expect(mine(events, exists)).toHaveLength(0);
  });

  it('plus de 200 courriers conformes : deux ticks émettent tout (curseur partagé, aucune instance créée)', async () => {
    await mkMails(230, 4, 5 * hour);
    const triggerId = await mkDeadlineTrigger([{ field: 'subject.status', op: 'eq', value: 4 }]);
    const cursors = createSweepCursors();
    const events: WfEventPayload[] = [];
    const now = new Date();
    await runDeadlineSweep(prisma, now, (e) => void events.push(e), undefined, cursors);
    expect(mine(events, triggerId)).toHaveLength(200);
    await runDeadlineSweep(prisma, now, (e) => void events.push(e), undefined, cursors);
    const all = mine(events, triggerId).map((e) => e.subjectId);
    expect(all).toHaveLength(230);
    expect(new Set(all).size).toBe(230);
    expect(cursors.deadlines.has(triggerId)).toBe(false); // cycle terminé
  });

  it('beaucoup de documents non conformes ne masquent pas un document conforme (seuils)', async () => {
    // Même métadonnée : 230 documents de valeur 5 000 000 (non conformes à `value lt 100000`), puis un de 50 000.
    const first = await mkDocuments('masque', 230, 5_000_000);
    const second = await mkDocuments('masque', 1, 50_000, first.metaDataId);
    const triggerId = await mkThresholdTrigger(first.metaDataId, [{ field: 'subject.value', op: 'lt', value: 100000 }]);
    const events: WfEventPayload[] = [];
    await runThresholdSweep(prisma, new Date(), (e) => void events.push(e), undefined, createSweepCursors());
    expect(mine(events, triggerId).map((e) => e.subjectId)).toEqual([String(second.documentIds[0])]);
  });

  it('plus de 200 documents conformes : deux ticks émettent tout (curseur partagé)', async () => {
    const docs = await mkDocuments('pages', 230, 5000);
    const triggerId = await mkThresholdTrigger(docs.metaDataId, []);
    const cursors = createSweepCursors();
    const events: WfEventPayload[] = [];
    await runThresholdSweep(prisma, new Date(), (e) => void events.push(e), undefined, cursors);
    expect(mine(events, triggerId)).toHaveLength(200);
    await runThresholdSweep(prisma, new Date(), (e) => void events.push(e), undefined, cursors);
    const all = mine(events, triggerId).map((e) => e.subjectId);
    expect(all).toHaveLength(230);
    expect(new Set(all)).toEqual(new Set(docs.documentIds.map(String)));
    expect(cursors.thresholds.has(triggerId)).toBe(false);
  });

  it('un document épuré (état 3) est exclu des seuils, un document archivé (état 1) est évalué', async () => {
    const docs = await mkDocuments('etat', 3, 5000);
    await prisma.document.update({ where: { documentId: docs.documentIds[0]! }, data: { documentState: 1 } });
    await prisma.document.update({ where: { documentId: docs.documentIds[1]! }, data: { documentState: 3 } });
    const triggerId = await mkThresholdTrigger(docs.metaDataId, []);
    const events: WfEventPayload[] = [];
    await runThresholdSweep(prisma, new Date(), (e) => void events.push(e), undefined, createSweepCursors());
    expect(new Set(mine(events, triggerId).map((e) => e.subjectId))).toEqual(
      new Set([String(docs.documentIds[0]), String(docs.documentIds[2])]),
    );
  });
});
