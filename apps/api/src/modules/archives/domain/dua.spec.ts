import {
  addMonths,
  computeDueDates,
  expiryCutoff,
  isExpired,
  lifeCycleStartDate,
  toIsoDate,
} from './dua';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('addMonths', () => {
  it('avance du nombre de mois demandé', () => {
    expect(toIsoDate(addMonths(utc('2026-01-15'), 3))).toBe('2026-04-15');
  });

  it('écrête sur le dernier jour du mois cible (sémantique Postgres, pas de débordement)', () => {
    // `new Date(2026, 0, 31).setMonth(1)` donnerait le 3 mars — c'est précisément ce qu'on évite.
    expect(toIsoDate(addMonths(utc('2026-01-31'), 1))).toBe('2026-02-28');
    expect(toIsoDate(addMonths(utc('2024-01-31'), 1))).toBe('2024-02-29'); // année bissextile
    expect(toIsoDate(addMonths(utc('2026-03-31'), 1))).toBe('2026-04-30');
  });

  it('franchit les années', () => {
    expect(toIsoDate(addMonths(utc('2026-11-10'), 14))).toBe('2028-01-10');
  });

  it('accepte 0 mois (échéance immédiate)', () => {
    expect(toIsoDate(addMonths(utc('2026-07-31'), 0))).toBe('2026-07-31');
  });
});

describe('lifeCycleStartDate', () => {
  it('part de la date métier du document quand elle existe', () => {
    const start = lifeCycleStartDate({
      documentDate: utc('2020-05-04'),
      createdAt: new Date('2026-07-31T09:00:00.000Z'),
    });
    expect(toIsoDate(start)).toBe('2020-05-04');
  });

  it("retombe sur la date de création quand le document n'a pas de date métier", () => {
    const start = lifeCycleStartDate({
      documentDate: null,
      createdAt: new Date('2026-07-31T23:30:00.000Z'),
    });
    expect(toIsoDate(start)).toBe('2026-07-31');
  });
});

describe('computeDueDates', () => {
  it('dérive les deux échéances de la règle du type', () => {
    const dates = computeDueDates(utc('2020-01-01'), {
      usefulnessLifespan: 60,
      complianceLifespan: 120,
    });
    expect(toIsoDate(dates.usefulnessLifespan)).toBe('2025-01-01');
    expect(toIsoDate(dates.complianceLifespan)).toBe('2030-01-01');
  });
});

describe('isExpired', () => {
  it('est expiré le jour même de l’échéance (comparaison inclusive)', () => {
    expect(isExpired(utc('2026-07-31'), utc('2026-07-31'))).toBe(true);
  });

  it("n'est pas expiré la veille", () => {
    expect(isExpired(utc('2026-07-31'), utc('2026-07-30'))).toBe(false);
  });
});

describe('expiryCutoff', () => {
  it('sans anticipation, la coupure est la date du jour', () => {
    expect(toIsoDate(expiryCutoff(new Date('2026-07-31T18:00:00.000Z'), 0))).toBe('2026-07-31');
  });

  it("avec anticipation, la coupure ouvre une fenêtre vers l'avenir", () => {
    expect(toIsoDate(expiryCutoff(new Date('2026-07-31T18:00:00.000Z'), 3))).toBe('2026-10-31');
  });
});
