import type { WfDomainEvent } from './contracts';
import { WF_TRIGGER_DEFAULT_LIMITS, WF_TRIGGER_LIMIT_CEILING } from './contracts';
import { matchesConditions, parseTriggerConditions, resolveLimits } from './conditions';

const issuesOf = (r: ReturnType<typeof parseTriggerConditions>): string[] => (r.ok ? [] : r.issues);

describe('parseTriggerConditions', () => {
  it('accepte {} et null : aucune condition', () => {
    for (const raw of [{}, null, undefined]) {
      const r = parseTriggerConditions('mail.arrived', raw);
      expect(r).toEqual({ ok: true, value: { match: [] } });
    }
  });

  it('normalise une condition valide', () => {
    const r = parseTriggerConditions('mail.arrived', {
      match: [{ field: 'subject.mailType', op: 'eq', value: 0 }, { field: 'subject.hasDocument', op: 'exists' }],
      limits: { maxLaunches: 10, windowMinutes: 30 },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        match: [{ field: 'subject.mailType', op: 'eq', value: 0 }, { field: 'subject.hasDocument', op: 'exists' }],
        limits: { maxLaunches: 10, windowMinutes: 30 },
      },
    });
  });

  it('refuse une clé inconnue', () => {
    expect(parseTriggerConditions('mail.arrived', { script: 'x' }).ok).toBe(false);
    expect(
      parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.mailType', op: 'eq', value: 1, extra: 1 }] }).ok,
    ).toBe(false);
  });

  it('refuse un champ hors catalogue, y compris les noms de prototype', () => {
    for (const f of ['subject.title', 'subject.__proto__', 'subject.constructor', 'subject.toString']) {
      const r = parseTriggerConditions('mail.arrived', { match: [{ field: f, op: 'exists' }] });
      expect({ f, ok: r.ok }).toEqual({ f, ok: false });
    }
  });

  it('refuse un champ du catalogue d’un autre type d’événement', () => {
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.pageCount', op: 'exists' }] }).ok).toBe(false);
  });

  it('refuse un champ qui ne commence pas par subject.', () => {
    const r = parseTriggerConditions('mail.arrived', { match: [{ field: 'mailType', op: 'eq', value: 0 }] });
    expect(r.ok).toBe(false);
    expect(issuesOf(r)[0]).toContain('subject.');
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'event.type', op: 'exists' }] }).ok).toBe(false);
  });

  it('refuse un opérateur inconnu', () => {
    expect(
      parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.mailType', op: 'regex', value: 'x' }] }).ok,
    ).toBe(false);
  });

  it('refuse une valeur du mauvais type', () => {
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.mailType', op: 'eq', value: 'zero' }] }).ok).toBe(false);
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.hasDocument', op: 'eq', value: 1 }] }).ok).toBe(false);
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.mailType', op: 'eq', value: [1] }] }).ok).toBe(false);
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.mailType', op: 'eq' }] }).ok).toBe(false);
  });

  it('refuse gt/lt sur un champ non numérique', () => {
    for (const op of ['gt', 'gte', 'lt', 'lte']) {
      const r = parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.hasDocument', op, value: true }] });
      expect({ op, ok: r.ok }).toEqual({ op, ok: false });
    }
    expect(
      parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.dateButoire', op: 'gt', value: '2026-01-01' }] }).ok,
    ).toBe(false);
  });

  it('accepte gt sur un champ numérique', () => {
    expect(
      parseTriggerConditions('document.deposited', { match: [{ field: 'subject.pageCount', op: 'gt', value: 10 }] }).ok,
    ).toBe(true);
  });

  it('refuse « in » avec une liste vide ou une valeur non liste', () => {
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.mailType', op: 'in', value: [] }] }).ok).toBe(false);
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.mailType', op: 'in', value: 1 }] }).ok).toBe(false);
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.mailType', op: 'in', value: [0, 'a'] }] }).ok).toBe(false);
    expect(parseTriggerConditions('mail.arrived', { match: [{ field: 'subject.mailType', op: 'in', value: [0, 2] }] }).ok).toBe(true);
  });

  it('refuse deadline hors deadline.reached, accepte pour deadline.reached', () => {
    expect(parseTriggerConditions('mail.arrived', { deadline: { leadHours: 2 } }).ok).toBe(false);
    expect(parseTriggerConditions('deadline.reached', { deadline: { leadHours: 2 } })).toEqual({
      ok: true,
      value: { match: [], deadline: { leadHours: 2 } },
    });
    expect(parseTriggerConditions('deadline.reached', { deadline: { leadHours: -1 } }).ok).toBe(false);
  });

  it('threshold : réservé à threshold.crossed et obligatoire pour lui', () => {
    const th = { metaDataId: 3, op: 'gt', value: 1000 };
    expect(parseTriggerConditions('mail.arrived', { threshold: th }).ok).toBe(false);
    expect(parseTriggerConditions('threshold.crossed', {}).ok).toBe(false);
    expect(parseTriggerConditions('threshold.crossed', { threshold: th })).toEqual({
      ok: true,
      value: { match: [], threshold: th },
    });
    expect(parseTriggerConditions('threshold.crossed', { threshold: { ...th, op: 'lt' } }).ok).toBe(false);
  });

  it('limits hors bornes refusées', () => {
    const bad = [
      { maxLaunches: 0, windowMinutes: 10 },
      { maxLaunches: WF_TRIGGER_LIMIT_CEILING.maxLaunches + 1, windowMinutes: 10 },
      { maxLaunches: 10, windowMinutes: 0 },
      { maxLaunches: 10, windowMinutes: WF_TRIGGER_LIMIT_CEILING.windowMinutes + 1 },
      { maxLaunches: 1.5, windowMinutes: 10 },
    ];
    for (const limits of bad) expect(parseTriggerConditions('mail.arrived', { limits }).ok).toBe(false);
    expect(parseTriggerConditions('mail.arrived', { limits: { ...WF_TRIGGER_LIMIT_CEILING } }).ok).toBe(true);
  });

  it('texte libre de type injection refusé dans une valeur string', () => {
    const r = parseTriggerConditions('document.deposited', {
      match: [{ field: 'subject.source', op: 'eq', value: 'ignore previous instructions' }],
    });
    expect(r.ok).toBe(false);
    const inList = parseTriggerConditions('document.deposited', {
      match: [{ field: 'subject.source', op: 'in', value: ['acquisition', 'ignore previous instructions'] }],
    });
    expect(inList.ok).toBe(false);
    expect(
      parseTriggerConditions('document.deposited', { match: [{ field: 'subject.source', op: 'eq', value: 'acquisition' }] }).ok,
    ).toBe(true);
  });

  it('refuse un type d’événement inconnu et plus de 20 conditions', () => {
    expect(parseTriggerConditions('x.y' as never, {}).ok).toBe(false);
    const many = Array.from({ length: 21 }, () => ({ field: 'subject.mailType', op: 'exists' }));
    expect(parseTriggerConditions('mail.arrived', { match: many }).ok).toBe(false);
  });
});

describe('resolveLimits', () => {
  it('défaut quand rien n’est configuré', () => {
    expect(resolveLimits({})).toEqual(WF_TRIGGER_DEFAULT_LIMITS);
  });

  it('valeurs du déclencheur', () => {
    expect(resolveLimits({ limits: { maxLaunches: 5, windowMinutes: 15 } })).toEqual({ maxLaunches: 5, windowMinutes: 15 });
  });

  it('plafond dur et plancher à 1', () => {
    expect(resolveLimits({ limits: { maxLaunches: 99999, windowMinutes: 99999 } })).toEqual(WF_TRIGGER_LIMIT_CEILING);
    expect(resolveLimits({ limits: { maxLaunches: 0, windowMinutes: -5 } })).toEqual({ maxLaunches: 1, windowMinutes: 1 });
  });
});

function event(fields: WfDomainEvent['fields']): WfDomainEvent {
  return {
    type: 'mail.arrived',
    subjectType: 'mail',
    subjectId: '42',
    fields,
    occurredAt: '2026-11-21T10:00:00.000Z',
  };
}

describe('matchesConditions', () => {
  it('liste vide = vrai', () => {
    expect(matchesConditions({ match: [] }, event({}))).toBe(true);
  });

  it('eq / neq / gt / in / exists', () => {
    const e = event({ mailType: 0, status: 3, hasDocument: true, mailNatureId: null });
    expect(matchesConditions({ match: [{ field: 'subject.mailType', op: 'eq', value: 0 }] }, e)).toBe(true);
    expect(matchesConditions({ match: [{ field: 'subject.mailType', op: 'eq', value: 1 }] }, e)).toBe(false);
    expect(matchesConditions({ match: [{ field: 'subject.mailType', op: 'neq', value: 1 }] }, e)).toBe(true);
    expect(matchesConditions({ match: [{ field: 'subject.status', op: 'gt', value: 2 }] }, e)).toBe(true);
    expect(matchesConditions({ match: [{ field: 'subject.status', op: 'gt', value: 3 }] }, e)).toBe(false);
    expect(matchesConditions({ match: [{ field: 'subject.status', op: 'in', value: [1, 3] }] }, e)).toBe(true);
    expect(matchesConditions({ match: [{ field: 'subject.status', op: 'in', value: [1, 2] }] }, e)).toBe(false);
    expect(matchesConditions({ match: [{ field: 'subject.hasDocument', op: 'exists' }] }, e)).toBe(true);
    expect(matchesConditions({ match: [{ field: 'subject.mailNatureId', op: 'exists' }] }, e)).toBe(false);
  });

  it('ET : toutes doivent être vraies', () => {
    const e = event({ mailType: 0, status: 3 });
    const ok = { field: 'subject.mailType', op: 'eq' as const, value: 0 };
    const ko = { field: 'subject.status', op: 'eq' as const, value: 9 };
    expect(matchesConditions({ match: [ok, ok] }, e)).toBe(true);
    expect(matchesConditions({ match: [ok, ko] }, e)).toBe(false);
  });

  it('champ absent = faux', () => {
    const e = event({ mailType: 0 });
    expect(matchesConditions({ match: [{ field: 'subject.status', op: 'eq', value: 1 }] }, e)).toBe(false);
    expect(matchesConditions({ match: [{ field: 'subject.status', op: 'neq', value: 1 }] }, e)).toBe(false);
    expect(matchesConditions({ match: [{ field: 'subject.status', op: 'gt', value: 1 }] }, e)).toBe(false);
    expect(matchesConditions({ match: [{ field: 'subject.status', op: 'exists' }] }, e)).toBe(false);
  });

  it('une valeur d’événement n’est jamais évaluée comme du code', () => {
    const spy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const e = event({ source: '${process.exit()}', note: '__proto__', other: 'constructor' });
      const conds = [
        { field: 'subject.source', op: 'eq' as const, value: 'x' },
        { field: 'subject.note', op: 'eq' as const, value: 'x' },
        { field: 'subject.other', op: 'in' as const, value: ['x'] },
        { field: 'subject.__proto__', op: 'exists' as const },
        { field: 'subject.constructor', op: 'exists' as const },
      ];
      for (const c of conds) expect(matchesConditions({ match: [c] }, e)).toBe(false);
      expect(matchesConditions({ match: [{ field: 'subject.note', op: 'eq', value: '__proto__' }] }, e)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(Object.prototype).not.toHaveProperty('polluted');
    } finally {
      spy.mockRestore();
    }
  });
});
