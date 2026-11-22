// Docu-Flow W3 - balayages d'échéances et de seuils (Prisma et émetteur simulés).
import {
  readLeadHours,
  readThreshold,
  runDeadlineSweep,
  runThresholdSweep,
  runWorkflowSweeps,
  createSweepCursors,
  resetSweepCursors,
} from './workflow-deadlines.processor';
import type { WfEventPayload } from './workflow-deadlines.events';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const HOUR = 3_600_000;

// Copie du catalogue FERMÉ de l'API (workflow-triggers/domain/event-catalog.ts) : le catalogue fait foi.
const CATALOG_FIELDS: Record<string, readonly string[]> = {
  'deadline.reached': [
    'mailType', 'status', 'mailNatureId', 'confidentialiteId', 'externalEntityId',
    'destinataireRoleId', 'destinataireUserGroupId', 'dateButoire', 'hoursOverdue',
  ],
  'threshold.crossed': ['documentTypeId', 'dossierId', 'metaDataId', 'value', 'thresholdValue'],
};
const STRING_FIELD_PATTERN = /^[A-Za-z0-9_.:+-]{1,40}$/;
const NUMBER_FIELDS = new Set([
  'mailType', 'status', 'mailNatureId', 'confidentialiteId', 'externalEntityId', 'destinataireRoleId',
  'destinataireUserGroupId', 'hoursOverdue', 'documentTypeId', 'dossierId', 'metaDataId', 'value', 'thresholdValue',
]);

function expectConformToCatalog(e: WfEventPayload): void {
  const allowed = CATALOG_FIELDS[e.type]!;
  for (const [name, value] of Object.entries(e.fields)) {
    expect(allowed).toContain(name);
    if (value === null) continue;
    if (NUMBER_FIELDS.has(name)) expect(typeof value === 'number' && Number.isFinite(value)).toBe(true);
    else {
      expect(typeof value).toBe('string');
      expect(String(value)).toMatch(STRING_FIELD_PATTERN);
    }
  }
  expect(e.subjectId).toMatch(/^\d{1,18}$/);
  if (e.occurrenceKey) expect(e.occurrenceKey).toMatch(/^[A-Za-z0-9_.:-]{1,60}$/);
  // Aucune chaîne avec espace (aucun texte libre), nulle part dans l'événement.
  expect(JSON.stringify(e)).not.toMatch(/"[^"]*\s[^"]*"/);
}

interface SqlLike {
  sql: string;
  values: unknown[];
}

function fakePrisma(opts: {
  triggers?: Record<string, unknown[]>;
  rows?: (sql: SqlLike, call: number) => unknown[] | Error;
}) {
  const queries: SqlLike[] = [];
  const prisma = {
    wfTrigger: {
      findMany: jest.fn(async (args: { where: { eventType: string } }) => opts.triggers?.[args.where.eventType] ?? []),
    },
    $queryRaw: jest.fn(async (q: SqlLike) => {
      queries.push(q);
      const out = opts.rows ? opts.rows(q, queries.length - 1) : [];
      if (out instanceof Error) throw out;
      return out;
    }),
  };
  return { prisma: prisma as never, raw: prisma, queries };
}

const mailRow = (id: number, due: Date, over: Record<string, unknown> = {}) => ({
  mailId: id, mailType: 0, status: 1, mailNatureId: 2, confidentialiteId: null, externalEntityId: 9,
  destinataireRoleId: 4, destinataireUserGroupId: null, dateButoire: due, ...over,
});

beforeEach(() => resetSweepCursors());

describe('configuration', () => {
  it('leadHours : défaut 0, entier >= 0, sinon invalide', () => {
    expect(readLeadHours({})).toBe(0);
    expect(readLeadHours({ deadline: {} })).toBe(0);
    expect(readLeadHours({ deadline: { leadHours: 24 } })).toBe(24);
    for (const bad of [-1, 1.5, '3', null, 99999]) expect(readLeadHours({ deadline: { leadHours: bad } })).toBeNull();
    expect(readLeadHours({ deadline: 'x' })).toBeNull();
    expect(readLeadHours(null)).toBe(0);
  });

  it('seuil : validation stricte', () => {
    expect(readThreshold({ threshold: { metaDataId: 5, op: 'gt', value: 100 } })).toEqual({
      metaDataId: 5,
      op: 'gt',
      value: 100,
    });
    expect(readThreshold({ threshold: { metaDataId: 5, op: 'gte', value: -3 } })).not.toBeNull();
    for (const bad of [
      {},
      { threshold: null },
      { threshold: { metaDataId: 0, op: 'gt', value: 1 } },
      { threshold: { metaDataId: 5, op: 'lt', value: 1 } },
      { threshold: { metaDataId: 5, op: '> 1; DROP TABLE x --', value: 1 } },
      { threshold: { metaDataId: 5, op: 'gt', value: '1' } },
      { threshold: { metaDataId: 5, op: 'gt', value: 1.5 } },
      { threshold: { metaDataId: 5, op: 'gt', value: 1e16 } },
    ]) {
      expect(readThreshold(bad)).toBeNull();
    }
  });
});

describe('runDeadlineSweep', () => {
  it('émet pour une échéance atteinte avec les bons champs, triggerId et occurrenceKey', async () => {
    const due = new Date('2026-11-21T07:30:00.000Z');
    const { prisma } = fakePrisma({
      triggers: { 'deadline.reached': [{ wfTriggerId: 7, definitionId: 11, conditions: {} }] },
      rows: () => [mailRow(42, due)],
    });
    const emit = jest.fn();
    const res = await runDeadlineSweep(prisma, NOW, emit);
    expect(res).toEqual({ triggers: 1, scanned: 1, emitted: 1, errors: 0 });
    const e: WfEventPayload = emit.mock.calls[0][0];
    expect(e).toMatchObject({
      type: 'deadline.reached',
      subjectType: 'mail',
      subjectId: '42',
      triggerId: 7,
      occurrenceKey: '2026-11-21',
      occurredAt: NOW.toISOString(),
    });
    expect(e.fields).toEqual({
      mailType: 0, status: 1, mailNatureId: 2, confidentialiteId: null, externalEntityId: 9,
      destinataireRoleId: 4, destinataireUserGroupId: null, dateButoire: '2026-11-21T07:30:00.000Z', hoursOverdue: 2,
    });
    expectConformToCatalog(e);
  });

  it('hoursOverdue négatif pour une échéance à venir (leadHours)', async () => {
    const due = new Date(NOW.getTime() + 5 * HOUR + 1);
    const { prisma, queries } = fakePrisma({
      triggers: { 'deadline.reached': [{ wfTriggerId: 7, definitionId: 11, conditions: { deadline: { leadHours: 6 } } }] },
      rows: () => [mailRow(1, due)],
    });
    const emit = jest.fn();
    await runDeadlineSweep(prisma, NOW, emit);
    expect(emit.mock.calls[0][0].fields.hoursOverdue).toBe(-6);
    // L'horizon passé au SQL = now + leadHours, la borne basse = now - 30 jours.
    const dates = queries[0]!.values.filter((v): v is Date => v instanceof Date).map((d) => d.toISOString());
    expect(dates).toEqual([
      new Date(NOW.getTime() + 6 * HOUR).toISOString(),
      new Date(NOW.getTime() - 30 * 24 * HOUR).toISOString(),
    ]);
  });

  it('la requête est paramétrée et filtre courriers supprimés / traités / déjà lancés', async () => {
    const { prisma, queries } = fakePrisma({
      triggers: { 'deadline.reached': [{ wfTriggerId: 7, definitionId: 11, conditions: {} }] },
    });
    await runDeadlineSweep(prisma, NOW, jest.fn());
    const q = queries[0]!;
    expect(q.sql).toContain('is_deleted = false');
    expect(q.sql).toContain('date_traited IS NULL');
    expect(q.sql).toContain('NOT EXISTS');
    expect(q.sql).toContain("':deadline.reached:mail:'");
    expect(q.sql).toContain('ORDER BY m.date_butoire ASC');
    expect(q.values).toEqual(expect.arrayContaining([11, '7', 200]));
  });

  it('configuration invalide ignorée sans exception, les autres déclencheurs continuent', async () => {
    const { prisma } = fakePrisma({
      triggers: {
        'deadline.reached': [
          { wfTriggerId: 1, definitionId: 1, conditions: { deadline: { leadHours: -5 } } },
          { wfTriggerId: 2, definitionId: 1, conditions: {} },
        ],
      },
      rows: () => [mailRow(5, new Date(NOW.getTime() - HOUR))],
    });
    const emit = jest.fn();
    const warn = jest.fn();
    const res = await runDeadlineSweep(prisma, NOW, emit, { info: jest.fn(), warn, error: jest.fn() });
    expect(res).toEqual({ triggers: 1, scanned: 1, emitted: 1, errors: 1 });
    expect(emit.mock.calls[0][0].triggerId).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("une erreur SQL sur un déclencheur n'arrête pas les autres", async () => {
    const { prisma } = fakePrisma({
      triggers: {
        'deadline.reached': [
          { wfTriggerId: 1, definitionId: 1, conditions: {} },
          { wfTriggerId: 2, definitionId: 1, conditions: {} },
        ],
      },
      rows: (_q, call) => (call === 0 ? new Error('panne') : [mailRow(9, new Date(NOW.getTime() - HOUR))]),
    });
    const emit = jest.fn();
    const res = await runDeadlineSweep(prisma, NOW, emit);
    expect(res).toEqual({ triggers: 2, scanned: 1, emitted: 1, errors: 1 });
    expect(emit.mock.calls[0][0].triggerId).toBe(2);
  });

  it('une émission qui lève est comptée, sans arrêter le balayage', async () => {
    const { prisma } = fakePrisma({
      triggers: { 'deadline.reached': [{ wfTriggerId: 1, definitionId: 1, conditions: {} }] },
      rows: () => [mailRow(1, NOW), mailRow(2, NOW)],
    });
    const emit = jest.fn().mockImplementationOnce(() => {
      throw new Error('x');
    });
    const res = await runDeadlineSweep(prisma, NOW, emit);
    expect(res).toMatchObject({ scanned: 2, emitted: 1, errors: 1 });
  });

  it('lecture des déclencheurs en panne : ne lève pas', async () => {
    const prisma = {
      wfTrigger: { findMany: jest.fn().mockRejectedValue(new Error('db')) },
      $queryRaw: jest.fn(),
    } as never;
    await expect(runDeadlineSweep(prisma, NOW, jest.fn())).resolves.toMatchObject({ errors: 1, emitted: 0 });
  });

  it('plafond : jamais plus de 200 événements par déclencheur', async () => {
    const many = Array.from({ length: 450 }, (_, i) => mailRow(i + 1, new Date(NOW.getTime() - HOUR)));
    const { prisma } = fakePrisma({
      triggers: { 'deadline.reached': [{ wfTriggerId: 1, definitionId: 1, conditions: {} }] },
      rows: () => many,
    });
    const emit = jest.fn();
    const res = await runDeadlineSweep(prisma, NOW, emit);
    expect(res.emitted).toBe(200);
    expect(emit).toHaveBeenCalledTimes(200);
  });
});

describe('runThresholdSweep', () => {
  const trigger = (op: unknown, value: unknown = 1000, metaDataId: unknown = 5) => ({
    wfTriggerId: 3,
    definitionId: 8,
    conditions: { threshold: { metaDataId, op, value } },
  });

  it('gt : émet par document, champs du catalogue, sans occurrenceKey', async () => {
    const { prisma, queries } = fakePrisma({
      triggers: { 'threshold.crossed': [trigger('gt')] },
      rows: () => [{ documentId: 900, documentTypeId: 2, dossierId: null, metaDataId: 5, value: 1500n }],
    });
    const emit = jest.fn();
    const res = await runThresholdSweep(prisma, NOW, emit);
    expect(res).toEqual({ triggers: 1, scanned: 1, emitted: 1, errors: 0 });
    const e: WfEventPayload = emit.mock.calls[0][0];
    expect(e).toMatchObject({ type: 'threshold.crossed', subjectType: 'document', subjectId: '900', triggerId: 3 });
    expect(e.occurrenceKey).toBeUndefined();
    expect(e.fields).toEqual({ documentTypeId: 2, dossierId: null, metaDataId: 5, value: 1500, thresholdValue: 1000 });
    expectConformToCatalog(e);
    expect(queries[0]!.sql).toMatch(/END\) > CAST\(\?/);
    expect(queries[0]!.sql).toContain('data_type =');
    expect(queries[0]!.sql).toContain("'^-?[0-9]{1,15}$'");
    expect(queries[0]!.values).toEqual(expect.arrayContaining([2, 5, 1000, 8, '3', 200]));
  });

  it('gte : opérateur >=', async () => {
    const { prisma, queries } = fakePrisma({ triggers: { 'threshold.crossed': [trigger('gte')] } });
    await runThresholdSweep(prisma, NOW, jest.fn());
    expect(queries[0]!.sql).toMatch(/END\) >= CAST\(\?/);
  });

  it('opérateur hors liste blanche refusé : aucune requête', async () => {
    const { prisma, raw } = fakePrisma({
      triggers: {
        'threshold.crossed': [trigger('lt'), trigger('> 0 OR 1=1'), trigger('eq'), trigger(undefined)],
      },
    });
    const emit = jest.fn();
    const res = await runThresholdSweep(prisma, NOW, emit);
    expect(raw.$queryRaw).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(res).toMatchObject({ triggers: 0, errors: 4 });
  });

  it('valeur du seuil non entière ou chaîne : refusée', async () => {
    const { prisma, raw } = fakePrisma({
      triggers: { 'threshold.crossed': [trigger('gt', '1; DROP TABLE x'), trigger('gt', 2.5)] },
    });
    await runThresholdSweep(prisma, NOW, jest.fn());
    expect(raw.$queryRaw).not.toHaveBeenCalled();
  });

  it("une erreur sur un déclencheur n'arrête pas les autres", async () => {
    const t2 = { ...trigger('gte'), wfTriggerId: 4 };
    const { prisma } = fakePrisma({
      triggers: { 'threshold.crossed': [trigger('gt'), t2] },
      rows: (_q, call) =>
        call === 0
          ? new Error('panne')
          : [{ documentId: 1, documentTypeId: null, dossierId: null, metaDataId: 5, value: 2000 }],
    });
    const emit = jest.fn();
    const res = await runThresholdSweep(prisma, NOW, emit);
    expect(res).toEqual({ triggers: 2, scanned: 1, emitted: 1, errors: 1 });
    expect(emit.mock.calls[0][0].triggerId).toBe(4);
  });

  it('plafond : jamais plus de 200 événements par déclencheur', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      documentId: i + 1, documentTypeId: 1, dossierId: 1, metaDataId: 5, value: 5000,
    }));
    const { prisma } = fakePrisma({ triggers: { 'threshold.crossed': [trigger('gt')] }, rows: () => many });
    const emit = jest.fn();
    expect((await runThresholdSweep(prisma, NOW, emit)).emitted).toBe(200);
  });
});

describe('runWorkflowSweeps', () => {
  it('enchaîne les deux balayages et ne lève jamais', async () => {
    const prisma = {
      wfTrigger: { findMany: jest.fn().mockRejectedValue(new Error('db')) },
      $queryRaw: jest.fn(),
    } as never;
    const res = await runWorkflowSweeps(prisma, NOW, jest.fn());
    expect(res.deadlines.errors).toBe(1);
    expect(res.thresholds.errors).toBe(1);
  });
});

describe('conditions match reportées en SQL', () => {
  const deadlineTrigger = (match: unknown) => ({
    wfTriggerId: 7, definitionId: 11, conditions: { match },
  });
  const sqlOf = async (match: unknown) => {
    const { prisma, queries } = fakePrisma({ triggers: { 'deadline.reached': [deadlineTrigger(match)] } });
    await runDeadlineSweep(prisma, NOW, jest.fn());
    return queries[0]!;
  };

  it('reporte eq, in, gte et exists avec des paramètres (jamais de valeur dans le texte SQL)', async () => {
    const q = await sqlOf([
      { field: 'subject.mailNatureId', op: 'eq', value: 31337 },
      { field: 'subject.status', op: 'in', value: [4242, 4343] },
      { field: 'subject.mailType', op: 'gte', value: 1 },
      { field: 'subject.externalEntityId', op: 'exists' },
    ]);
    expect(q.sql).toContain('m.mail_nature_id = CAST(? AS numeric)');
    expect(q.sql).toContain('m.status IN (CAST(? AS numeric),CAST(? AS numeric))');
    expect(q.sql).toContain('m.mail_type >= CAST(? AS numeric)');
    expect(q.sql).toContain('m.external_entity_id IS NOT NULL');
    expect(q.sql).not.toMatch(/31337|4242|4343/);
    expect(q.values).toEqual(expect.arrayContaining([31337, 4242, 4343, 1]));
  });

  it("neq inclut NULL (l'API traite null comme présent)", async () => {
    const q = await sqlOf([{ field: 'subject.mailNatureId', op: 'neq', value: 5 }]);
    expect(q.sql).toContain('(m.mail_nature_id IS NULL OR m.mail_nature_id <> CAST(? AS numeric))');
  });

  it('hoursOverdue est calculé en SQL au now du balayage', async () => {
    const q = await sqlOf([{ field: 'subject.hoursOverdue', op: 'gte', value: 48 }]);
    expect(q.sql).toContain(
      'floor(extract(epoch from (CAST(? AS timestamptz) - m.date_butoire)) / 3600) >= CAST(? AS numeric)',
    );
    expect(q.values).toContain(48);
  });

  it('champs non mappables, valeurs non numériques et conditions mal formées ne sont pas reportés', async () => {
    const q = await sqlOf([
      { field: 'subject.dateButoire', op: 'eq', value: '2026-11-21' },
      { field: 'subject.unknownField', op: 'eq', value: 1 },
      { field: 'subject.status', op: 'eq', value: '3' },
      { field: 'subject.status', op: 'in', value: [1, 'x'] },
      { field: 'subject.status', op: 'in', value: [] },
      { field: 'subject.status', op: 'like', value: 1 },
      { field: 'status', op: 'eq', value: 1 },
      { field: 'subject.__proto__', op: 'exists' },
      { field: 'subject.status', op: 'eq' },
      { field: 'subject.status', op: 'gt', value: Number.NaN },
      null,
      'texte',
      { op: 'eq', value: 1 },
    ]);
    expect(q.sql).not.toContain('CAST(? AS numeric)');
    expect(q.sql).not.toContain('IS NOT NULL\n           AND (m.');
    expect(q.sql).not.toMatch(/m\.status (=|<>|>|IN)/);
  });

  it("une configuration `match` qui n'est pas un tableau est ignorée sans exception", async () => {
    const { prisma } = fakePrisma({ triggers: { 'deadline.reached': [deadlineTrigger('x')] } });
    await expect(runDeadlineSweep(prisma, NOW, jest.fn())).resolves.toMatchObject({ errors: 0, triggers: 1 });
  });

  it('seuils : documentTypeId, dossierId et value reportés ; metaDataId et thresholdValue non', async () => {
    const { prisma, queries } = fakePrisma({
      triggers: {
        'threshold.crossed': [{
          wfTriggerId: 3, definitionId: 8,
          conditions: {
            threshold: { metaDataId: 5, op: 'gt', value: 1000 },
            match: [
              { field: 'subject.documentTypeId', op: 'in', value: [2, 3] },
              { field: 'subject.dossierId', op: 'neq', value: 9 },
              { field: 'subject.value', op: 'lt', value: 9_000_000 },
              { field: 'subject.metaDataId', op: 'eq', value: 5 },
              { field: 'subject.thresholdValue', op: 'eq', value: 1000 },
            ],
          },
        }],
      },
    });
    await runThresholdSweep(prisma, NOW, jest.fn());
    const q = queries[0]!;
    expect(q.sql).toContain('d.document_type_id IN (CAST(? AS numeric),CAST(? AS numeric))');
    expect(q.sql).toContain('(d.dossier_id IS NULL OR d.dossier_id <> CAST(? AS numeric))');
    expect(q.sql).toMatch(/END\) < CAST\(\? AS numeric\)/);
    expect(q.sql).not.toContain('metadata_id = CAST(? AS numeric)');
    expect(q.sql).toMatch(/d\.document_state <> \?/);
    expect(q.values).toEqual(expect.arrayContaining([3, 9_000_000]));
  });
});

describe('curseur de parcours', () => {
  it('échéances : deux ticks parcourent 250 objets, puis le cycle repart du début', async () => {
    const all = Array.from({ length: 250 }, (_, i) => mailRow(i + 1, new Date(NOW.getTime() - HOUR)));
    const cursors = createSweepCursors();
    const { prisma, queries } = fakePrisma({
      triggers: { 'deadline.reached': [{ wfTriggerId: 1, definitionId: 1, conditions: {} }] },
      // Simule le keyset : la page dépend de la présence du curseur dans la requête.
      rows: (q) => (q.sql.includes('(m.date_butoire, m.mail_id) >') ? all.slice(200) : all.slice(0, 200)),
    });
    const emit = jest.fn();
    await runDeadlineSweep(prisma, NOW, emit, undefined, cursors);
    expect(emit).toHaveBeenCalledTimes(200);
    expect(cursors.deadlines.get(1)).toMatchObject({ mailId: 200 });
    await runDeadlineSweep(prisma, NOW, emit, undefined, cursors);
    expect(emit).toHaveBeenCalledTimes(250);
    expect(emit.mock.calls.map((c) => c[0].subjectId)).toEqual(all.map((r) => String(r.mailId)));
    expect(queries[1]!.sql).toContain('ORDER BY m.date_butoire ASC, m.mail_id ASC');
    expect(queries[1]!.values).toEqual(expect.arrayContaining([200]));
    // Page courte : curseur remis à zéro, le tick suivant repart du début.
    expect(cursors.deadlines.has(1)).toBe(false);
    await runDeadlineSweep(prisma, NOW, emit, undefined, cursors);
    expect(queries[2]!.sql).not.toContain('(m.date_butoire, m.mail_id) >');
  });

  it('seuils : deux ticks parcourent 250 documents, puis curseur remis à zéro', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({
      documentId: i + 1, documentTypeId: 1, dossierId: 1, metaDataId: 5, value: 5000,
    }));
    const cursors = createSweepCursors();
    const { prisma, queries } = fakePrisma({
      triggers: {
        'threshold.crossed': [{
          wfTriggerId: 3, definitionId: 8, conditions: { threshold: { metaDataId: 5, op: 'gt', value: 1 } },
        }],
      },
      rows: (q) => (q.sql.includes('d.document_id > ?') ? all.slice(200) : all.slice(0, 200)),
    });
    const emit = jest.fn();
    await runThresholdSweep(prisma, NOW, emit, undefined, cursors);
    expect(cursors.thresholds.get(3)).toBe(200);
    await runThresholdSweep(prisma, NOW, emit, undefined, cursors);
    expect(emit).toHaveBeenCalledTimes(250);
    expect(queries[1]!.values).toContain(200);
    expect(cursors.thresholds.has(3)).toBe(false);
  });

  it('un déclencheur disparu perd son curseur', async () => {
    const cursors = createSweepCursors();
    cursors.deadlines.set(99, { dateButoire: NOW, mailId: 1 });
    const { prisma } = fakePrisma({ triggers: { 'deadline.reached': [] } });
    await runDeadlineSweep(prisma, NOW, jest.fn(), undefined, cursors);
    expect(cursors.deadlines.size).toBe(0);
  });
});
