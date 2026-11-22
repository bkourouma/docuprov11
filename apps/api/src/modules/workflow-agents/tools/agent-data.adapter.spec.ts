import { NotFoundException } from '@nestjs/common';
import { MailStatus, MailType } from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import type { MailsService } from '../../courriers/mails.service';
import type { DocumentsService } from '../../documents/documents.service';
import type { DraftingContextService } from '../../drafting/drafting-context.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SemanticSearchService } from '../../semantic-search/semantic-search.service';
import { AgentDataAdapter } from './agent-data.adapter';

const user: AuthUser = { userId: 5, username: 'u', isAdmin: false, userGroupId: 50 };
const admin: AuthUser = { userId: 1, username: 'a', isAdmin: true, userGroupId: 10 };

function mailRow(over: Record<string, unknown> = {}) {
  return {
    mailId: 12,
    mailType: MailType.Arrivee,
    status: MailStatus.Redaction + 1,
    reference: 'ARR-1',
    title: 'Objet',
    description: 'Texte du courrier '.repeat(10),
    date: new Date('2026-03-04T00:00:00Z'),
    externalEntity: { label: 'Société X' },
    nature: { label: 'Demande' },
    objet: { label: 'Information' },
    confidentialite: null,
    destinataireExpediteur: null,
    destinataireRoleId: null,
    inputations: [],
    documents: [
      { document: { documentId: 1, label: 'Autorisé' } },
      { document: { documentId: 2, label: 'Interdit' } },
    ],
    ...over,
  };
}

function build() {
  const prisma = {
    appUserGroup: { findUnique: jest.fn() },
    appUser: { findUnique: jest.fn().mockResolvedValue({ confidentialite: { rank: 2 } }) },
    confidentialite: { findFirst: jest.fn() },
    role: { findUnique: jest.fn() },
  };
  const search = { search: jest.fn() };
  const drafting = { load: jest.fn() };
  const mails = { mailScope: jest.fn().mockResolvedValue('all'), getById: jest.fn() };
  const documents = { canAccess: jest.fn(async (id: number) => id === 1) };
  const adapter = new AgentDataAdapter(
    prisma as unknown as PrismaService,
    search as unknown as SemanticSearchService,
    drafting as unknown as DraftingContextService,
    mails as unknown as MailsService,
    documents as unknown as DocumentsService,
  );
  return { adapter, prisma, search, drafting, mails, documents };
}

describe('AgentDataAdapter.searchDocuments', () => {
  it('délègue à la recherche AVEC l’utilisateur lanceur, dédoublonne et borne', async () => {
    const { adapter, search } = build();
    search.search.mockResolvedValue({
      mode: 'semantic',
      hits: [
        { documentId: 1, documentLabel: 'A', excerpt: 'e1' },
        { documentId: 1, documentLabel: 'A', excerpt: 'e1bis' },
        { documentId: 2, documentLabel: 'B', excerpt: 'e2' },
      ],
    });
    const out = await adapter.searchDocuments(user, 'contrat', 2);
    expect(search.search).toHaveBeenCalledWith({ query: 'contrat', limit: 2 }, user);
    expect(out).toEqual([
      { documentId: 1, label: 'A', excerpt: 'e1' },
      { documentId: 2, label: 'B', excerpt: 'e2' },
    ]);
  });

  it('identité machine ou sans acteur : rien, sans appeler la recherche', async () => {
    const { adapter, search } = build();
    expect(await adapter.searchDocuments({ ...user, isScanAgent: true }, 'x', 3)).toEqual([]);
    expect(await adapter.searchDocuments({ ...user, userGroupId: null }, 'x', 3)).toEqual([]);
    expect(search.search).not.toHaveBeenCalled();
  });
});

describe('AgentDataAdapter.readDocument', () => {
  const ctxDoc = {
    marker: 1, label: 'Contrat', documentTypeLabel: 'Contrat', documentDate: '2026-01-02', cote: 'C1',
    overview: 'Résumé', dossierLabel: 'Dossier secret', excerpts: ['a'.repeat(50), 'b'.repeat(50)],
  };

  it('charge via DraftingContextService avec l’utilisateur, borne le texte, n’expose pas le dossier', async () => {
    const { adapter, drafting } = build();
    drafting.load.mockResolvedValue([ctxDoc]);
    const out = await adapter.readDocument(user, 9, 60);
    expect(drafting.load).toHaveBeenCalledWith({ contextDocumentIds: [9] }, user);
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('dossierLabel');
    const total = Array.from(out?.overview ?? '').length + (out?.excerpts ?? []).reduce((n, e) => n + Array.from(e).length, 0);
    expect(total).toBeLessThanOrEqual(60);
    expect(out?.documentId).toBe(9);
  });

  it('404 (canAccess faux, inexistant, épuré) => null', async () => {
    const { adapter, drafting } = build();
    drafting.load.mockRejectedValue(new NotFoundException('Document introuvable'));
    await expect(adapter.readDocument(user, 9, 100)).resolves.toBeNull();
  });

  it('une autre erreur est relancée (échec fermé côté appelant)', async () => {
    const { adapter, drafting } = build();
    drafting.load.mockRejectedValue(new Error('base indisponible'));
    await expect(adapter.readDocument(user, 9, 100)).rejects.toThrow('base indisponible');
  });

  it('identité machine => null sans lecture', async () => {
    const { adapter, drafting } = build();
    await expect(adapter.readDocument({ ...user, isScanAgent: true }, 9, 100)).resolves.toBeNull();
    expect(drafting.load).not.toHaveBeenCalled();
  });
});

describe('AgentDataAdapter.readMail', () => {
  it('périmètre none => null, sans lire le courrier', async () => {
    const { adapter, mails } = build();
    mails.mailScope.mockResolvedValue('none');
    await expect(adapter.readMail(user, 12, 100)).resolves.toBeNull();
    expect(mails.getById).not.toHaveBeenCalled();
  });

  it('périmètre all : lisible, texte borné, pièces filtrées par canAccess', async () => {
    const { adapter, mails, documents } = build();
    mails.getById.mockResolvedValue(mailRow());
    const out = await adapter.readMail(user, 12, 20);
    expect(mails.getById).toHaveBeenCalledWith(12, user, true);
    expect(out).toMatchObject({
      mailId: 12, reference: 'ARR-1', title: 'Objet', date: '2026-03-04', senderLabel: 'Société X',
      natureLabel: 'Demande', objetLabel: 'Information', confidentialiteLabel: null,
      documents: [{ documentId: 1, label: 'Autorisé' }],
    });
    expect(Array.from(out?.text ?? '').length).toBeLessThanOrEqual(20);
    expect(documents.canAccess).toHaveBeenCalledWith(2, user);
  });

  it('courrier introuvable (404) => null', async () => {
    const { adapter, mails } = build();
    mails.getById.mockRejectedValue(new NotFoundException('Courrier introuvable'));
    await expect(adapter.readMail(user, 12, 100)).resolves.toBeNull();
  });

  it('départ encore en rédaction => null ; arrivée en rédaction => lisible', async () => {
    const { adapter, mails } = build();
    mails.getById.mockResolvedValue(mailRow({ mailType: MailType.Depart, status: MailStatus.Redaction }));
    await expect(adapter.readMail(user, 12, 100)).resolves.toBeNull();
    mails.getById.mockResolvedValue(mailRow({ mailType: MailType.Arrivee, status: MailStatus.Redaction }));
    await expect(adapter.readMail(user, 12, 100)).resolves.not.toBeNull();
  });

  describe('périmètre imputed', () => {
    it('imputation adressée à l’acteur => lisible', async () => {
      const { adapter, mails } = build();
      mails.mailScope.mockResolvedValue('imputed');
      mails.getById.mockResolvedValue(mailRow({ inputations: [{ userId: 50 }] }));
      await expect(adapter.readMail(user, 12, 100)).resolves.not.toBeNull();
    });

    it('imputation d’un autre acteur, pas destinataire => null', async () => {
      const { adapter, mails } = build();
      mails.mailScope.mockResolvedValue('imputed');
      mails.getById.mockResolvedValue(mailRow({ inputations: [{ userId: 99 }], destinataireExpediteur: 77 }));
      await expect(adapter.readMail(user, 12, 100)).resolves.toBeNull();
    });

    it('destinataire nommé => lisible', async () => {
      const { adapter, mails } = build();
      mails.mailScope.mockResolvedValue('imputed');
      mails.getById.mockResolvedValue(mailRow({ destinataireExpediteur: 50 }));
      await expect(adapter.readMail(user, 12, 100)).resolves.not.toBeNull();
    });

    it('destinataire-rôle : porteur du rôle => lisible, autre rôle => null', async () => {
      const { adapter, mails, prisma } = build();
      mails.mailScope.mockResolvedValue('imputed');
      mails.getById.mockResolvedValue(mailRow({ destinataireRoleId: 4 }));
      prisma.appUserGroup.findUnique.mockResolvedValue({ user: { roleId: 4 } });
      await expect(adapter.readMail(user, 12, 100)).resolves.not.toBeNull();
      prisma.appUserGroup.findUnique.mockResolvedValue({ user: { roleId: 8 } });
      await expect(adapter.readMail(user, 12, 100)).resolves.toBeNull();
    });
  });

  describe('confidentialité', () => {
    it('rang utilisateur >= rang requis => lisible', async () => {
      const { adapter, mails, prisma } = build();
      mails.getById.mockResolvedValue(mailRow({ confidentialite: { label: 'Confidentiel' } }));
      prisma.confidentialite.findFirst.mockResolvedValue({ rank: 2 });
      await expect(adapter.readMail(user, 12, 100)).resolves.toMatchObject({ confidentialiteLabel: 'Confidentiel' });
    });

    it('rang utilisateur insuffisant => null', async () => {
      const { adapter, mails, prisma } = build();
      mails.getById.mockResolvedValue(mailRow({ confidentialite: { label: 'Secret' } }));
      prisma.confidentialite.findFirst.mockResolvedValue({ rank: 3 });
      await expect(adapter.readMail(user, 12, 100)).resolves.toBeNull();
    });

    it('utilisateur sans niveau => null', async () => {
      const { adapter, mails, prisma } = build();
      mails.getById.mockResolvedValue(mailRow({ confidentialite: { label: 'Confidentiel' } }));
      prisma.confidentialite.findFirst.mockResolvedValue({ rank: 0 });
      prisma.appUser.findUnique.mockResolvedValue({ confidentialite: null });
      await expect(adapter.readMail(user, 12, 100)).resolves.toBeNull();
    });

    it('niveau de courrier sans équivalent documentaire => null (échec fermé)', async () => {
      const { adapter, mails, prisma } = build();
      mails.getById.mockResolvedValue(mailRow({ confidentialite: { label: 'Inconnu' } }));
      prisma.confidentialite.findFirst.mockResolvedValue(null);
      await expect(adapter.readMail(user, 12, 100)).resolves.toBeNull();
    });

    it('administrateur exclu du contrôle', async () => {
      const { adapter, mails, prisma } = build();
      mails.getById.mockResolvedValue(mailRow({ confidentialite: { label: 'Secret' } }));
      await expect(adapter.readMail(admin, 12, 100)).resolves.not.toBeNull();
      expect(prisma.confidentialite.findFirst).not.toHaveBeenCalled();
    });
  });
});

describe('AgentDataAdapter.targetExists', () => {
  it('user : acteur actif seulement', async () => {
    const { adapter, prisma } = build();
    prisma.appUserGroup.findUnique.mockResolvedValue({ user: { isDisabled: false } });
    await expect(adapter.targetExists('user', 7)).resolves.toBe(true);
    prisma.appUserGroup.findUnique.mockResolvedValue({ user: { isDisabled: true } });
    await expect(adapter.targetExists('user', 7)).resolves.toBe(false);
    prisma.appUserGroup.findUnique.mockResolvedValue(null);
    await expect(adapter.targetExists('user', 7)).resolves.toBe(false);
  });

  it('role : rôle actif seulement ; identifiant invalide => false', async () => {
    const { adapter, prisma } = build();
    prisma.role.findUnique.mockResolvedValue({ isActive: true });
    await expect(adapter.targetExists('role', 3)).resolves.toBe(true);
    prisma.role.findUnique.mockResolvedValue({ isActive: false });
    await expect(adapter.targetExists('role', 3)).resolves.toBe(false);
    await expect(adapter.targetExists('role', 0)).resolves.toBe(false);
  });
});
