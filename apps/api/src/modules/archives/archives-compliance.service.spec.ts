import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DocumentState } from '@archivage/types';
import type { PrismaService } from '../prisma/prisma.service';
import { ArchivesComplianceService } from './archives-compliance.service';
import { toIsoDate } from './domain';
import type { ExpiredQueryDto } from './archives.dto';

/** État d'un document tel que la requête de contrôle de l'épuration le relit. */
interface FakeState {
  document_id: number;
  label: string;
  document_state: number;
  /** Résultat de la condition SQL « DUA échue aujourd'hui » (calculée par Postgres). */
  is_due: boolean;
}

const state = (id: number, extra: Partial<FakeState> = {}): FakeState => ({
  document_id: id,
  label: `doc ${id}`,
  document_state: DocumentState.Archive,
  is_due: true,
  ...extra,
});

/**
 * Prisma minimal : `$queryRaw` rend les états connus parmi les identifiants demandés (relus dans
 * les valeurs liées de la requête), `lendingDocumentDetail.findMany` les sorties en cours,
 * `document.updateMany` compte ce qui serait épuré.
 */
function setup(opts: { states?: FakeState[]; lent?: number[] } = {}) {
  const states = opts.states ?? [];
  const queries: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      queries.push(sql);
      // Comptage et page de « DUA expirés » : vides ici, seul leur texte SQL est examiné.
      if (sql.sql.includes('COUNT(*)')) return [{ total: 0n }];
      if (!sql.sql.includes('is_due')) return [];
      // Contrôle de l'épuration : ses valeurs liées sont la coupure (texte) et les identifiants.
      return states.filter((s) => sql.values.includes(s.document_id));
    }),
    lendingDocumentDetail: {
      findMany: jest.fn(async ({ where }: { where: { documentId: { in: number[] } } }) =>
        (opts.lent ?? [])
          .filter((id) => where.documentId.in.includes(id))
          .map((id) => ({ documentId: id, document: { label: `doc ${id}` } })),
      ),
    },
    document: {
      updateMany: jest.fn(async ({ where }: { where: { documentId: { in: number[] } } }) => ({
        count: where.documentId.in.filter(
          (id) => states.find((s) => s.document_id === id)?.document_state !== DocumentState.Epure,
        ).length,
      })),
    },
  };
  return {
    service: new ArchivesComplianceService(prisma as unknown as PrismaService),
    prisma,
    queries,
  };
}

/** Texte SQL sans les variations d'espacement (les marqueurs `?` ne dépendent pas de la position). */
const flat = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, ' ').trim();

describe('ArchivesComplianceService.purge', () => {
  it('épure des documents dont la DUA est échue', async () => {
    const { service, prisma } = setup({ states: [state(1), state(2)] });
    await expect(service.purge([1, 2])).resolves.toEqual({ purged: 2, blocked: [] });
    expect(prisma.document.updateMany).toHaveBeenCalledWith({
      where: { documentId: { in: [1, 2] }, documentState: { not: DocumentState.Epure } },
      data: { documentState: DocumentState.Epure },
    });
  });

  it('ANO-ARC-T3-06 : refuse EN BLOC dès qu’un document n’est pas échu, et nomme les non échus', async () => {
    const { service, prisma } = setup({
      states: [
        state(1),
        state(2, { is_due: false }),
        state(3, { is_due: false, label: 'sans règle' }),
      ],
    });
    await expect(service.purge([1, 2, 3])).rejects.toThrow(
      new ConflictException(
        "Document(s) dont la DUA n'est pas échue : doc 2, sans règle. Aucun document n'a été épuré.",
      ),
    );
    // Rien n'est écrit, pas même le document échu de la même demande.
    expect(prisma.document.updateMany).not.toHaveBeenCalled();
  });

  it('ANO-ARC-T3-06 : la DUA est revérifiée avec la condition de « DUA expirés », à la date du jour', async () => {
    const { service, queries } = setup({ states: [state(1)] });
    await service.listExpired({
      page: 1,
      pageSize: 25,
      sortDirection: 'asc',
      sorting: 'usefulnessLifespan',
      monthsAhead: 0,
    } as ExpiredQueryDto);
    const listQueries = queries.splice(0);
    await service.purge([1]);
    const [check] = queries;

    // Une seule expression, partagée : la liste (comptage et page) et le contrôle la portent.
    const today = toIsoDate(new Date());
    const condition = flat(service['usefulnessDueBy'](today));
    expect(listQueries.length).toBeGreaterThan(0);
    for (const q of [...listQueries, check!]) expect(flat(q)).toContain(condition);
    // Coupure sans anticipation : aujourd'hui (UTC), comme l'horizon « Échu aujourd'hui ».
    expect(check!.values).toContain(today);
  });

  it('un document déjà épuré n’est pas un refus : l’épuration reste idempotente', async () => {
    const { service } = setup({
      states: [state(1, { document_state: DocumentState.Epure, is_due: false })],
    });
    await expect(service.purge([1])).resolves.toEqual({ purged: 0, blocked: [] });
  });

  it('refuse un identifiant inexistant (404), sans rien épurer', async () => {
    const { service, prisma } = setup({ states: [state(1)] });
    await expect(service.purge([1, 99])).rejects.toThrow(
      new NotFoundException('Document(s) introuvable(s) : 99'),
    );
    expect(prisma.document.updateMany).not.toHaveBeenCalled();
  });

  it('un document échu mais encore prêté est conservé et signalé ; les autres sont épurés', async () => {
    const { service, prisma } = setup({ states: [state(1), state(2)], lent: [2] });
    await expect(service.purge([1, 2])).resolves.toEqual({
      purged: 1,
      blocked: [{ documentId: 2, label: 'doc 2' }],
    });
    expect(prisma.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ documentId: { in: [1] } }) }),
    );
  });

  it('dédoublonne les identifiants reçus', async () => {
    const { service, prisma } = setup({ states: [state(1)] });
    await expect(service.purge([1, 1])).resolves.toEqual({ purged: 1, blocked: [] });
    expect(prisma.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ documentId: { in: [1] } }) }),
    );
  });
});
