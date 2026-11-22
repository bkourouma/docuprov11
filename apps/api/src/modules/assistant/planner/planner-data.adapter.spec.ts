import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types';
import { AsstPlannerDataAdapter } from './planner-data.adapter';
import { PLANNER_SEARCH_MAX_LIMIT } from './planner.types';

// La rédaction embarque l'éditeur collaboratif (module ESM non transformable par Jest) : on ne charge que le jeton d'injection.
jest.mock('../../drafting/drafting.service', () => ({ DraftingService: class DraftingService {} }));

const USER: AuthUser = { userId: 1, username: 'u1', isAdmin: false, userGroupId: 10 };
const NOW = new Date('2026-11-22T10:00:00Z');

function agentView(mailId: number, documents: number[] = []) {
  return {
    mailId,
    reference: `REF-${mailId}`,
    title: `Courrier ${mailId}`,
    date: '2026-11-01',
    senderLabel: 'Mairie',
    natureLabel: 'Lettre',
    objetLabel: 'Finances',
    confidentialiteLabel: null,
    documents: documents.map((d) => ({ documentId: d, label: `Doc ${d}` })),
    text: 'texte',
  };
}

function build(readable: number[] = [1, 2, 3]) {
  const agentData = {
    readMail: jest.fn(async (_u: AuthUser, id: number) => (readable.includes(id) ? agentView(id, [101, 102, 103, 104]) : null)),
  };
  const catalog = {
    canImpute: jest.fn(async () => true),
    resolveImputableActor: jest.fn(async () => ({ userGroupId: 22, label: 'Awa' })),
    getActiveInputationType: jest.fn(async () => ({ id: 3, label: 'Pour traitement', suivi: true })),
    hasOpenImputation: jest.fn(async () => false),
    countRelances: jest.fn(async () => ({ target: 2, instance: 9 })),
  };
  const imputables = {
    canImpute: jest.fn(async () => true),
    list: jest.fn(async () => [
      { userGroupId: 22, label: 'Awa — DAF', roleId: 4, roleName: 'Directrice', organigrammeLabel: 'Finances', email: 'a@x.fr' },
    ]),
  };
  const mailSearch = {
    search: jest.fn(async () => ({
      total: 4,
      page: 1,
      pageSize: 30,
      rows: [{ mailId: 1 }, { mailId: 9 }, { mailId: 2 }, { mailId: 1 }, { mailId: 3 }],
    })),
  };
  const spaces = { list: jest.fn(async () => [] as unknown[]) };
  const drafting = { generate: jest.fn() };
  const mails = {
    getById: jest.fn(async () => ({
      inputations: [
        {
          mailInputationId: 8,
          userId: 23,
          mailInputationTypeId: 3,
          type: { label: 'Pour traitement' },
          deadline: new Date('2026-11-30T00:00:00Z'),
          dateTreated: null,
          createdBy: 10,
        },
        {
          mailInputationId: 7,
          userId: 22,
          mailInputationTypeId: 3,
          type: { label: 'Pour traitement' },
          deadline: new Date('2026-11-10T00:00:00Z'),
          dateTreated: null,
          createdBy: 11,
        },
        {
          mailInputationId: 9,
          userId: 22,
          mailInputationTypeId: 4,
          type: { label: 'Pour information' },
          deadline: new Date('2026-11-01T00:00:00Z'),
          dateTreated: new Date('2026-11-02T00:00:00Z'),
          createdBy: null,
        },
      ],
    })),
  };
  // Faux client Prisma : lectures seules (aucune méthode d'écriture n'existe).
  const prisma = {
    mailInputationType: {
      findMany: jest.fn(async () => [
        { mailInputationTypeId: 3, label: 'Pour traitement', suivi: true },
        { mailInputationTypeId: 4, label: 'Pour information', suivi: false },
      ]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    appUserGroup: {
      findMany: jest.fn(async () => [
        { userGroupId: 22, group: { name: 'DAF' }, user: { fullName: 'Awa Diallo', firstName: null, lastName: null, isDisabled: false } },
        { userGroupId: 23, group: null, user: { fullName: null, firstName: 'Ali', lastName: 'Sy', isDisabled: true } },
      ]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
  };
  const adapter = new AsstPlannerDataAdapter(
    agentData as never,
    catalog as never,
    imputables as never,
    mailSearch as never,
    spaces as never,
    drafting as never,
    prisma as never,
    mails as never,
  );
  return { adapter, agentData, catalog, imputables, mailSearch, spaces, drafting, mails, prisma };
}

describe('AsstPlannerDataAdapter', () => {
  it('readMail : projette la vue sans les pièces ; refus ou erreur = null', async () => {
    const { adapter, agentData } = build();
    const view = await adapter.readMail(USER, 1, 500);
    expect(view).toMatchObject({ mailId: 1, reference: 'REF-1', senderLabel: 'Mairie', text: 'texte' });
    expect(view).not.toHaveProperty('documents');
    expect(agentData.readMail).toHaveBeenCalledWith(USER, 1, 500);
    expect(await adapter.readMail(USER, 77, 500)).toBeNull();
    agentData.readMail.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.readMail(USER, 1, 500)).toBeNull();
    expect(await adapter.readMail({ ...USER, userGroupId: null }, 1, 500)).toBeNull();
    expect(await adapter.readMail({ ...USER, isScanAgent: true }, 1, 500)).toBeNull();
  });

  it('searchMails : filtre chaque résultat par le droit de lecture, dédoublonne, borne', async () => {
    const { adapter, agentData, mailSearch } = build([1, 2, 3]);
    const hits = await adapter.searchMails(USER, 'subvention', 2);
    expect(hits.map((h) => h.mailId)).toEqual([1, 2]); // 9 refusé, doublon écarté, borne 2
    expect(agentData.readMail).toHaveBeenCalledWith(USER, 9, 0);
    expect(mailSearch.search).toHaveBeenCalledWith(expect.objectContaining({ fullText: 'subvention', pageSize: 6 }));
    const all = await adapter.searchMails(USER, 'x', 1000);
    expect(all.map((h) => h.mailId)).toEqual([1, 2, 3]);
    expect(mailSearch.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageSize: Math.min(30, PLANNER_SEARCH_MAX_LIMIT * 3) }),
    );
  });

  it('searchMails : requête vide ou erreur = liste vide', async () => {
    const { adapter, mailSearch } = build();
    expect(await adapter.searchMails(USER, '   ', 5)).toEqual([]);
    expect(mailSearch.search).not.toHaveBeenCalled();
    mailSearch.search.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.searchMails(USER, 'a', 5)).toEqual([]);
  });

  it('listActors : projection sans e-mail, filtre transmis, limite bornée', async () => {
    const { adapter, imputables } = build();
    const actors = await adapter.listActors(USER, { search: 'DAF', limit: 500 });
    expect(actors).toEqual([{ userGroupId: 22, label: 'Awa — DAF', roleName: 'Directrice', organigrammeLabel: 'Finances' }]);
    expect(imputables.list).toHaveBeenCalledWith(USER, { search: 'DAF', limit: PLANNER_SEARCH_MAX_LIMIT });
    imputables.list.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.listActors(USER, { limit: 5 })).toEqual([]);
  });

  it('listInputationTypes : types actifs lus en lecture seule', async () => {
    const { adapter, prisma } = build();
    expect(await adapter.listInputationTypes()).toEqual([
      { id: 3, label: 'Pour traitement', suivi: true },
      { id: 4, label: 'Pour information', suivi: false },
    ]);
    expect(prisma.mailInputationType.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true } }));
    prisma.mailInputationType.findMany.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.listInputationTypes()).toEqual([]);
  });

  it('canImpute, resolveImputableActor, getActiveInputationType : délèguent au catalogue, échec fermé', async () => {
    const { adapter, catalog } = build();
    expect(await adapter.canImpute(USER)).toBe(true);
    expect(await adapter.resolveImputableActor(USER, 22)).toEqual({ userGroupId: 22, label: 'Awa' });
    expect(await adapter.resolveImputableActor(USER, 0)).toBeNull();
    expect(await adapter.getActiveInputationType(3)).toEqual({ id: 3, label: 'Pour traitement', suivi: true });
    catalog.canImpute.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.canImpute(USER)).toBe(false);
    catalog.resolveImputableActor.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.resolveImputableActor(USER, 22)).toBeNull();
    catalog.getActiveInputationType.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.getActiveInputationType(3)).toBeNull();
  });

  it('listInputations : courrier illisible = null', async () => {
    const { adapter, mails } = build([1]);
    expect(await adapter.listInputations(USER, 2, NOW, 10)).toBeNull();
    expect(mails.getById).not.toHaveBeenCalled();
    mails.getById.mockRejectedValueOnce(new NotFoundException());
    expect(await adapter.listInputations(USER, 1, NOW, 10)).toBeNull();
  });

  it('listInputations : libellés « Nom — Groupe », retard, traité, actif, ordre et borne', async () => {
    const { adapter } = build();
    const rows = await adapter.listInputations(USER, 1, NOW, 10);
    expect(rows?.map((r) => r.mailInputationId)).toEqual([7, 8, 9]);
    expect(rows?.[0]).toMatchObject({
      actorLabel: 'Awa Diallo — DAF',
      actorActive: true,
      typeLabel: 'Pour traitement',
      late: true,
      treated: false,
      createdBy: 11,
    });
    // échéance future : pas en retard ; compte désactivé : inactif ; libellé sans groupe
    expect(rows?.[1]).toMatchObject({ actorLabel: 'Ali Sy', actorActive: false, late: false });
    // échéance dépassée mais traitée : pas en retard
    expect(rows?.[2]).toMatchObject({ treated: true, late: false, createdBy: null });
    expect(await adapter.listInputations(USER, 1, NOW, 1)).toHaveLength(1);
  });

  it('readInputation : trouve l’imputation du courrier, sinon null', async () => {
    const { adapter } = build();
    expect(await adapter.readInputation(USER, 1, 7, NOW)).toMatchObject({ mailInputationId: 7, mailId: 1, late: true });
    expect(await adapter.readInputation(USER, 1, 999, NOW)).toBeNull();
    expect(await adapter.readInputation(USER, 77, 7, NOW)).toBeNull();
  });

  it('hasOpenImputation et countTargetRelancesToday : catalogue ; erreur = repli qui bloque', async () => {
    const { adapter, catalog } = build();
    expect(await adapter.hasOpenImputation(1, 22, 3)).toBe(false);
    expect(await adapter.countTargetRelancesToday(1, 22, NOW)).toBe(2);
    expect(catalog.countRelances).toHaveBeenCalledWith(1, 22, null, NOW);
    catalog.hasOpenImputation.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.hasOpenImputation(1, 22, 3)).toBe(true);
    catalog.countRelances.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.countTargetRelancesToday(1, 22, NOW)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('listDraftTemplates : id et libellé seulement', () => {
    const { adapter } = build();
    const t = adapter.listDraftTemplates();
    expect(t.length).toBeGreaterThan(0);
    for (const x of t) expect(Object.keys(x).sort()).toEqual(['id', 'label']);
  });

  it('listWritableSpaces : seulement les espaces actifs où l’on peut contribuer (échec fermé)', async () => {
    const { adapter, spaces } = build();
    const s = (id: number, myAccess: unknown, isActive = true) => ({ gedSpaceId: id, label: `E${id}`, myAccess, isActive });
    spaces.list.mockResolvedValueOnce([
      s(1, 'owner'),
      s(2, 0), // lecture
      s(3, 1), // contribution
      s(4, 2), // gestion
      s(5, null), // lecture seule (administrateur, publication)
      s(6, 1, false), // inactif
      s(7, undefined),
      s(8, 'autre'),
    ]);
    expect((await adapter.listWritableSpaces(USER, 10)).map((x) => x.spaceId)).toEqual([1, 3, 4]);
    spaces.list.mockResolvedValueOnce([s(1, 'owner'), s(3, 1), s(4, 2)]);
    expect(await adapter.listWritableSpaces(USER, 2)).toEqual([
      { spaceId: 1, label: 'E1' },
      { spaceId: 3, label: 'E3' },
    ]);
    spaces.list.mockRejectedValueOnce(new Error('boom'));
    expect(await adapter.listWritableSpaces(USER, 5)).toEqual([]);
  });

  describe('generateDraft', () => {
    const req = { templateId: 'note', instruction: 'Rédige une réponse', mailId: 1 };

    it('succès : contexte limité à 3 pièces du courrier', async () => {
      const { adapter, drafting } = build();
      drafting.generate.mockResolvedValueOnce({ disabled: false, draftHtml: '<p>ok</p>', decisionId: '42', contextDocumentCount: 3 });
      const r = await adapter.generateDraft(USER, req, 10);
      expect(r).toEqual({ status: 'ok', draftHtml: '<p>ok</p>', decisionId: '42' });
      expect(drafting.generate).toHaveBeenCalledWith(
        { templateId: 'note', instruction: 'Rédige une réponse', contextDocumentIds: [101, 102, 103] },
        USER,
      );
    });

    it('sans mailId : aucun contexte de courrier', async () => {
      const { adapter, drafting, agentData } = build();
      drafting.generate.mockResolvedValueOnce({ disabled: false, draftHtml: '<p>ok</p>', decisionId: null, contextDocumentCount: 0 });
      await adapter.generateDraft(USER, { templateId: 'note', instruction: 'x' }, 10);
      expect(agentData.readMail).not.toHaveBeenCalled();
      expect(drafting.generate).toHaveBeenCalledWith({ templateId: 'note', instruction: 'x' }, USER);
    });

    it('IA désactivée : status disabled', async () => {
      const { adapter, drafting } = build();
      drafting.generate.mockResolvedValueOnce({ disabled: true, message: 'IA désactivée' });
      expect(await adapter.generateDraft(USER, req, 10)).toEqual({ status: 'disabled', message: 'IA désactivée' });
    });

    it('exceptions HTTP et inattendues : refused avec message français générique, sans contenu', async () => {
      const { adapter, drafting } = build();
      for (const err of [new ForbiddenException('SECRET'), new NotFoundException('SECRET'), new BadRequestException('SECRET'), new Error('SECRET')]) {
        drafting.generate.mockRejectedValueOnce(err);
        const r = await adapter.generateDraft(USER, req, 10);
        expect(r.status).toBe('refused');
        expect((r as { message: string }).message).toMatch(/^Brouillon refusé|^Génération/);
        expect(JSON.stringify(r)).not.toContain('SECRET');
      }
    });

    it('courrier illisible : refused sans appeler la rédaction', async () => {
      const { adapter, drafting } = build([]);
      const r = await adapter.generateDraft(USER, req, 10);
      expect(r.status).toBe('refused');
      expect(drafting.generate).not.toHaveBeenCalled();
    });
  });

  it('n’écrit jamais : le faux Prisma n’expose que des lectures', () => {
    const { prisma } = build();
    for (const model of Object.values(prisma)) {
      for (const method of Object.keys(model)) {
        expect(['findMany', 'findUnique', 'findFirst', 'count']).toContain(method);
      }
    }
  });
});
