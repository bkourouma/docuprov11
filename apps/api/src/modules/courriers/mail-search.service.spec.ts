import { BadRequestException } from '@nestjs/common';
import { MailSearchService } from './mail-search.service';

/** Texte SQL d'un fragment `Prisma.sql` (avec ses valeurs liées, pour inspecter les filtres). */
function sqlOf(arg: unknown): { sql: string; values: unknown[] } {
  const s = arg as { sql?: string; strings?: string[]; values?: unknown[] };
  return { sql: s.sql ?? (s.strings ?? []).join('?'), values: s.values ?? [] };
}

describe('MailSearchService', () => {
  let prisma: { $queryRaw: jest.Mock };
  let service: MailSearchService;

  beforeEach(() => {
    prisma = {
      $queryRaw: jest
        .fn()
        // 1er appel : lignes ; 2e appel : total.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ count: BigInt(0) }]),
    };
    service = new MailSearchService(
      prisma as unknown as ConstructorParameters<typeof MailSearchService>[0],
    );
  });

  describe('bornes de date', () => {
    // Avant correctif : ces valeurs atteignaient le cast `::date` et la base renvoyait une erreur
    // (500). Elles doivent être refusées en 400, sans aucune requête.
    it.each([
      ['dateFrom', 'abc'],
      ['dateFrom', '2026-13-01'],
      ['dateTo', '2026-02-31'],
      ['dateTo', '31/12/2026'],
    ] as const)('refuse %s = %s en 400 sans interroger la base', async (champ, valeur) => {
      await expect(service.search({ [champ]: valeur })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('accepte des jours valides et les transmet comme bornes', async () => {
      const r = await service.search({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });
      expect(r).toEqual({ total: 0, page: 1, pageSize: 25, rows: [] });
      const { sql, values } = sqlOf(prisma.$queryRaw.mock.calls[0][0]);
      expect(sql).toContain('m.mail_date >=');
      expect(sql).toContain('m.mail_date <=');
      expect(values).toEqual(expect.arrayContaining(['2026-01-01', '2026-12-31']));
    });

    it('ignore une borne vide (comportement antérieur conservé)', async () => {
      await service.search({ dateFrom: '', dateTo: '' });
      const { sql } = sqlOf(prisma.$queryRaw.mock.calls[0][0]);
      expect(sql).not.toContain('m.mail_date >=');
    });

    it('ne rejette pas une plage inversée : elle rend simplement un résultat vide', async () => {
      await expect(
        service.search({ dateFrom: '2026-12-31', dateTo: '2026-01-01' }),
      ).resolves.toMatchObject({ total: 0 });
    });
  });

  it('ne porte que sur les courriers archivés et non supprimés (§11)', async () => {
    await service.search({});
    const { sql } = sqlOf(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql).toContain('m.is_deleted = false');
    expect(sql).toContain('m.date_traited IS NOT NULL');
  });
});
