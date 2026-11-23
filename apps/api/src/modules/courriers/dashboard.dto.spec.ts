import { dashboardFilterSchema, repartitionFilterSchema } from './dashboard.dto';

describe('dashboardFilterSchema — bornes de période', () => {
  it('accepte un jour calendaire valide', () => {
    const r = dashboardFilterSchema.safeParse({ dateFrom: '2026-02-28', dateTo: '2024-02-29' });
    expect(r.success).toBe(true);
  });

  // Avant correctif : la regex seule laissait passer ces valeurs, et le service tombait en 500
  // (`toISOString()` sur une date invalide) ou décalait silencieusement la borne.
  it.each(['2026-13-01', '2026-00-10', '2026-02-31', '2025-02-29', '2026-04-31'])(
    'refuse le jour inexistant %s (400 et non 500)',
    (jour) => {
      expect(dashboardFilterSchema.safeParse({ dateFrom: jour }).success).toBe(false);
      expect(dashboardFilterSchema.safeParse({ dateTo: jour }).success).toBe(false);
    },
  );

  it('refuse toujours un format autre que AAAA-MM-JJ', () => {
    expect(dashboardFilterSchema.safeParse({ dateFrom: '01/02/2026' }).success).toBe(false);
  });

  it('applique la même règle au filtre de répartition', () => {
    expect(
      repartitionFilterSchema.safeParse({ dimension: 'type', dateFrom: '2026-13-01' }).success,
    ).toBe(false);
    expect(
      repartitionFilterSchema.safeParse({ dimension: 'type', dateFrom: '2026-01-31' }).success,
    ).toBe(true);
  });
});
