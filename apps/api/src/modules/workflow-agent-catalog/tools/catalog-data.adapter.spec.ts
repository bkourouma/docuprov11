import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types';
import type { MailSearchService } from '../../courriers/mail-search.service';
import type { MailsService } from '../../courriers/mails.service';
import type { DocumentsService } from '../../documents/documents.service';
import type { DraftingService } from '../../drafting/drafting.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { AgentBlockedError, type WfAgentGate } from '../../workflow-agents/agent.contracts';
import type { AgentDataAdapter } from '../../workflow-agents/tools/agent-data.adapter';
import type { ImputableActorsPort } from '../catalog.contracts';
import { CatalogDataAdapter, buildSimilarityQuery, delayInDays } from './catalog-data.adapter';

// DraftingService tire l'éditeur collaboratif (ESM) : inutile ici, le service est entièrement simulé.
jest.mock('../../drafting/drafting.service', () => ({ DraftingService: class DraftingService {} }));

const user: AuthUser = { userId: 5, username: 'u', isAdmin: false, userGroupId: 50 };
const NOW = new Date('2026-11-21T12:00:00Z');

function build() {
  const prisma = {
    appUserGroup: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([{ userGroupId: 7, user: { fullName: 'Awa Diallo', username: 'awa' } }]),
    },
    mailInputationType: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    mailInputation: { count: jest.fn() },
    notification: { count: jest.fn() },
    $queryRaw: jest.fn(),
    wfInstance: { findUnique: jest.fn() },
    document: { findMany: jest.fn().mockResolvedValue([]) },
    documentMetadataValue: { findMany: jest.fn().mockResolvedValue([]) },
    mailDocument: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const mails = { getById: jest.fn() };
  const mailSearch = { search: jest.fn() };
  const documents = { canAccess: jest.fn(async (id: number) => id === 1) };
  const drafting = { generate: jest.fn() };
  const agentData = {
    readMail: jest.fn(async (_u: AuthUser, id: number) =>
      id === 100 || id === 201
        ? { mailId: id, reference: `R-${id}`, title: 'Demande de subvention annuelle', date: '2025-05-01', natureLabel: 'Demande', documents: [{ documentId: 1, label: 'A' }] }
        : null,
    ),
  };
  const imputables: jest.Mocked<ImputableActorsPort> = {
    canImpute: jest.fn().mockResolvedValue(true),
    isImputable: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
  };
  const gate = {
    assertRunnable: jest.fn().mockResolvedValue(undefined),
    reserve: jest.fn().mockResolvedValue({ id: 'r1', definitionId: 3, reserved: { promptTokens: 1, completionTokens: 1, cost: 0 } }),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    costOf: jest.fn().mockReturnValue(0.5),
  };
  const adapter = new CatalogDataAdapter(
    prisma as unknown as PrismaService,
    mails as unknown as MailsService,
    mailSearch as unknown as MailSearchService,
    documents as unknown as DocumentsService,
    drafting as unknown as DraftingService,
    agentData as unknown as AgentDataAdapter,
    imputables,
    gate as unknown as WfAgentGate,
  );
  return { adapter, prisma, mails, mailSearch, documents, drafting, agentData, imputables, gate };
}

describe('CatalogDataAdapter.findSimilarMails', () => {
  it('filtre CHAQUE résultat par la règle de droits du lanceur et exclut le courrier source', async () => {
    const { adapter, mailSearch, mails, agentData } = build();
    mailSearch.search.mockResolvedValue({
      total: 3, page: 1, pageSize: 15,
      rows: [{ mailId: 100 }, { mailId: 201 }, { mailId: 999 }], // 100 = source ; 999 = interdit au lanceur
    });
    mails.getById.mockResolvedValue({
      inputations: [
        { mailInputationId: 1, userId: 7, mailInputationTypeId: 10, type: { label: 'Pour Suivi' }, createdAt: new Date('2025-05-01T00:00:00Z'), deadline: new Date('2025-05-06T00:00:00Z'), dateTreated: new Date('2025-05-04T00:00:00Z'), instructions: 'SECRET' },
      ],
    });
    const out = await adapter.findSimilarMails(user, 100, 5);
    expect(out?.map((m) => m.mailId)).toEqual([201]);
    expect(agentData.readMail).toHaveBeenCalledWith(user, 999, 1); // droits vérifiés avant d'exposer
    expect(mails.getById).toHaveBeenCalledWith(201, user, true); // chaîne d'imputations restreinte
    expect(mails.getById).not.toHaveBeenCalledWith(999, expect.anything(), expect.anything());
    expect(out?.[0].imputations).toEqual([
      { mailInputationId: 1, actorUserGroupId: 7, actorLabel: 'Awa Diallo', typeId: 10, typeLabel: 'Pour Suivi', delayDays: 5, treated: true },
    ]);
    expect(JSON.stringify(out)).not.toContain('SECRET'); // instructions libres jamais renvoyées
  });

  it('source illisible : null, sans lancer de recherche', async () => {
    const { adapter, mailSearch } = build();
    expect(await adapter.findSimilarMails(user, 404, 5)).toBeNull();
    expect(mailSearch.search).not.toHaveBeenCalled();
  });

  it('borne le nombre de résultats au limit', async () => {
    const { adapter, mailSearch, mails } = build();
    mailSearch.search.mockResolvedValue({ total: 2, page: 1, pageSize: 6, rows: [{ mailId: 201 }, { mailId: 201 }] });
    mails.getById.mockResolvedValue({ inputations: [] });
    const out = await adapter.findSimilarMails(user, 100, 1);
    expect(out).toHaveLength(1);
  });

  it('requête de similarité : mots significatifs seulement, bornés', () => {
    expect(buildSimilarityQuery('Demande de subvention annuelle 2026 pour la mairie')).toBe('subvention or annuelle or mairie');
    expect(buildSimilarityQuery('de la')).toBeNull();
    expect(buildSimilarityQuery(null)).toBeNull();
  });

  it('délai en jours : échéance - création, arrondi au jour supérieur', () => {
    expect(delayInDays(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-06T10:00:00Z'))).toBe(6);
    expect(delayInDays(new Date('2026-01-01T00:00:00Z'), null)).toBeNull();
  });
});

describe('CatalogDataAdapter : relances et imputations', () => {
  it('countRelances : plafond par destinataire (notification) et par instance (journal), instance nulle = 0', async () => {
    const { adapter, prisma } = build();
    prisma.notification.count.mockResolvedValue(1);
    prisma.$queryRaw.mockResolvedValue([{ n: 3n }]);
    expect(await adapter.countRelances(200, 7, '9', NOW)).toEqual({ target: 1, instance: 3 });
    const where = prisma.notification.count.mock.calls[0][0].where;
    expect(where).toMatchObject({ recipientUserGroupId: 7, targetType: 'mail', targetId: 200, message: { startsWith: 'Relance : ' } });
    expect(where.createdAt.gte.toISOString()).toBe('2026-11-21T00:00:00.000Z');
    prisma.$queryRaw.mockClear();
    expect(await adapter.countRelances(200, 7, null, NOW)).toEqual({ target: 1, instance: 0 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('readInputation : null si courrier illisible ; imputation d’un autre courrier ignorée', async () => {
    const { adapter, mails, prisma } = build();
    mails.getById.mockResolvedValue({
      inputations: [{ mailInputationId: 300, userId: 7, type: { label: 'Pour Suivi' }, deadline: null, dateTreated: null, createdBy: 10 }],
    });
    prisma.appUserGroup.findUnique.mockResolvedValue({ user: { fullName: 'Awa Diallo', username: 'awa', isDisabled: false } });
    expect(await adapter.readInputation(user, 404, 300)).toBeNull();
    expect(await adapter.readInputation(user, 201, 999)).toBeNull();
    const ok = await adapter.readInputation(user, 201, 300);
    expect(ok).toMatchObject({ mailInputationId: 300, userGroupId: 7, actorLabel: 'Awa Diallo', actorActive: true, createdBy: 10 });
  });

  it('resolveImputableActor : droit d’imputer, imputable, compte actif ; tout échec = null', async () => {
    const { adapter, prisma, imputables } = build();
    prisma.appUserGroup.findUnique.mockResolvedValue({ user: { fullName: 'Awa Diallo', username: 'awa', isDisabled: false } });
    expect(await adapter.resolveImputableActor(user, 7)).toEqual({ userGroupId: 7, label: 'Awa Diallo' });
    imputables.isImputable.mockResolvedValue(false);
    expect(await adapter.resolveImputableActor(user, 7)).toBeNull();
    imputables.isImputable.mockResolvedValue(true);
    imputables.canImpute.mockResolvedValue(false);
    expect(await adapter.resolveImputableActor(user, 7)).toBeNull();
    imputables.canImpute.mockResolvedValue(true);
    prisma.appUserGroup.findUnique.mockResolvedValue({ user: { fullName: null, username: 'awa', isDisabled: true } });
    expect(await adapter.resolveImputableActor(user, 7)).toBeNull();
    expect(await adapter.resolveImputableActor(user, -1)).toBeNull();
  });

  it('readImputables : aucun champ de connexion, types actifs seulement', async () => {
    const { adapter, prisma, imputables } = build();
    prisma.mailInputationType.findMany.mockResolvedValue([{ mailInputationTypeId: 10, label: 'Pour Suivi', suivi: true }]);
    imputables.list.mockResolvedValue([
      { userGroupId: 7, label: 'Awa', roleId: 1, roleName: 'Chef', organigrammeLabel: 'Direction', email: 'a@x.org' } as never,
    ]);
    const out = await adapter.readImputables(user, { limit: 20 });
    expect(prisma.mailInputationType.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
    expect(out.actors).toEqual([{ userGroupId: 7, label: 'Awa', roleName: 'Chef', organigrammeLabel: 'Direction' }]);
    imputables.canImpute.mockResolvedValue(false);
    expect((await adapter.readImputables(user, { limit: 20 })).actors).toEqual([]);
  });
});

describe('CatalogDataAdapter : pièces', () => {
  it('readPieceFields : seules les pièces accessibles sont lues (les autres omises)', async () => {
    const { adapter, prisma, documents } = build();
    prisma.document.findMany.mockResolvedValue([
      { documentId: 1, label: 'Facture', documentDate: new Date('2026-03-12T00:00:00Z'), cote: null, documentType: null, versions: [] },
    ]);
    prisma.documentMetadataValue.findMany.mockResolvedValue([
      { documentId: 1, value: '1 000,00', metaData: { label: 'Montant TTC' }, metaDataListItem: null },
      { documentId: 1, value: 'x', metaData: { label: 'Couleur' }, metaDataListItem: null },
    ]);
    const out = await adapter.readPieceFields(user, [1, 2, 3]);
    expect(documents.canAccess).toHaveBeenCalledTimes(3);
    expect(prisma.document.findMany.mock.calls[0][0].where.documentId).toEqual({ in: [1] });
    expect(out).toEqual([
      {
        documentId: 1,
        label: 'Facture',
        values: {
          montant: { raw: '1 000,00', evidence: 'Montant TTC : 1 000,00' },
          date: { raw: '2026-03-12', evidence: 'Date du document : 2026-03-12' },
        },
      },
    ]);
  });

  it('readPieceFields : compte machine ou aucun accès : liste vide, sans requête', async () => {
    const { adapter, prisma } = build();
    expect(await adapter.readPieceFields({ ...user, isScanAgent: true }, [1])).toEqual([]);
    expect(await adapter.readPieceFields(user, [2, 3])).toEqual([]);
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });

  it('listPieces : courrier illisible ou document interdit : null', async () => {
    const { adapter } = build();
    expect(await adapter.listPieces(user, { mailId: 404 }, 30)).toBeNull();
    expect(await adapter.listPieces(user, { documentId: 2 }, 30)).toBeNull();
  });

  it('listPieces (dossier) : filtre par canAccess ; aucun accessible : null', async () => {
    const { adapter, prisma } = build();
    prisma.document.findMany
      .mockResolvedValueOnce([{ documentId: 1 }, { documentId: 2 }])
      .mockResolvedValueOnce([
        { documentId: 1, label: 'Facture', documentDate: null, cote: 'C1', documentType: { label: 'Facture' }, versions: [{ files: [{ pageCount: 2 }, { pageCount: 5 }] }] },
      ]);
    const out = await adapter.listPieces(user, { dossierId: 9 }, 30);
    expect(out).toEqual([
      { documentId: 1, label: 'Facture', documentTypeLabel: 'Facture', documentDate: null, cote: 'C1', pageCount: 5, metadataExcerpt: null },
    ]);
    prisma.document.findMany.mockReset();
    prisma.document.findMany.mockResolvedValueOnce([{ documentId: 2 }]);
    expect(await adapter.listPieces(user, { dossierId: 9 }, 30)).toBeNull();
  });
});

describe('CatalogDataAdapter.readDeclaredDelegates', () => {
  const graph = (config: unknown) => ({
    definitionVersion: {
      graph: {
        schemaVersion: 1,
        start: 'agent1',
        steps: [{ key: 'agent1', name: 'Agent', type: 'agent', config, next: [] }],
      },
    },
  });

  it('lit step.config.delegates de l’étape courante, schéma strict', async () => {
    const { adapter, prisma } = build();
    prisma.wfInstance.findUnique.mockResolvedValue(graph({ delegates: [{ userGroupId: 8, forUserGroupId: 7 }] }));
    const out = await adapter.readDeclaredDelegates('9', 'agent1');
    expect(out).toEqual([{ userGroupId: 8, forUserGroupId: 7 }]);
    expect(prisma.wfInstance.findUnique.mock.calls[0][0].where).toEqual({ wfInstanceId: 9n });
  });

  it('invalide, absent, étape inconnue ou identifiant illisible : aucun délégataire', async () => {
    const { adapter, prisma } = build();
    prisma.wfInstance.findUnique.mockResolvedValue(graph({ delegates: [{ userGroupId: 8, autre: 1 }] }));
    expect(await adapter.readDeclaredDelegates('9', 'agent1')).toEqual([]);
    prisma.wfInstance.findUnique.mockResolvedValue(graph(undefined));
    expect(await adapter.readDeclaredDelegates('9', 'agent1')).toEqual([]);
    prisma.wfInstance.findUnique.mockResolvedValue(graph({ delegates: [{ userGroupId: 8 }] }));
    expect(await adapter.readDeclaredDelegates('9', 'autre')).toEqual([]);
    expect(await adapter.readDeclaredDelegates('abc', 'agent1')).toEqual([]);
    prisma.wfInstance.findUnique.mockResolvedValue(null);
    expect(await adapter.readDeclaredDelegates('9', 'agent1')).toEqual([]);
  });
});

describe('CatalogDataAdapter.generateDraft (budget)', () => {
  const request = { templateId: 'lettre-reponse', instruction: 'Rédige' };

  it('réserve avant, règle après, avec l’utilisateur lanceur', async () => {
    const { adapter, prisma, drafting, gate } = build();
    prisma.wfInstance.findUnique.mockResolvedValue({ definitionId: 3 });
    drafting.generate.mockResolvedValue({ disabled: false, draftHtml: '<p>x</p>', draftText: 'x', decisionId: '55', contextDocumentCount: 1 });
    const out = await adapter.generateDraft(user, request, '9');
    expect(out).toEqual({ status: 'ok', draftHtml: '<p>x</p>', decisionId: '55', contextDocumentCount: 1 });
    expect(gate.reserve).toHaveBeenCalledWith({ definitionId: 3 }, expect.objectContaining({ promptTokens: 4000 }));
    expect(drafting.generate).toHaveBeenCalledWith(request, user);
    expect(gate.settle).toHaveBeenCalledTimes(1);
    expect(gate.release).not.toHaveBeenCalled();
  });

  it('IA désactivée : réservation libérée, statut disabled', async () => {
    const { adapter, prisma, drafting, gate } = build();
    prisma.wfInstance.findUnique.mockResolvedValue({ definitionId: 3 });
    drafting.generate.mockResolvedValue({ disabled: true, message: 'IA désactivée' });
    expect(await adapter.generateDraft(user, request, '9')).toEqual({ status: 'disabled', message: 'IA désactivée' });
    expect(gate.release).toHaveBeenCalledTimes(1);
    expect(gate.settle).not.toHaveBeenCalled();
  });

  it('échec de génération : réservation libérée ; erreur HTTP = refus en français, autre erreur remontée', async () => {
    const { adapter, prisma, drafting, gate } = build();
    prisma.wfInstance.findUnique.mockResolvedValue({ definitionId: 3 });
    drafting.generate.mockRejectedValueOnce(new BadRequestException('La consigne est vide.'));
    expect(await adapter.generateDraft(user, request, '9')).toEqual({ status: 'refused', message: 'La consigne est vide.' });
    expect(gate.release).toHaveBeenCalledTimes(1);
    drafting.generate.mockRejectedValueOnce(new Error('boom'));
    await expect(adapter.generateDraft(user, request, '9')).rejects.toThrow('boom');
    expect(gate.release).toHaveBeenCalledTimes(2);
  });

  it('budget dépassé ou IA désactivée côté garde : aucun appel de génération', async () => {
    const { adapter, prisma, drafting, gate } = build();
    prisma.wfInstance.findUnique.mockResolvedValue({ definitionId: 3 });
    gate.reserve.mockRejectedValueOnce(new AgentBlockedError('budget_exceeded_workflow', 'Plafond de budget atteint.'));
    expect(await adapter.generateDraft(user, request, '9')).toEqual({ status: 'refused', message: 'Plafond de budget atteint.' });
    gate.assertRunnable.mockRejectedValueOnce(new AgentBlockedError('ai_disabled', 'IA désactivée.'));
    expect(await adapter.generateDraft(user, request, '9')).toEqual({ status: 'disabled', message: 'IA désactivée.' });
    expect(drafting.generate).not.toHaveBeenCalled();
  });

  it('instance inconnue ou nulle : refus, aucune réservation', async () => {
    const { adapter, prisma, gate } = build();
    expect((await adapter.generateDraft(user, request, null)).status).toBe('refused');
    prisma.wfInstance.findUnique.mockResolvedValue(null);
    expect((await adapter.generateDraft(user, request, '9')).status).toBe('refused');
    expect(gate.reserve).not.toHaveBeenCalled();
  });

  it('le modèle est cherché dans le catalogue statique (8 modèles), inconnu : null', async () => {
    const { adapter } = build();
    expect((await adapter.getDraftTemplate('lettre-reponse'))?.id).toBe('lettre-reponse');
    expect(await adapter.getDraftTemplate('inconnu')).toBeNull();
  });
});
