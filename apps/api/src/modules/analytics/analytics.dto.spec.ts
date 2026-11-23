import {
  agencementSchema,
  analyticsExportSchema,
  analyticsFilterSchema,
  analyticsTargetsSchema,
} from './analytics.dto';

/**
 * Validation des corps de `POST /analytics/overview|targets|export`. Le point critique est la date :
 * une date de bonne FORME mais inexistante passait le contrôle et faisait échouer le service en 500
 * (RangeError de `toISOString()` pour `2026-13-45`, refus du cast `::date` par PostgreSQL pour
 * `2026-02-30`). Elle doit désormais être refusée proprement (400 via le ZodValidationPipe).
 */
describe('analytics.dto', () => {
  describe('analyticsFilterSchema — dates', () => {
    it.each(['2026-01-31', '2024-02-29', '2026-12-01'])('accepte la date civile %s', (d) => {
      expect(analyticsFilterSchema.safeParse({ dateFrom: d, dateTo: d }).success).toBe(true);
    });

    it.each([
      ['mois 13', '2026-13-45'],
      ['mois 00', '2026-00-10'],
      ['30 février', '2026-02-30'],
      ['29 février d’une année non bissextile', '2026-02-29'],
      ['31 avril', '2026-04-31'],
      ['jour 00', '2026-05-00'],
    ])('refuse une date inexistante (%s : %s)', (_libelle, d) => {
      expect(analyticsFilterSchema.safeParse({ dateFrom: d }).success).toBe(false);
      expect(analyticsFilterSchema.safeParse({ dateTo: d }).success).toBe(false);
    });

    it.each(['2026-1-05', '26-01-05', '2026/01/05', '2026-01-05T00:00:00Z', ''])(
      'refuse une forme non ISO (%s)',
      (d) => {
        expect(analyticsFilterSchema.safeParse({ dateFrom: d }).success).toBe(false);
      },
    );

    it('garde les défauts quand aucune borne n’est fournie', () => {
      const r = analyticsFilterSchema.parse({});
      expect(r).toEqual({ granularity: 'day', basis: 'created_at' });
    });
  });

  it('applique la même règle de date à l’export et aux cibles', () => {
    expect(analyticsExportSchema.safeParse({ format: 'csv', dateFrom: '2026-02-30' }).success).toBe(
      false,
    );
    expect(analyticsExportSchema.safeParse({ format: 'csv', dateFrom: '2026-02-28' }).success).toBe(
      true,
    );
    expect(analyticsTargetsSchema.safeParse({ periodStart: '2026-02-30' }).success).toBe(false);
    expect(analyticsTargetsSchema.safeParse({ periodStart: '2026-02-01' }).success).toBe(true);
  });

  it('refuse un format d’export inconnu', () => {
    expect(analyticsExportSchema.safeParse({ format: 'html' }).success).toBe(false);
  });

  describe('agencementSchema', () => {
    it('refuse une clé inattendue (objet strict)', () => {
      expect(
        agencementSchema.safeParse({
          widgets: [{ id: 'kpis', x: 0, y: 0, w: 12, h: 5, titre: 'x' }],
        }).success,
      ).toBe(false);
    });

    it('refuse plus de 50 widgets', () => {
      const widgets = Array.from({ length: 51 }, (_, i) => ({
        id: `w${i}`,
        x: 0,
        y: i,
        w: 1,
        h: 1,
      }));
      expect(agencementSchema.safeParse({ widgets }).success).toBe(false);
    });
  });
});
