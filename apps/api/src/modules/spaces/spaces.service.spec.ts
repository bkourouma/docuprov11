import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import 'reflect-metadata';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import type { AuthUser } from '../auth/auth.types';
import { SpacesController } from './spaces.controller';
import { SPACES_MENU } from './spaces.menus';
import { NOT_ARCHIVED_MESSAGE, SpacesService } from './spaces.service';

// ---------------------------------------------------------------------------------------------
// Faux Prisma EN MÉMOIRE : il applique réellement les filtres que le service construit (membres
// visant l'acteur, listing), pour que les tests éprouvent la logique d'accès et non des réponses
// préfabriquées. Toutes les données sont fictives.
// ---------------------------------------------------------------------------------------------

interface UserFx {
  userId: number;
  username: string;
  fullName: string;
  isDisabled: boolean;
  roleId: number | null;
  lastName: string;
  firstName: string;
}
interface GroupFx {
  userGroupId: number;
  userId: number;
  isDefault: boolean;
}
interface RoleFx {
  roleId: number;
  name: string;
  isActive: boolean;
}
interface SpaceFx {
  gedSpaceId: number;
  label: string;
  description: string | null;
  kind: number;
  ownerUserGroupId: number;
  publicationSlug: string | null;
  publishedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
interface MemberFx {
  gedSpaceMemberId: number;
  spaceId: number;
  userGroupId: number | null;
  roleId: number | null;
  permission: number;
  addedBy: number | null;
  addedAt: Date;
}
interface LinkFx {
  spaceId: number;
  documentId: number;
  addedBy: number | null;
  addedAt: Date;
}
interface DocFx {
  documentId: number;
  label: string;
  documentDate: Date | null;
  confidentialiteId: number | null;
  typeLabel: string | null;
  /** Absent : archivé (validé). `false` : document en attente (ex. pièce de l'éditeur). */
  isArchived?: boolean;
}

type Where = Record<string, unknown>;
const T0 = new Date('2026-10-01T08:00:00.000Z');

function matchMember(m: MemberFx, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as Where[]).some((w) => matchMember(m, w))) return false;
    } else if (k === 'AND') {
      if (!(v as Where[]).every((w) => matchMember(m, w))) return false;
    } else if (v && typeof v === 'object' && 'in' in (v as Where)) {
      if (!((v as { in: unknown[] }).in as unknown[]).includes((m as unknown as Where)[k]))
        return false;
    } else if ((m as unknown as Where)[k] !== v) {
      return false;
    }
  }
  return true;
}

class FakeDb {
  users: UserFx[] = [];
  groups: GroupFx[] = [];
  roles: RoleFx[] = [];
  spaces: SpaceFx[] = [];
  members: MemberFx[] = [];
  links: LinkFx[] = [];
  docs: DocFx[] = [];
  private seq = 1000;

  private matchSpace = (s: SpaceFx, where: Where): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') {
        if (!(v as Where[]).some((w) => this.matchSpace(s, w))) return false;
      } else if (k === 'NOT') {
        if (this.matchSpace(s, v as Where)) return false;
      } else if (k === 'members') {
        const some = (v as { some: Where }).some;
        if (!this.members.some((m) => m.spaceId === s.gedSpaceId && matchMember(m, some)))
          return false;
      } else if (v && typeof v === 'object' && 'in' in (v as Where)) {
        if (!(v as { in: unknown[] }).in.includes((s as unknown as Where)[k])) return false;
      } else if (v && typeof v === 'object' && 'startsWith' in (v as Where)) {
        const val = (s as unknown as Where)[k];
        if (typeof val !== 'string' || !val.startsWith((v as { startsWith: string }).startsWith))
          return false;
      } else if ((s as unknown as Where)[k] !== v) {
        return false;
      }
    }
    return true;
  };

  private spaceRow(s: SpaceFx, select: { members?: { where?: Where } }) {
    const ownerGroup = this.groups.find((g) => g.userGroupId === s.ownerUserGroupId);
    const ownerUser = this.users.find((u) => u.userId === ownerGroup?.userId);
    return {
      ...s,
      owner: { user: { fullName: ownerUser?.fullName ?? null } },
      members: this.members
        .filter((m) => m.spaceId === s.gedSpaceId && matchMember(m, select.members?.where))
        .map((m) => ({ userGroupId: m.userGroupId, roleId: m.roleId, permission: m.permission })),
      _count: {
        documents: this.links.filter((l) => l.spaceId === s.gedSpaceId).length,
        members: this.members.filter((m) => m.spaceId === s.gedSpaceId).length,
      },
    };
  }

  private memberRow(m: MemberFx) {
    const g = this.groups.find((x) => x.userGroupId === m.userGroupId);
    const u = this.users.find((x) => x.userId === g?.userId);
    const r = this.roles.find((x) => x.roleId === m.roleId);
    return {
      gedSpaceMemberId: m.gedSpaceMemberId,
      userGroupId: m.userGroupId,
      roleId: m.roleId,
      permission: m.permission,
      addedAt: m.addedAt,
      userGroup: u ? { user: { fullName: u.fullName, username: u.username } } : null,
      role: r ? { name: r.name } : null,
    };
  }

  private linkRow(l: LinkFx) {
    const d = this.docs.find((x) => x.documentId === l.documentId) as DocFx;
    return {
      addedAt: l.addedAt,
      document: {
        documentId: d.documentId,
        label: d.label,
        documentDate: d.documentDate,
        confidentialiteId: d.confidentialiteId,
        documentType: d.typeLabel ? { label: d.typeLabel } : null,
      },
    };
  }

  private findLink(key: { spaceId: number; documentId: number }) {
    return this.links.find((l) => l.spaceId === key.spaceId && l.documentId === key.documentId);
  }

  client() {
    return {
      document: {
        findUnique: jest.fn(async ({ where }: { where: { documentId: number } }) => {
          const d = this.docs.find((x) => x.documentId === where.documentId);
          return d ? { isArchived: d.isArchived ?? true } : null;
        }),
      },
      appUserGroup: {
        findMany: jest.fn(async ({ where }: { where: { userId: number } }) =>
          this.groups
            .filter((g) => g.userId === where.userId)
            .map((g) => ({ userGroupId: g.userGroupId })),
        ),
        findUnique: jest.fn(async ({ where }: { where: { userGroupId: number } }) => {
          const g = this.groups.find((x) => x.userGroupId === where.userGroupId);
          const u = this.users.find((x) => x.userId === g?.userId);
          return g && u ? { user: { isDisabled: u.isDisabled } } : null;
        }),
      },
      appUser: {
        findUnique: jest.fn(async ({ where }: { where: { userId: number } }) => {
          const u = this.users.find((x) => x.userId === where.userId);
          if (!u) return null;
          const r = this.roles.find((x) => x.roleId === u.roleId);
          return {
            isDisabled: u.isDisabled,
            roleId: u.roleId,
            role: r ? { isActive: r.isActive } : null,
          };
        }),
        findMany: jest.fn(async () =>
          this.users
            .filter((u) => !u.isDisabled)
            .map((u) => ({
              username: u.username,
              fullName: u.fullName,
              userGroups: this.groups
                .filter((g) => g.userId === u.userId)
                .sort(
                  (a, b) =>
                    Number(b.isDefault) - Number(a.isDefault) || a.userGroupId - b.userGroupId,
                )
                .slice(0, 1)
                .map((g) => ({ userGroupId: g.userGroupId })),
            })),
        ),
      },
      role: {
        findUnique: jest.fn(async ({ where }: { where: { roleId: number } }) => {
          const r = this.roles.find((x) => x.roleId === where.roleId);
          return r ? { isActive: r.isActive } : null;
        }),
        findMany: jest.fn(async () =>
          this.roles.filter((r) => r.isActive).map((r) => ({ roleId: r.roleId, name: r.name })),
        ),
      },
      gedSpace: {
        findUnique: jest.fn(
          async ({ where, select }: { where: Where; select: { members?: { where?: Where } } }) => {
            const s = this.spaces.find((x) =>
              'gedSpaceId' in where
                ? x.gedSpaceId === where.gedSpaceId
                : x.publicationSlug === where.publicationSlug,
            );
            return s ? this.spaceRow(s, select) : null;
          },
        ),
        findFirst: jest.fn(async ({ where }: { where: Where }) => {
          const s = this.spaces.find((x) => this.matchSpace(x, where));
          return s ? { gedSpaceId: s.gedSpaceId } : null;
        }),
        findMany: jest.fn(
          async ({
            where,
            select,
          }: {
            where: Where;
            select?: { members?: { where?: Where }; publicationSlug?: boolean };
          }) => {
            const rows = this.spaces.filter((x) => this.matchSpace(x, where));
            if (select && !('gedSpaceId' in select))
              return rows.map((s) => ({ publicationSlug: s.publicationSlug }));
            return rows.map((s) => this.spaceRow(s, select ?? {}));
          },
        ),
        create: jest.fn(
          async ({
            data,
            select,
          }: {
            data: Partial<SpaceFx>;
            select: { members?: { where?: Where } };
          }) => {
            const s: SpaceFx = {
              gedSpaceId: this.seq++,
              label: data.label as string,
              description: data.description ?? null,
              kind: data.kind as number,
              ownerUserGroupId: data.ownerUserGroupId as number,
              publicationSlug: null,
              publishedAt: null,
              isActive: true,
              createdAt: T0,
              updatedAt: T0,
            };
            this.spaces.push(s);
            return this.spaceRow(s, select);
          },
        ),
        update: jest.fn(
          async ({ where, data }: { where: { gedSpaceId: number }; data: Partial<SpaceFx> }) => {
            const s = this.spaces.find((x) => x.gedSpaceId === where.gedSpaceId) as SpaceFx;
            if (
              data.publicationSlug &&
              this.spaces.some((o) => o !== s && o.publicationSlug === data.publicationSlug)
            ) {
              throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
            }
            Object.assign(s, data);
            return { gedSpaceId: s.gedSpaceId };
          },
        ),
      },
      gedSpaceMember: {
        findMany: jest.fn(async ({ where }: { where: { spaceId: number } }) =>
          this.members.filter((m) => m.spaceId === where.spaceId).map((m) => this.memberRow(m)),
        ),
        findFirst: jest.fn(async ({ where }: { where: Where }) => {
          const m = this.members.find((x) => matchMember(x, where));
          return m ? this.memberRow(m) : null;
        }),
        create: jest.fn(
          async ({ data }: { data: Omit<MemberFx, 'gedSpaceMemberId' | 'addedAt'> }) => {
            const m: MemberFx = { ...data, gedSpaceMemberId: this.seq++, addedAt: T0 };
            this.members.push(m);
            return this.memberRow(m);
          },
        ),
        update: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { gedSpaceMemberId: number };
            data: { permission: number };
          }) => {
            const m = this.members.find(
              (x) => x.gedSpaceMemberId === where.gedSpaceMemberId,
            ) as MemberFx;
            m.permission = data.permission;
            return this.memberRow(m);
          },
        ),
        delete: jest.fn(async ({ where }: { where: { gedSpaceMemberId: number } }) => {
          this.members = this.members.filter((x) => x.gedSpaceMemberId !== where.gedSpaceMemberId);
          return {};
        }),
      },
      gedSpaceDocument: {
        // Applique le tri du service : `addedAt` décroissant puis `documentId` croissant.
        findMany: jest.fn(async ({ where }: { where: { spaceId: number } }) =>
          this.links
            .filter((l) => l.spaceId === where.spaceId)
            .sort(
              (a, b) => b.addedAt.getTime() - a.addedAt.getTime() || a.documentId - b.documentId,
            )
            .map((l) => this.linkRow(l)),
        ),
        findUnique: jest.fn(
          async ({
            where,
          }: {
            where: { spaceId_documentId: { spaceId: number; documentId: number } };
          }) => {
            const l = this.findLink(where.spaceId_documentId);
            return l ? { documentId: l.documentId } : null;
          },
        ),
        create: jest.fn(
          async ({
            data,
          }: {
            data: { spaceId: number; documentId: number; addedBy: number | null };
          }) => {
            const l: LinkFx = { ...data, addedAt: T0 };
            this.links.push(l);
            return this.linkRow(l);
          },
        ),
        delete: jest.fn(
          async ({
            where,
          }: {
            where: { spaceId_documentId: { spaceId: number; documentId: number } };
          }) => {
            const l = this.findLink(where.spaceId_documentId);
            this.links = this.links.filter((x) => x !== l);
            return {};
          },
        ),
        count: jest.fn(
          async ({ where }: { where: { spaceId: number } }) =>
            this.links.filter(
              (l) =>
                l.spaceId === where.spaceId &&
                this.docs.find((d) => d.documentId === l.documentId)?.confidentialiteId != null,
            ).length,
        ),
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Jeu de données fictif
// ---------------------------------------------------------------------------------------------

const asUser = (userId: number, userGroupId: number | null, isAdmin = false): AuthUser => ({
  userId,
  username: `user${userId}`,
  fullName: `Utilisateur ${userId}`,
  isAdmin,
  userGroupId,
});

/** A : propriétaire, deux comptes-groupes (10 par défaut, 11). */
const A = asUser(1, 10);
/** B : membre direct (lecture) + par rôle 200 (contribution) de l'espace 2 ; membre résiduel de l'espace privé 1. */
const B = asUser(2, 20);
/** C : membre de l'espace 2 par son rôle 300 (lecture). */
const C = asUser(3, 30);
/** D : aucun lien avec aucun espace. */
const D = asUser(5, 50);
const ADMIN = asUser(9, 90, true);

function seed(db: FakeDb) {
  const u = (userId: number, roleId: number | null, isDisabled = false): UserFx => ({
    userId,
    username: `user${userId}`,
    fullName: `Utilisateur ${userId}`,
    firstName: 'Prenom',
    lastName: `Nom${userId}`,
    isDisabled,
    roleId,
  });
  db.users = [u(1, 100), u(2, 200), u(3, 300), u(4, null, true), u(5, null), u(9, null)];
  db.groups = [
    { userGroupId: 10, userId: 1, isDefault: true },
    { userGroupId: 11, userId: 1, isDefault: false },
    { userGroupId: 20, userId: 2, isDefault: true },
    { userGroupId: 30, userId: 3, isDefault: true },
    { userGroupId: 40, userId: 4, isDefault: true },
    { userGroupId: 50, userId: 5, isDefault: true },
    { userGroupId: 90, userId: 9, isDefault: true },
  ];
  db.roles = [
    { roleId: 100, name: 'Rôle A', isActive: true },
    { roleId: 200, name: 'Rôle B', isActive: true },
    { roleId: 300, name: 'Rôle C', isActive: true },
    { roleId: 400, name: 'Rôle inactif', isActive: false },
  ];
  const sp = (
    gedSpaceId: number,
    kind: number,
    ownerUserGroupId: number,
    extra: Partial<SpaceFx> = {},
  ): SpaceFx => ({
    gedSpaceId,
    label: `Espace ${gedSpaceId}`,
    description: null,
    kind,
    ownerUserGroupId,
    publicationSlug: null,
    publishedAt: null,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  });
  db.spaces = [
    sp(1, 0, 10),
    sp(2, 2, 11),
    sp(3, 3, 10, { publicationSlug: 'espace-publie', publishedAt: T0 }),
    sp(4, 1, 10, { isActive: false }),
    sp(5, 1, 50),
  ];
  const mb = (
    id: number,
    spaceId: number,
    userGroupId: number | null,
    roleId: number | null,
    permission: number,
  ): MemberFx => ({
    gedSpaceMemberId: id,
    spaceId,
    userGroupId,
    roleId,
    permission,
    addedBy: 10,
    addedAt: T0,
  });
  db.members = [
    mb(1, 1, 20, null, 2), // résiduel dans un espace privé : doit être ignoré
    mb(2, 2, 20, null, 0),
    mb(3, 2, null, 200, 1),
    mb(4, 2, null, 300, 0),
  ];
  db.docs = [
    {
      documentId: 500,
      label: 'Doc ouvert',
      documentDate: new Date('2026-03-04T00:00:00.000Z'),
      confidentialiteId: null,
      typeLabel: 'Note',
    },
    {
      documentId: 501,
      label: 'Doc confidentiel',
      documentDate: null,
      confidentialiteId: 2,
      typeLabel: null,
    },
    {
      documentId: 502,
      label: 'Doc restreint',
      documentDate: null,
      confidentialiteId: null,
      typeLabel: null,
    },
    {
      documentId: 503,
      label: 'Doc libre',
      documentDate: null,
      confidentialiteId: null,
      typeLabel: null,
    },
    {
      documentId: 504,
      label: 'Doc en attente de validation',
      documentDate: null,
      confidentialiteId: null,
      typeLabel: null,
      isArchived: false,
    },
  ];
  const ln = (spaceId: number, documentId: number): LinkFx => ({
    spaceId,
    documentId,
    addedBy: 10,
    addedAt: T0,
  });
  db.links = [ln(2, 500), ln(2, 502), ln(3, 500), ln(3, 501), ln(3, 502)];
}

/** Verdict `DocumentsService.canAccess` simulé : documents accessibles par personne. */
const ACCESSIBLE: Record<number, number[]> = {
  1: [500, 501, 502, 503],
  2: [500, 501, 503, 504], // B ne peut pas ouvrir 502
  3: [500, 501, 502, 503],
  5: [500, 501, 502],
};

describe('SpacesService', () => {
  let db: FakeDb;
  let prisma: ReturnType<FakeDb['client']>;
  let audit: { dataChange: jest.Mock; navigation: jest.Mock };
  let documents: { canAccess: jest.Mock };
  let service: SpacesService;

  beforeEach(() => {
    db = new FakeDb();
    seed(db);
    prisma = db.client();
    audit = {
      dataChange: jest.fn().mockResolvedValue(undefined),
      navigation: jest.fn().mockResolvedValue(undefined),
    };
    documents = {
      canAccess: jest.fn(async (documentId: number, user: AuthUser) =>
        user.isAdmin
          ? db.docs.some((d) => d.documentId === documentId)
          : (ACCESSIBLE[user.userId] ?? []).includes(documentId),
      ),
    };
    service = new SpacesService(prisma as never, audit as never, documents as never);
  });

  const auditValues = () =>
    audit.dataChange.mock.calls.map(([e]) => `${e.objectRef}|${e.newValue}`);

  // ---- Visibilité --------------------------------------------------------------------------

  describe('espace privé', () => {
    it('invisible (404) pour un autre utilisateur, même « membre » résiduel gestionnaire', async () => {
      await expect(service.getDetail(1, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.listDocuments(1, B)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.update(1, { label: 'x' }, B)).rejects.toBeInstanceOf(NotFoundException);
      expect((await service.list(B)).map((s) => s.gedSpaceId)).not.toContain(1);
    });

    it('invisible (404) pour un administrateur', async () => {
      await expect(service.getDetail(1, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
      expect((await service.list(ADMIN)).map((s) => s.gedSpaceId)).not.toContain(1);
    });

    it('visible du propriétaire, sans membres ni compte de membres', async () => {
      const d = await service.getDetail(1, A);
      expect(d).toMatchObject({ myAccess: 'owner', memberCount: 0, members: [], canManage: true });
    });

    it("refuse l'ajout d'un membre (400)", async () => {
      await expect(service.addMember(1, { userGroupId: 30, permission: 0 }, A)).rejects.toThrow(
        new BadRequestException('Un espace privé est réservé à son propriétaire'),
      );
      await expect(service.listMembers(1, A)).rejects.toBeInstanceOf(BadRequestException);
      expect(audit.dataChange).not.toHaveBeenCalled();
    });

    it('publication refusée (409)', async () => {
      await expect(service.publish(1, {}, A)).rejects.toBeInstanceOf(ConflictException);
      expect(db.spaces[0]).toMatchObject({ kind: 0, publicationSlug: null });
      expect(audit.dataChange).not.toHaveBeenCalled();
    });
  });

  it('espace inactif : 404 pour tous, propriétaire compris', async () => {
    await expect(service.getDetail(4, A)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getDetail(4, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('propriétaire reconnu via un autre de ses comptes-groupes', async () => {
    const d = await service.getDetail(2, A); // espace 2 appartient au groupe 11, jeton sur 10
    expect(d).toMatchObject({ myAccess: 'owner', canManage: true, canContribute: true });
    expect(d.members).toHaveLength(3);
  });

  it('membre par rôle', async () => {
    const d = await service.getDetail(2, C);
    expect(d).toMatchObject({ myAccess: 0, canContribute: false, canManage: false, members: [] });
  });

  it('un rôle désactivé ne donne plus accès', async () => {
    db.roles.find((r) => r.roleId === 300)!.isActive = false;
    await expect(service.getDetail(2, C)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un compte désactivé (jeton encore valide) ne voit rien, même ses espaces', async () => {
    db.users.find((u) => u.userId === 1)!.isDisabled = true;
    await expect(service.getDetail(2, A)).rejects.toBeInstanceOf(NotFoundException);
    expect(await service.list(A)).toEqual([]);
  });

  it('cumul compte (lecture) + rôle (contribution) : permission maximale', async () => {
    const d = await service.getDetail(2, B);
    expect(d).toMatchObject({ myAccess: 1, canContribute: true, canManage: false, members: [] });
  });

  it('GET /spaces : seulement les espaces visibles et actifs', async () => {
    expect((await service.list(A)).map((s) => s.gedSpaceId).sort()).toEqual([1, 2, 3]);
    expect((await service.list(B)).map((s) => s.gedSpaceId)).toEqual([2]);
    expect(await service.list(D)).toEqual([
      expect.objectContaining({ gedSpaceId: 5, myAccess: 'owner' }),
    ]);
    const admin = await service.list(ADMIN);
    expect(admin.map((s) => s.gedSpaceId).sort()).toEqual([2, 3, 5]);
    expect(admin.every((s) => s.myAccess === null)).toBe(true);
  });

  it('administrateur : lecture seule sur un espace partagé, aucune gestion (403)', async () => {
    const d = await service.getDetail(2, ADMIN);
    expect(d).toMatchObject({
      myAccess: null,
      canManage: false,
      canContribute: false,
      members: [],
    });
    await expect(service.update(2, { label: 'x' }, ADMIN)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.publish(2, {}, ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('GET /spaces/:id écrit un audit de navigation', async () => {
    await service.getDetail(2, B);
    expect(audit.navigation).toHaveBeenCalledWith(
      expect.objectContaining({
        userGroupId: 20,
        actorFullName: 'Utilisateur 2',
        url: '/espaces/2',
      }),
    );
  });

  // ---- 403 vs 404 --------------------------------------------------------------------------

  describe('403 vs 404', () => {
    it('non visible : 404 ; visible sans le droit : 403', async () => {
      await expect(service.update(2, { label: 'x' }, D)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.update(2, { label: 'x' }, B)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.remove(2, D)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('suppression réservée au propriétaire, même face à un gestionnaire', async () => {
      db.members.find((m) => m.gedSpaceMemberId === 2)!.permission = 2;
      await expect(service.remove(2, B)).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.spaces[1].isActive).toBe(true);
    });

    it("un gestionnaire ne peut pas rendre l'espace privé (403)", async () => {
      db.members.find((m) => m.gedSpaceMemberId === 2)!.permission = 2;
      await expect(service.update(2, { kind: 0 }, B)).rejects.toBeInstanceOf(ForbiddenException);
      const s = await service.update(2, { label: 'Renommé' }, B);
      expect(s.label).toBe('Renommé');
    });
  });

  // ---- Documents ---------------------------------------------------------------------------

  describe('documents', () => {
    it('membre sans droit sur un document : document absent de la liste', async () => {
      const rows = await service.listDocuments(2, B);
      expect(rows.map((r) => r.documentId)).toEqual([500]);
      expect(rows[0]).toMatchObject({ documentDate: '2026-03-04', documentTypeLabel: 'Note' });
      // le compte brut du résumé n'est pas filtré (contrat) mais la liste ne révèle rien d'autre
      expect(rows).toHaveLength(1);
    });

    it('vue publiée par un tiers : document avec confidentialité absent, même accessible', async () => {
      const rows = await service.listDocuments(3, D);
      expect(rows.map((r) => r.documentId)).toEqual([500, 502]);
      expect(documents.canAccess).not.toHaveBeenCalledWith(501, D);
    });

    it('vue publiée par un tiers : canAccess prime aussi (document sans confidentialité refusé)', async () => {
      const rows = await service.listDocuments(3, B);
      expect(rows.map((r) => r.documentId)).toEqual([500]);
    });

    it('le propriétaire voit tous les documents accessibles, confidentialité comprise', async () => {
      const rows = await service.listDocuments(3, A);
      expect(rows.map((r) => r.documentId)).toEqual([500, 501, 502]);
    });

    it('rattacher exige la contribution (403) sans même consulter le document', async () => {
      await expect(service.attachDocument(2, { documentId: 503 }, C)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(documents.canAccess).not.toHaveBeenCalled();
      await expect(service.attachDocument(3, { documentId: 503 }, D)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rattacher exige canAccess : 404 si inaccessible ou inexistant', async () => {
      await expect(service.attachDocument(2, { documentId: 502 }, B)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.attachDocument(2, { documentId: 999 }, B)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(db.links.filter((l) => l.spaceId === 2)).toHaveLength(2);
    });

    it('rattacher : 409 si le document n’est pas archivé, sans lien ni audit', async () => {
      await expect(service.attachDocument(2, { documentId: 504 }, B)).rejects.toThrow(
        new ConflictException(NOT_ARCHIVED_MESSAGE),
      );
      expect(db.links.some((l) => l.documentId === 504)).toBe(false);
      expect(audit.dataChange).not.toHaveBeenCalled();
    });

    it('rattacher un document non archivé et inaccessible : 404 (rien n’est révélé de son état)', async () => {
      await expect(service.attachDocument(2, { documentId: 504 }, C)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // D est propriétaire de l'espace 5, mais 504 ne lui est pas accessible : 404, pas 409.
      await expect(service.attachDocument(5, { documentId: 504 }, D)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.document.findUnique).not.toHaveBeenCalled();
    });

    it('rattacher : 409 si déjà rattaché', async () => {
      await expect(service.attachDocument(2, { documentId: 500 }, B)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rattacher puis détacher : deux lignes d’audit chacun (espace + document), document intact', async () => {
      const row = await service.attachDocument(2, { documentId: 503 }, B);
      expect(row.documentId).toBe(503);
      await service.detachDocument(2, 503, B);
      expect(auditValues()).toEqual([
        'space:2|document-attached:503',
        'document:503|space-attached:2',
        'space:2|document-detached:503',
        'document:503|space-detached:2',
      ]);
      expect(db.docs.some((d) => d.documentId === 503)).toBe(true);
    });

    it('détacher : un simple contributeur ne détache pas un document qu’il ne voit pas (404)', async () => {
      await expect(service.detachDocument(2, 502, B)).rejects.toBeInstanceOf(NotFoundException);
      expect(db.links.some((l) => l.spaceId === 2 && l.documentId === 502)).toBe(true);
      expect(audit.dataChange).not.toHaveBeenCalled();
    });

    it('détacher : le propriétaire détache sans canAccess', async () => {
      ACCESSIBLE[1] = [500];
      try {
        await service.detachDocument(2, 502, A);
      } finally {
        ACCESSIBLE[1] = [500, 501, 502, 503];
      }
      expect(db.links.some((l) => l.spaceId === 2 && l.documentId === 502)).toBe(false);
      expect(documents.canAccess).not.toHaveBeenCalled();
    });

    it('détacher : un gestionnaire (permission 2) détache sans canAccess', async () => {
      db.members.find((m) => m.gedSpaceMemberId === 2)!.permission = 2; // B gestionnaire
      await service.detachDocument(2, 502, B); // 502 invisible pour B
      expect(db.links.some((l) => l.spaceId === 2 && l.documentId === 502)).toBe(false);
      expect(documents.canAccess).not.toHaveBeenCalled();
      expect(auditValues()).toEqual([
        'space:2|document-detached:502',
        'document:502|space-detached:2',
      ]);
    });

    it('détacher : lien inexistant (404) même pour le propriétaire', async () => {
      await expect(service.detachDocument(2, 503, A)).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('pagination', () => {
      beforeEach(() => {
        // 12 documents ouverts rattachés à l'espace 2, dates distinctes ; 600..611
        for (let i = 0; i < 12; i++) {
          const documentId = 600 + i;
          db.docs.push({
            documentId,
            label: `Doc ${documentId}`,
            documentDate: null,
            confidentialiteId: null,
            typeLabel: null,
          });
          db.links.push({
            spaceId: 2,
            documentId,
            addedBy: 10,
            addedAt: new Date(T0.getTime() + (i + 1) * 60_000),
          });
        }
        // B ne voit que les pairs (600, 602, …) et 500
        ACCESSIBLE[2] = [500, 501, 503, ...[0, 2, 4, 6, 8, 10].map((i) => 600 + i)];
      });
      afterEach(() => {
        ACCESSIBLE[2] = [500, 501, 503];
      });

      it('défaut sans paramètre : tous les visibles (≤ 100), tri addedAt desc', async () => {
        const rows = await service.listDocuments(2, B);
        expect(rows.map((r) => r.documentId)).toEqual([610, 608, 606, 604, 602, 600, 500]);
      });

      it('le filtrage canAccess précède la coupe : pages pleines de documents visibles', async () => {
        const p1 = await service.listDocuments(2, B, { limit: 3, offset: 0 });
        const p2 = await service.listDocuments(2, B, { limit: 3, offset: 3 });
        const p3 = await service.listDocuments(2, B, { limit: 3, offset: 6 });
        expect(p1.map((r) => r.documentId)).toEqual([610, 608, 606]);
        expect(p2.map((r) => r.documentId)).toEqual([604, 602, 600]);
        expect(p3.map((r) => r.documentId)).toEqual([500]);
        // 502 (masqué) et les impairs n'apparaissent jamais
        const all = [...p1, ...p2, ...p3].map((r) => r.documentId);
        expect(all).not.toContain(502);
        expect(all).not.toContain(611);
      });

      it('arrêt anticipé : pas de canAccess au-delà de la page demandée', async () => {
        await service.listDocuments(2, B, { limit: 1, offset: 0 });
        // un seul lot de 10 candidats suffit pour trouver 1 visible
        expect(documents.canAccess.mock.calls.length).toBeLessThanOrEqual(10);
      });

      it('offset au-delà de la fin : liste vide', async () => {
        expect(await service.listDocuments(2, B, { limit: 50, offset: 100 })).toEqual([]);
      });
    });
  });

  // ---- documentCount -----------------------------------------------------------------------

  describe('documentCount', () => {
    it('null dans la liste, pour tous', async () => {
      for (const actor of [A, B, ADMIN]) {
        for (const s of await service.list(actor)) expect(s.documentCount).toBeNull();
      }
    });

    it('null pour un non-gestionnaire et dans la lecture par slug', async () => {
      expect((await service.getDetail(2, B)).documentCount).toBeNull();
      expect((await service.getDetail(2, ADMIN)).documentCount).toBeNull();
      expect((await service.getPublished('espace-publie', D)).documentCount).toBeNull();
      expect((await service.getPublished('espace-publie', A)).documentCount).toBeNull();
    });

    it('détail gestionnaire : nombre de documents VISIBLES, pas le compte brut', async () => {
      db.members.find((m) => m.gedSpaceMemberId === 2)!.permission = 2; // B gestionnaire
      // espace 2 : 500 (visible) + 502 (invisible pour B) → 1, pas 2
      expect((await service.getDetail(2, B)).documentCount).toBe(1);
      expect((await service.getDetail(2, A)).documentCount).toBe(2);
    });

    it('les réponses de mutation ne portent pas de compte', async () => {
      const s = await service.update(2, { label: 'Autre' }, A);
      expect(s.documentCount).toBeNull();
      expect((await service.publish(2, {}, A)).space.documentCount).toBeNull();
    });
  });

  // ---- Lecture par slug --------------------------------------------------------------------

  describe('publication par slug', () => {
    it('lisible par un utilisateur authentifié quelconque, myAccess null, sans membres', async () => {
      const d = await service.getPublished('espace-publie', D);
      expect(d).toMatchObject({ gedSpaceId: 3, myAccess: null, canManage: false, members: [] });
      expect(audit.navigation).toHaveBeenCalled();
    });

    it('le propriétaire y voit son droit réel', async () => {
      expect((await service.getPublished('espace-publie', A)).myAccess).toBe('owner');
    });

    it('slug inconnu, mal formé ou espace dépublié : 404', async () => {
      await expect(service.getPublished('inconnu', D)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getPublished('../x', D)).rejects.toBeInstanceOf(NotFoundException);
      db.spaces[2].kind = 1;
      await expect(service.getPublished('espace-publie', D)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("la route n'est jamais anonyme : ni @Public(), et le menu reste exigé", () => {
      const reflect = Reflect as unknown as { getMetadata: (k: string, t: object) => unknown };
      const handler = SpacesController.prototype.getPublished;
      expect(reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
      expect(reflect.getMetadata(IS_PUBLIC_KEY, SpacesController)).toBeUndefined();
      expect(reflect.getMetadata(REQUIRE_MENU_KEY, SpacesController)).toEqual([SPACES_MENU]);
    });
  });

  // ---- Publication -------------------------------------------------------------------------

  describe('publication', () => {
    it('publie avec un slug dérivé, compte les documents non publiables, audite', async () => {
      db.links.push({ spaceId: 2, documentId: 501, addedBy: 10, addedAt: T0 });
      const res = await service.publish(2, {}, A);
      expect(res.space).toMatchObject({ kind: 3, publicationSlug: 'espace-2', myAccess: 'owner' });
      expect(res.space.publishedAt).not.toBeNull();
      expect(res.nonPublishableCount).toBe(1);
      expect(auditValues()).toEqual(['space:2|published:slug=espace-2']);
    });

    it('slug dérivé déjà pris : suffixe numérique', async () => {
      db.spaces[2].publicationSlug = 'espace-2';
      const res = await service.publish(2, {}, A);
      expect(res.space.publicationSlug).toBe('espace-2-2');
    });

    it('slug fourni déjà pris : 409', async () => {
      await expect(service.publish(2, { slug: 'espace-publie' }, A)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(audit.dataChange).not.toHaveBeenCalled();
    });

    it('un espace publié ne change pas de nature sans dépublication (409)', async () => {
      await expect(service.update(3, { kind: 1 }, A)).rejects.toBeInstanceOf(ConflictException);
    });

    it('dépublier : retour au partage, slug libéré et réutilisable, audit', async () => {
      const s = await service.unpublish(3, A);
      expect(s).toMatchObject({ kind: 1, publicationSlug: null, publishedAt: null });
      expect(audit.dataChange).toHaveBeenCalledWith(
        expect.objectContaining({
          objectRef: 'space:3',
          newValue: 'unpublished',
          oldValue: 'slug=espace-publie',
        }),
      );
      const res = await service.publish(2, { slug: 'espace-publie' }, A);
      expect(res.space.publicationSlug).toBe('espace-publie');
    });

    it('dépublier un espace non publié : 409', async () => {
      await expect(service.unpublish(2, A)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ---- Membres -----------------------------------------------------------------------------

  describe('membres', () => {
    it('doublon : 409 ; propriétaire : 409', async () => {
      await expect(
        service.addMember(2, { userGroupId: 20, permission: 1 }, A),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(service.addMember(2, { roleId: 200, permission: 1 }, A)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(
        service.addMember(2, { userGroupId: 11, permission: 1 }, A),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('bénéficiaire inexistant, désactivé ou rôle inactif : 400', async () => {
      await expect(
        service.addMember(2, { userGroupId: 777, permission: 0 }, A),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.addMember(2, { userGroupId: 40, permission: 0 }, A),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.addMember(2, { roleId: 400, permission: 0 }, A)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('gestion requise (403 pour un contributeur)', async () => {
      await expect(
        service.addMember(2, { userGroupId: 50, permission: 0 }, B),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.listMembers(2, B)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("membre d'un autre espace : 404 sur l'id de membre", async () => {
      db.members.push({
        gedSpaceMemberId: 9,
        spaceId: 5,
        userGroupId: 20,
        roleId: null,
        permission: 0,
        addedBy: 50,
        addedAt: T0,
      });
      await expect(service.updateMember(2, 9, { permission: 2 }, A)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.removeMember(2, 9, A)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('le membre ajouté accède à l’espace ; retiré, il le perd', async () => {
      await expect(service.getDetail(2, D)).rejects.toBeInstanceOf(NotFoundException);
      const row = await service.addMember(2, { userGroupId: 50, permission: 0 }, A);
      expect(row).toMatchObject({
        granteeType: 'user',
        granteeLabel: 'Utilisateur 5',
        permission: 0,
      });
      expect((await service.getDetail(2, D)).myAccess).toBe(0);
      await service.removeMember(2, row.gedSpaceMemberId, A);
      await expect(service.getDetail(2, D)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---- Audit de chaque mutation ------------------------------------------------------------

  it('chaque mutation écrit une ligne au journal, avec auteur figé', async () => {
    const created = await service.create({ label: 'Nouveau', kind: 1 }, A);
    const id = created.gedSpaceId;
    expect(created).toMatchObject({ myAccess: 'owner', ownerUserGroupId: 10, kind: 1 });
    await service.update(id, { label: 'Nouveau 2', kind: 2 }, A);
    const m = await service.addMember(id, { roleId: 300, permission: 0 }, A);
    await service.updateMember(id, m.gedSpaceMemberId, { permission: 1 }, A);
    await service.removeMember(id, m.gedSpaceMemberId, A);
    await service.attachDocument(id, { documentId: 503 }, A);
    await service.detachDocument(id, 503, A);
    await service.publish(id, { slug: 'nouveau-2' }, A);
    await service.unpublish(id, A);
    await service.remove(id, A);

    expect(auditValues()).toEqual([
      `space:${id}|created:kind=1`,
      `space:${id}|updated:label,kind;kind=2`,
      `space:${id}|member-added:role:300:perm=0`,
      `space:${id}|member-updated:role:300:perm=1`,
      `space:${id}|member-removed:role:300`,
      `space:${id}|document-attached:503`,
      'document:503|space-attached:' + id,
      `space:${id}|document-detached:503`,
      'document:503|space-detached:' + id,
      `space:${id}|published:slug=nouveau-2`,
      `space:${id}|unpublished`,
      `space:${id}|deleted`,
    ]);
    for (const [entry] of audit.dataChange.mock.calls) {
      expect(entry).toMatchObject({ userGroupId: 10, actorFullName: 'Utilisateur 1' });
    }
  });

  it('suppression logique : inactif, slug libéré, puis 404', async () => {
    await service.remove(3, A);
    expect(db.spaces[2]).toMatchObject({
      isActive: false,
      publicationSlug: null,
      publishedAt: null,
    });
    await expect(service.getDetail(3, A)).rejects.toBeInstanceOf(NotFoundException);
    expect(db.links.filter((l) => l.spaceId === 3)).toHaveLength(3); // documents intacts
  });

  it('création refusée sans compte-groupe par défaut (403)', async () => {
    await expect(service.create({ label: 'x', kind: 0 }, asUser(5, null))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(audit.dataChange).not.toHaveBeenCalled();
  });

  describe('candidats : droits', () => {
    it('ni propriétaire ni gestionnaire : 403 (contributeur, lecteur par rôle, sans espace)', async () => {
      await expect(service.memberCandidates(B)).rejects.toBeInstanceOf(ForbiddenException); // perm 1
      await expect(service.memberCandidates(C)).rejects.toBeInstanceOf(ForbiddenException); // rôle, perm 0
      await expect(service.memberCandidates(asUser(4, 40))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('propriétaire d’un espace partagé : autorisé', async () => {
      await expect(service.memberCandidates(D)).resolves.toBeDefined(); // espace 5 (kind 1)
    });

    it('propriétaire du seul espace privé : 403', async () => {
      db.spaces = db.spaces.filter((s) => s.gedSpaceId === 1); // A ne possède plus qu'un privé
      await expect(service.memberCandidates(A)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('propriétaire d’un espace partagé INACTIF seulement : 403', async () => {
      db.spaces.find((s) => s.gedSpaceId === 5)!.isActive = false;
      await expect(service.memberCandidates(D)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('gestionnaire par rôle : autorisé ; rôle désactivé : 403', async () => {
      db.members.find((m) => m.gedSpaceMemberId === 4)!.permission = 2; // rôle 300 gestionnaire
      await expect(service.memberCandidates(C)).resolves.toBeDefined();
      db.roles.find((r) => r.roleId === 300)!.isActive = false;
      await expect(service.memberCandidates(C)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('gestion via un espace privé (membre résiduel) : 403', async () => {
      // B est « gestionnaire » résiduel de l'espace privé 1 seulement
      db.members = db.members.filter((m) => m.spaceId === 1);
      await expect(service.memberCandidates(B)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('administrateur sans espace possédé ni géré : 403 (règle commune)', async () => {
      await expect(service.memberCandidates(ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('candidats : utilisateurs actifs (compte-groupe par défaut) et rôles actifs, champs minimaux', async () => {
    const c = await service.memberCandidates(A);
    expect(c.users.find((u) => u.username === 'user1')).toEqual({
      userGroupId: 10,
      fullName: 'Utilisateur 1',
      username: 'user1',
    });
    expect(c.users.some((u) => u.userGroupId === 40)).toBe(false);
    expect(c.roles.map((r) => r.roleId)).toEqual([100, 200, 300]);
  });
});
