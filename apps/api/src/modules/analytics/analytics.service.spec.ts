import { Prisma } from '@prisma/client';
import {
  AnalyticsService,
  type DistributionSlice,
  type KpiBlock,
  type TimelinePoint,
} from './analytics.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * Tests de la logique de mise en forme du service (cumul de série, mapping des
 * KPIs, Top N + « Autres », calcul « objectif vs réalisé »). Les requêtes SQL
 * sont mockées : on valide le traitement TypeScript appliqué aux lignes brutes,
 * pas le SQL lui-même (zéro-fill via generate_series, etc., relève d'un test e2e).
 */

// Accès typé aux méthodes privées (instrospection de test, sans `any`).
interface Internals {
  queryKpis(p: unknown, u: AuthUser, from: string, to: string): Promise<KpiBlock>;
  queryTimeline(p: unknown, u: AuthUser, from: string, to: string): Promise<TimelinePoint[]>;
  queryDistribution(
    p: unknown,
    u: AuthUser,
    opts: { join: Prisma.Sql; label: Prisma.Sql; noneLabel: string; top?: number },
  ): Promise<DistributionSlice[]>;
}
const internals = (s: AnalyticsService): Internals => s as unknown as Internals;

describe('AnalyticsService', () => {
  // Admin → aclCond renvoie null (bypass ACL), ce qui simplifie les requêtes mockées.
  const admin = { isAdmin: true, userGroupId: 1 } as unknown as AuthUser;
  let prisma: { $queryRaw: jest.Mock };
  let service: AnalyticsService;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn() };
    service = new AnalyticsService(prisma as never);
  });

  describe('queryKpis', () => {
    it('mappe les compteurs et calcule le taux d’indexation', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            total: 100,
            archived: 60,
            pending: 40,
            frozen: 5,
            period: 20,
            prev: 10,
            index_complete: 80,
            sans_type: 5,
            sans_dossier: 3,
            sans_date: 2,
            sans_cote: 1,
          },
        ])
        .mockResolvedValueOnce([{ pages: 500, bytes: BigInt(123456) }]);

      const kpis = await internals(service).queryKpis(
        { basis: 'created_at' },
        admin,
        '2026-06-01',
        '2026-06-30',
      );

      expect(kpis).toMatchObject({
        totalDocuments: 100,
        documentsArchived: 60,
        documentsPending: 40,
        documentsFrozen: 5,
        totalPages: 500,
        totalBytes: 123456,
        periodDocuments: 20,
        previousPeriodDocuments: 10,
        indexationRate: 0.8,
        anomalies: { sansType: 5, sansDossier: 3, sansDate: 2, sansCote: 1 },
      });
    });

    it('renvoie un taux d’indexation nul quand il n’y a aucun document', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { total: 0, archived: 0, pending: 0, frozen: 0, period: 0, prev: 0, index_complete: 0, sans_type: 0, sans_dossier: 0, sans_date: 0, sans_cote: 0 },
        ])
        .mockResolvedValueOnce([{ pages: 0, bytes: BigInt(0) }]);

      const kpis = await internals(service).queryKpis(
        { basis: 'created_at' },
        admin,
        '2026-06-01',
        '2026-06-30',
      );
      expect(kpis.indexationRate).toBe(0);
    });
  });

  describe('queryTimeline', () => {
    it('cumule la production sur la baseline du fonds existant', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ baseline: 10 }]) // fonds avant la fenêtre
        .mockResolvedValueOnce([
          { bucket: '2026-06-01', count: 2 },
          { bucket: '2026-06-02', count: 0 }, // période sans donnée (zéro-fill SQL)
          { bucket: '2026-06-03', count: 3 },
        ]);

      const timeline = await internals(service).queryTimeline(
        { granularity: 'day', basis: 'created_at' },
        admin,
        '2026-06-01',
        '2026-06-03',
      );

      expect(timeline).toEqual([
        { bucket: '2026-06-01', count: 2, cumulative: 12 },
        { bucket: '2026-06-02', count: 0, cumulative: 12 },
        { bucket: '2026-06-03', count: 3, cumulative: 15 },
      ]);
    });
  });

  describe('queryDistribution', () => {
    it('garde le Top 8, agrège le reste en « Autres » et conserve la tranche sans valeur en fin', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { name: 'A', value: 50 },
        { name: 'B', value: 40 },
        { name: 'C', value: 30 },
        { name: 'D', value: 20 },
        { name: 'E', value: 10 },
        { name: 'F', value: 9 },
        { name: 'G', value: 8 },
        { name: 'H', value: 7 },
        { name: 'I', value: 6 },
        { name: 'J', value: 5 },
        { name: '— Sans type —', value: 3 },
      ]);

      const out = await internals(service).queryDistribution({}, admin, {
        join: Prisma.empty,
        label: Prisma.raw('dt.label'),
        noneLabel: '— Sans type —',
      });

      expect(out).toHaveLength(10); // 8 nommés + « Autres » + « Sans type »
      expect(out.slice(0, 8).map((s) => s.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
      expect(out[8]).toEqual({ name: 'Autres', value: 11 }); // I(6) + J(5)
      expect(out[9]).toEqual({ name: '— Sans type —', value: 3 });
    });
  });

  describe('targets', () => {
    it('calcule le réalisé et l’avancement par cible (sans plafonner le %)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { target_id: 1, scope: 'global', scope_ref_id: null, metric: 'documents', period_kind: 'month', period_start: '2026-06-01', target_value: 500, scope_label: 'Global' },
          { target_id: 2, scope: 'type', scope_ref_id: 7, metric: 'pages', period_kind: 'month', period_start: '2026-06-01', target_value: 1000, scope_label: 'Factures' },
        ])
        .mockResolvedValueOnce([{ v: 250 }]) // réalisé cible 1 (documents)
        .mockResolvedValueOnce([{ v: 1500 }]); // réalisé cible 2 (pages) — dépasse la cible

      const rows = await service.targets({ periodKind: 'month' } as never, admin);

      expect(rows).toEqual([
        { targetId: 1, scope: 'global', scopeRefId: null, scopeLabel: 'Global', metric: 'documents', periodKind: 'month', periodStart: '2026-06-01', targetValue: 500, realized: 250, progressPct: 50 },
        { targetId: 2, scope: 'type', scopeRefId: 7, scopeLabel: 'Factures', metric: 'pages', periodKind: 'month', periodStart: '2026-06-01', targetValue: 1000, realized: 1500, progressPct: 150 },
      ]);
    });

    it('renvoie une liste vide quand aucune cible n’est définie', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      const rows = await service.targets({ periodKind: 'month' } as never, admin);
      expect(rows).toEqual([]);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // pas de calcul de réalisé
    });
  });
});
