import { exportSchema, searchSchema } from './search.dto';

/**
 * Contrat d'entrée de `POST /documents/search` et `POST /documents/export`.
 *
 * Les dates du filtre partent telles quelles dans un `::date` PostgreSQL : une date au bon format
 * mais inexistante (« 2026-02-30 ») y faisait échouer la requête, d'où une 500. Elles doivent
 * donc être refusées ici, en 400, comme une plage inversée (ANO-ARC-T2-01).
 */
describe('searchSchema — dates du filtre', () => {
  it('accepte une plage valide et des bornes égales', () => {
    expect(
      searchSchema.safeParse({ documentDateFrom: '2026-01-01', documentDateTo: '2026-12-31' })
        .success,
    ).toBe(true);
    expect(
      searchSchema.safeParse({ documentDateFrom: '2026-03-15', documentDateTo: '2026-03-15' })
        .success,
    ).toBe(true);
  });

  it('accepte une seule borne', () => {
    expect(searchSchema.safeParse({ documentDateFrom: '2026-01-01' }).success).toBe(true);
    expect(searchSchema.safeParse({ documentDateTo: '2026-01-01' }).success).toBe(true);
  });

  it('accepte le 29 février d’une année bissextile', () => {
    expect(searchSchema.safeParse({ documentDateFrom: '2024-02-29' }).success).toBe(true);
  });

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-01-00'])(
    'refuse la date inexistante %s',
    (date) => {
      const res = searchSchema.safeParse({ documentDateFrom: date });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0]?.path).toEqual(['documentDateFrom']);
        expect(res.error.issues[0]?.message).toBe('Date inexistante');
      }
    },
  );

  it('refuse un format autre que AAAA-MM-JJ', () => {
    const res = searchSchema.safeParse({ documentDateTo: '31/12/2026' });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe('Date attendue au format AAAA-MM-JJ');
    }
  });

  it('refuse une plage inversée, en désignant la date de fin', () => {
    const res = searchSchema.safeParse({
      documentDateFrom: '2026-12-31',
      documentDateTo: '2026-01-01',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues).toHaveLength(1);
      expect(res.error.issues[0]?.path).toEqual(['documentDateTo']);
    }
  });

  it('conserve les valeurs par défaut de pagination', () => {
    const res = searchSchema.safeParse({});
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.page).toBe(1);
      expect(res.data.pageSize).toBe(50);
    }
  });
});

describe('exportSchema — mêmes règles que la recherche, plus le format', () => {
  it('accepte une demande valide', () => {
    const res = exportSchema.safeParse({ format: 'csv', documentDateFrom: '2026-01-01' });
    expect(res.success).toBe(true);
  });

  it('refuse une date inexistante et une plage inversée', () => {
    expect(exportSchema.safeParse({ format: 'pdf', documentDateTo: '2026-02-30' }).success).toBe(
      false,
    );
    expect(
      exportSchema.safeParse({
        format: 'xlsx',
        documentDateFrom: '2026-06-02',
        documentDateTo: '2026-06-01',
      }).success,
    ).toBe(false);
  });

  it('refuse un format inconnu ou absent', () => {
    expect(exportSchema.safeParse({ format: 'odt' }).success).toBe(false);
    expect(exportSchema.safeParse({}).success).toBe(false);
  });
});
