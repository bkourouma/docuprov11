import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  GedSpaceKind,
  GedSpacePermission as GedSpacePermissionValue,
  type GedSpaceDetail,
  type GedSpaceDocumentRow,
  type GedSpaceKind as GedSpaceKindValue,
  type GedSpaceMemberCandidates,
  type GedSpaceMemberRow,
  type GedSpacePermission,
  type GedSpacePublishResult,
  type GedSpaceSummary,
} from '@archivage/types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { DocumentsService, actorName } from '../documents/documents.service';
import {
  canChangeKind,
  canPublish,
  isDocumentListable,
  isValidSlug,
  nextAvailableSlug,
  resolveSpaceAccess,
  slugify,
  type SpaceAccessDecision,
  type SpaceActor,
} from './domain';
import type {
  AddMemberDto,
  AttachDocumentDto,
  CreateSpaceDto,
  PublishSpaceDto,
  UpdateMemberDto,
  UpdateSpaceDto,
} from './spaces.dto';

/** Droit requis par une opération sur un espace (cf. `SpaceAccessDecision`). */
type SpaceNeed = 'read' | 'contribute' | 'manage' | 'delete';

/** Pagination du listing des documents (cf. `listDocumentsQuerySchema`). */
export interface DocumentPage {
  limit: number;
  offset: number;
}
const DEFAULT_DOCUMENT_PAGE: DocumentPage = { limit: 100, offset: 0 };

/** Nombre d'appels `canAccess` menés en parallèle lors du filtrage d'un listing. */
const CAN_ACCESS_CONCURRENCY = 10;

const PRIVATE_SPACE_MEMBERS_MESSAGE = 'Un espace privé est réservé à son propriétaire';

/** Rattachement d'un document non archivé (règle : seuls les documents archivés se rattachent). */
export const NOT_ARCHIVED_MESSAGE =
  'Seuls les documents archivés (validés) peuvent être rattachés à un espace';

/** Acteur sans aucun droit : compte désactivé/introuvable ou identité machine. */
const NO_ACTOR: SpaceActor = Object.freeze({ userGroupIds: [], roleId: null, isAdmin: false });

/** Lignes de membre qui visent l'acteur (par l'un de ses comptes-groupes ou par son rôle). */
function memberFilter(actor: SpaceActor): Prisma.GedSpaceMemberWhereInput {
  return {
    OR: [
      { userGroupId: { in: [...actor.userGroupIds] } },
      ...(actor.roleId != null ? [{ roleId: actor.roleId }] : []),
    ],
  };
}

/**
 * Sélection d'un espace. Seules les lignes de membre qui visent l'ACTEUR sont chargées : elles
 * suffisent à décider de son droit, et la liste complète n'est lue que pour un gestionnaire.
 */
function spaceSelect(actor: SpaceActor) {
  return {
    gedSpaceId: true,
    label: true,
    description: true,
    kind: true,
    isActive: true,
    ownerUserGroupId: true,
    publicationSlug: true,
    publishedAt: true,
    createdAt: true,
    updatedAt: true,
    owner: { select: { user: { select: { fullName: true } } } },
    members: {
      where: memberFilter(actor),
      select: { userGroupId: true, roleId: true, permission: true },
    },
    _count: { select: { documents: true, members: true } },
  } satisfies Prisma.GedSpaceSelect;
}
type SpaceRow = Prisma.GedSpaceGetPayload<{ select: ReturnType<typeof spaceSelect> }>;

const memberRowSelect = {
  gedSpaceMemberId: true,
  userGroupId: true,
  roleId: true,
  permission: true,
  addedAt: true,
  userGroup: { select: { user: { select: { fullName: true, username: true } } } },
  role: { select: { name: true } },
} satisfies Prisma.GedSpaceMemberSelect;
type MemberRow = Prisma.GedSpaceMemberGetPayload<{ select: typeof memberRowSelect }>;

const spaceDocumentSelect = {
  addedAt: true,
  document: {
    select: {
      documentId: true,
      label: true,
      documentDate: true,
      confidentialiteId: true,
      documentType: { select: { label: true } },
    },
  },
} satisfies Prisma.GedSpaceDocumentSelect;
type SpaceDocumentRow = Prisma.GedSpaceDocumentGetPayload<{ select: typeof spaceDocumentSelect }>;

/** Violation d'unicité Prisma (course entre deux requêtes) — détectée sans dépendre de la classe. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Espaces GED : regroupements de documents sans déplacement (le classement reste celui du
 * document).
 *
 * Contrôle d'accès APPLICATIF, refus par défaut, décidé par `resolveSpaceAccess` (domaine pur) :
 * un espace non visible répond 404 (son existence n'est pas révélée), un espace visible sans le
 * droit requis répond 403.
 *
 * PRIORITÉ DES DROITS DOCUMENTAIRES : l'appartenance à un espace ne donne JAMAIS accès à un
 * document. Tout listing et tout rattachement passent par `DocumentsService.canAccess`, qui reste
 * l'unique source de vérité (confidentialité + droits par document/type).
 */
@Injectable()
export class SpacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Résolution de l'acteur et autorisation
  // ---------------------------------------------------------------------------------------------

  /**
   * L'acteur au niveau de la PERSONNE : tous ses comptes-groupes et son rôle s'il est actif. Un
   * compte désactivé (jeton encore valide) ou l'identité machine n'obtiennent aucun droit.
   */
  async resolveActor(user: AuthUser): Promise<SpaceActor> {
    if (user.isScanAgent) return NO_ACTOR;
    const [groups, account] = await Promise.all([
      this.prisma.appUserGroup.findMany({
        where: { userId: user.userId },
        select: { userGroupId: true },
      }),
      this.prisma.appUser.findUnique({
        where: { userId: user.userId },
        select: { isDisabled: true, roleId: true, role: { select: { isActive: true } } },
      }),
    ]);
    if (!account || account.isDisabled) return NO_ACTOR;
    return {
      userGroupIds: groups.map((g) => g.userGroupId),
      roleId: account.roleId != null && account.role?.isActive ? account.roleId : null,
      isAdmin: user.isAdmin,
    };
  }

  private decide(space: SpaceRow, actor: SpaceActor): SpaceAccessDecision {
    return resolveSpaceAccess(
      {
        kind: space.kind,
        isActive: space.isActive,
        ownerUserGroupId: space.ownerUserGroupId,
        members: space.members,
      },
      actor,
    );
  }

  /** Charge l'espace et vérifie le droit requis : 404 si invisible, 403 si droit insuffisant. */
  private async authorize(spaceId: number, user: AuthUser, need: SpaceNeed) {
    const actor = await this.resolveActor(user);
    const space = await this.prisma.gedSpace.findUnique({
      where: { gedSpaceId: spaceId },
      select: spaceSelect(actor),
    });
    if (!space) throw new NotFoundException('Espace introuvable');
    const decision = this.decide(space, actor);
    if (!decision.visible) throw new NotFoundException('Espace introuvable');

    if (need === 'contribute' && !decision.canContribute) {
      throw new ForbiddenException('Droit de contribution requis sur cet espace');
    }
    if (need === 'manage' && !decision.canManage) {
      throw new ForbiddenException('Droit de gestion requis sur cet espace');
    }
    if (need === 'delete' && !decision.canDelete) {
      throw new ForbiddenException("Seul le propriétaire peut supprimer l'espace");
    }
    return { space, actor, decision };
  }

  private async reload(spaceId: number, actor: SpaceActor) {
    const space = await this.prisma.gedSpace.findUnique({
      where: { gedSpaceId: spaceId },
      select: spaceSelect(actor),
    });
    if (!space) throw new NotFoundException('Espace introuvable');
    return { space, decision: this.decide(space, actor) };
  }

  private writeAudit(user: AuthUser, objectRef: string, newValue: string, oldValue?: string) {
    return this.audit.dataChange({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      objectRef,
      ...(oldValue !== undefined ? { oldValue } : {}),
      newValue,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Projections (contrat `@archivage/types` ged-spaces)
  // ---------------------------------------------------------------------------------------------

  /**
   * `documentCount` : `null` par défaut. Un compte BRUT (`_count.documents`) révélerait l'existence
   * de documents que l'appelant ne peut pas voir ; seul `getDetail` fournit, à un propriétaire ou
   * gestionnaire, le nombre de documents qu'il VOIT (cf. `visibleDocuments`).
   */
  private toSummary(
    space: SpaceRow,
    decision: SpaceAccessDecision,
    documentCount: number | null = null,
  ): GedSpaceSummary {
    return {
      gedSpaceId: space.gedSpaceId,
      label: space.label,
      description: space.description,
      kind: space.kind as GedSpaceKindValue,
      isActive: space.isActive,
      ownerUserGroupId: space.ownerUserGroupId,
      ownerName: space.owner?.user?.fullName ?? null,
      publicationSlug: space.publicationSlug,
      publishedAt: iso(space.publishedAt),
      documentCount,
      // Espace privé : les membres résiduels sont ignorés par le contrôle d'accès, donc non comptés.
      memberCount: space.kind === GedSpaceKind.Prive ? 0 : space._count.members,
      myAccess: decision.access,
      createdAt: space.createdAt.toISOString(),
      updatedAt: space.updatedAt.toISOString(),
    };
  }

  private toMemberRow(m: MemberRow): GedSpaceMemberRow {
    const isUser = m.userGroupId != null;
    const userLabel = m.userGroup?.user?.fullName?.trim() || m.userGroup?.user?.username;
    return {
      gedSpaceMemberId: m.gedSpaceMemberId,
      userGroupId: m.userGroupId,
      roleId: m.roleId,
      granteeLabel: isUser
        ? userLabel || `Utilisateur #${m.userGroupId}`
        : m.role?.name || `Rôle #${m.roleId}`,
      granteeType: isUser ? 'user' : 'role',
      permission: m.permission as GedSpacePermission,
      addedAt: m.addedAt.toISOString(),
    };
  }

  private toDocumentRow(row: SpaceDocumentRow): GedSpaceDocumentRow {
    return {
      documentId: row.document.documentId,
      label: row.document.label,
      documentDate: row.document.documentDate
        ? row.document.documentDate.toISOString().slice(0, 10)
        : null,
      documentTypeLabel: row.document.documentType?.label ?? null,
      addedAt: row.addedAt.toISOString(),
    };
  }

  private async toDetail(
    space: SpaceRow,
    decision: SpaceAccessDecision,
    documentCount: number | null = null,
  ): Promise<GedSpaceDetail> {
    const members =
      decision.canManage && space.kind !== GedSpaceKind.Prive
        ? await this.loadMembers(space.gedSpaceId)
        : [];
    return {
      ...this.toSummary(space, decision, documentCount),
      members,
      canManage: decision.canManage,
      canContribute: decision.canContribute,
    };
  }

  private async loadMembers(spaceId: number): Promise<GedSpaceMemberRow[]> {
    const rows = await this.prisma.gedSpaceMember.findMany({
      where: { spaceId },
      orderBy: { addedAt: 'asc' },
      select: memberRowSelect,
    });
    return rows.map((m) => this.toMemberRow(m));
  }

  // ---------------------------------------------------------------------------------------------
  // Espaces
  // ---------------------------------------------------------------------------------------------

  /**
   * Espaces ACTIFS visibles de l'acteur : les siens, ceux dont il est membre (hors privés) et,
   * pour un administrateur, les espaces 1 à 3 d'autrui en lecture seule.
   *
   * Les publications d'autrui dont il n'est pas membre n'y figurent PAS : elles se lisent par leur
   * slug (choix prudent : le listing ne sert pas d'annuaire des publications).
   */
  async list(user: AuthUser): Promise<GedSpaceSummary[]> {
    const actor = await this.resolveActor(user);
    const sharedKinds = [
      GedSpaceKind.Partage,
      GedSpaceKind.Collaboration,
      GedSpaceKind.Publication,
    ];
    const rows = await this.prisma.gedSpace.findMany({
      where: {
        isActive: true,
        OR: [
          { ownerUserGroupId: { in: [...actor.userGroupIds] } },
          { kind: { in: sharedKinds }, members: { some: memberFilter(actor) } },
          ...(actor.isAdmin ? [{ kind: { in: sharedKinds } }] : []),
        ],
      },
      orderBy: [{ updatedAt: 'desc' }, { gedSpaceId: 'desc' }],
      select: spaceSelect(actor),
    });
    // Défense en profondeur : la requête pré-filtre, la décision pure tranche.
    const out: GedSpaceSummary[] = [];
    for (const space of rows) {
      const decision = this.decide(space, actor);
      if (decision.visible) out.push(this.toSummary(space, decision));
    }
    return out;
  }

  async create(dto: CreateSpaceDto, user: AuthUser): Promise<GedSpaceSummary> {
    if (user.userGroupId == null || user.isScanAgent) {
      throw new ForbiddenException(
        "Votre compte n'a pas de groupe par défaut : impossible de créer un espace",
      );
    }
    const actor: SpaceActor = { userGroupIds: [user.userGroupId], roleId: null, isAdmin: false };
    const space = await this.prisma.gedSpace.create({
      data: {
        label: dto.label,
        description: dto.description ?? null,
        kind: dto.kind,
        ownerUserGroupId: user.userGroupId,
      },
      select: spaceSelect(actor),
    });
    await this.writeAudit(user, `space:${space.gedSpaceId}`, `created:kind=${space.kind}`);
    return this.toSummary(space, this.decide(space, actor));
  }

  async getDetail(spaceId: number, user: AuthUser): Promise<GedSpaceDetail> {
    const { space, decision } = await this.authorize(spaceId, user, 'read');
    await this.audit.navigation({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      activity: 'open space',
      url: `/espaces/${spaceId}`,
    });
    // Compte des documents VISIBLES, réservé au propriétaire/gestionnaire : il coûte un
    // `canAccess` par document (comme la liste), on ne le paie pas pour un simple lecteur, qui
    // reçoit `null` (le web affiche « — »).
    const documentCount = decision.canManage
      ? (await this.visibleDocuments(spaceId, user, decision)).length
      : null;
    return this.toDetail(space, decision, documentCount);
  }

  /**
   * Lecture d'une publication par son slug, pour tout utilisateur AUTHENTIFIÉ (le garde JWT global
   * refuse l'anonyme ; aucune route `@Public()` ici). `myAccess` reflète le droit réel : `null`
   * pour un simple lecteur.
   */
  async getPublished(slug: string, user: AuthUser): Promise<GedSpaceDetail> {
    if (!isValidSlug(slug)) throw new NotFoundException('Publication introuvable');
    const actor = await this.resolveActor(user);
    const space = await this.prisma.gedSpace.findUnique({
      where: { publicationSlug: slug },
      select: spaceSelect(actor),
    });
    if (!space || !space.isActive || space.kind !== GedSpaceKind.Publication) {
      throw new NotFoundException('Publication introuvable');
    }
    const decision = this.decide(space, actor);
    if (!decision.visible) throw new NotFoundException('Publication introuvable');
    await this.audit.navigation({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      activity: 'open published space',
      url: `/espaces/publie/${slug}`,
    });
    return this.toDetail(space, decision);
  }

  async update(spaceId: number, dto: UpdateSpaceDto, user: AuthUser): Promise<GedSpaceSummary> {
    const { space, actor, decision } = await this.authorize(spaceId, user, 'manage');

    const kindChanges = dto.kind !== undefined && dto.kind !== space.kind;
    if (kindChanges && !canChangeKind(space.kind, dto.kind as number)) {
      throw new ConflictException(
        "L'espace est publié : dépubliez-le avant d'en changer la nature",
      );
    }
    // Rendre l'espace privé en exclut tous les membres, y compris le gestionnaire qui le ferait :
    // décision réservée au propriétaire.
    if (kindChanges && dto.kind === GedSpaceKind.Prive && decision.access !== 'owner') {
      throw new ForbiddenException('Seul le propriétaire peut rendre un espace privé');
    }

    const data: Prisma.GedSpaceUpdateInput = {};
    const fields: string[] = [];
    if (dto.label !== undefined && dto.label !== space.label) {
      data.label = dto.label;
      fields.push('label');
    }
    if (dto.description !== undefined && dto.description !== space.description) {
      data.description = dto.description;
      fields.push('description');
    }
    if (kindChanges) {
      data.kind = dto.kind;
      fields.push('kind');
    }
    if (fields.length === 0) return this.toSummary(space, decision);

    await this.prisma.gedSpace.update({ where: { gedSpaceId: spaceId }, data });
    await this.writeAudit(
      user,
      `space:${spaceId}`,
      `updated:${fields.join(',')}${kindChanges ? `;kind=${dto.kind}` : ''}`,
      kindChanges ? `kind=${space.kind}` : undefined,
    );
    const after = await this.reload(spaceId, actor);
    return this.toSummary(after.space, after.decision);
  }

  /** Suppression LOGIQUE : l'espace disparaît, son slug est libéré ; les documents sont intacts. */
  async remove(spaceId: number, user: AuthUser): Promise<{ ok: true }> {
    const { space } = await this.authorize(spaceId, user, 'delete');
    await this.prisma.gedSpace.update({
      where: { gedSpaceId: spaceId },
      data: { isActive: false, publicationSlug: null, publishedAt: null },
    });
    await this.writeAudit(
      user,
      `space:${spaceId}`,
      'deleted',
      `kind=${space.kind}${space.publicationSlug ? `;slug=${space.publicationSlug}` : ''}`,
    );
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------
  // Membres
  // ---------------------------------------------------------------------------------------------

  private assertNotPrivate(space: SpaceRow) {
    if (space.kind === GedSpaceKind.Prive) {
      throw new BadRequestException(PRIVATE_SPACE_MEMBERS_MESSAGE);
    }
  }

  async listMembers(spaceId: number, user: AuthUser): Promise<GedSpaceMemberRow[]> {
    const { space } = await this.authorize(spaceId, user, 'manage');
    this.assertNotPrivate(space);
    return this.loadMembers(spaceId);
  }

  async addMember(spaceId: number, dto: AddMemberDto, user: AuthUser): Promise<GedSpaceMemberRow> {
    const { space } = await this.authorize(spaceId, user, 'manage');
    this.assertNotPrivate(space);

    let grantee: string;
    if (dto.userGroupId !== undefined) {
      const target = await this.prisma.appUserGroup.findUnique({
        where: { userGroupId: dto.userGroupId },
        select: { user: { select: { isDisabled: true } } },
      });
      if (!target || target.user.isDisabled) {
        throw new BadRequestException('Utilisateur introuvable ou désactivé');
      }
      if (dto.userGroupId === space.ownerUserGroupId) {
        throw new ConflictException('Le propriétaire a déjà tous les droits sur cet espace');
      }
      grantee = `user:${dto.userGroupId}`;
    } else {
      const role = await this.prisma.role.findUnique({
        where: { roleId: dto.roleId as number },
        select: { isActive: true },
      });
      if (!role || !role.isActive) throw new BadRequestException('Rôle introuvable ou inactif');
      grantee = `role:${dto.roleId}`;
    }

    const existing = await this.prisma.gedSpaceMember.findFirst({
      where:
        dto.userGroupId !== undefined
          ? { spaceId, userGroupId: dto.userGroupId }
          : { spaceId, roleId: dto.roleId },
      select: { gedSpaceMemberId: true },
    });
    if (existing) throw new ConflictException('Ce bénéficiaire est déjà membre de l’espace');

    let created: MemberRow;
    try {
      created = await this.prisma.gedSpaceMember.create({
        data: {
          spaceId,
          userGroupId: dto.userGroupId ?? null,
          roleId: dto.roleId ?? null,
          permission: dto.permission,
          addedBy: user.userGroupId,
        },
        select: memberRowSelect,
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('Ce bénéficiaire est déjà membre de l’espace');
      }
      throw e;
    }
    await this.writeAudit(
      user,
      `space:${spaceId}`,
      `member-added:${grantee}:perm=${dto.permission}`,
    );
    return this.toMemberRow(created);
  }

  private async findMember(spaceId: number, memberId: number) {
    const member = await this.prisma.gedSpaceMember.findFirst({
      where: { gedSpaceMemberId: memberId, spaceId },
      select: memberRowSelect,
    });
    if (!member) throw new NotFoundException('Membre introuvable');
    return member;
  }

  private static granteeRef(m: { userGroupId: number | null; roleId: number | null }) {
    return m.userGroupId != null ? `user:${m.userGroupId}` : `role:${m.roleId}`;
  }

  async updateMember(
    spaceId: number,
    memberId: number,
    dto: UpdateMemberDto,
    user: AuthUser,
  ): Promise<GedSpaceMemberRow> {
    const { space } = await this.authorize(spaceId, user, 'manage');
    this.assertNotPrivate(space);
    const member = await this.findMember(spaceId, memberId);
    if (member.permission === dto.permission) return this.toMemberRow(member);

    const updated = await this.prisma.gedSpaceMember.update({
      where: { gedSpaceMemberId: memberId },
      data: { permission: dto.permission },
      select: memberRowSelect,
    });
    await this.writeAudit(
      user,
      `space:${spaceId}`,
      `member-updated:${SpacesService.granteeRef(member)}:perm=${dto.permission}`,
      `perm=${member.permission}`,
    );
    return this.toMemberRow(updated);
  }

  async removeMember(spaceId: number, memberId: number, user: AuthUser): Promise<{ ok: true }> {
    const { space } = await this.authorize(spaceId, user, 'manage');
    this.assertNotPrivate(space);
    const member = await this.findMember(spaceId, memberId);
    await this.prisma.gedSpaceMember.delete({ where: { gedSpaceMemberId: memberId } });
    await this.writeAudit(
      user,
      `space:${spaceId}`,
      `member-removed:${SpacesService.granteeRef(member)}`,
      `perm=${member.permission}`,
    );
    return { ok: true };
  }

  /**
   * Bénéficiaires proposables : utilisateurs non désactivés (un compte-groupe chacun, le défaut en
   * priorité) et rôles actifs. Champs minimaux : ni courriel, ni service, ni habilitation.
   *
   * Réservé à qui peut AJOUTER un membre quelque part : propriétaire ou gestionnaire (permission 2,
   * par compte-groupe ou rôle actif) d'au moins un espace ACTIF NON PRIVÉ — sinon 403. L'annuaire
   * n'est pas exposé à tout porteur du menu. L'administrateur suit la règle commune (il n'a aucun
   * droit implicite de gestion sur les espaces d'autrui) : sans espace qu'il possède ou gère, 403.
   */
  async memberCandidates(user: AuthUser): Promise<GedSpaceMemberCandidates> {
    const actor = await this.resolveActor(user);
    const managed = await this.prisma.gedSpace.findFirst({
      where: {
        isActive: true,
        kind: { in: [GedSpaceKind.Partage, GedSpaceKind.Collaboration, GedSpaceKind.Publication] },
        OR: [
          { ownerUserGroupId: { in: [...actor.userGroupIds] } },
          {
            members: {
              some: { AND: [memberFilter(actor), { permission: GedSpacePermissionValue.Gestion }] },
            },
          },
        ],
      },
      select: { gedSpaceId: true },
    });
    if (!managed) {
      throw new ForbiddenException(
        'Réservé au propriétaire ou au gestionnaire d’un espace partagé',
      );
    }

    const [users, roles] = await Promise.all([
      this.prisma.appUser.findMany({
        where: { isDisabled: false },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { userId: 'asc' }],
        select: {
          username: true,
          fullName: true,
          userGroups: {
            orderBy: [{ isDefault: 'desc' }, { userGroupId: 'asc' }],
            take: 1,
            select: { userGroupId: true },
          },
        },
      }),
      this.prisma.role.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { roleId: true, name: true },
      }),
    ]);
    return {
      users: users
        .filter((u) => u.userGroups.length > 0)
        .map((u) => ({
          userGroupId: u.userGroups[0].userGroupId,
          fullName: u.fullName?.trim() || u.username,
          username: u.username,
        })),
      roles: roles.map((r) => ({ roleId: r.roleId, label: r.name })),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------------------------

  /**
   * Documents rattachés que l'acteur peut VOIR, dans l'ordre stable `addedAt` décroissant puis
   * `documentId` croissant : chacun passe `DocumentsService.canAccess`, et un lecteur de
   * publication ne voit en plus que les documents sans confidentialité.
   *
   * `stopAfter` : arrêt dès que ce nombre de documents visibles est atteint (pagination) ; absent,
   * tout est filtré (compte de `getDetail`).
   */
  private async visibleDocuments(
    spaceId: number,
    user: AuthUser,
    decision: SpaceAccessDecision,
    stopAfter = Number.POSITIVE_INFINITY,
  ): Promise<SpaceDocumentRow[]> {
    const rows = await this.prisma.gedSpaceDocument.findMany({
      where: { spaceId },
      orderBy: [{ addedAt: 'desc' }, { documentId: 'asc' }],
      select: spaceDocumentSelect,
    });
    // Pré-filtre sans requête (portée publique), puis verdict documentaire.
    const candidates = rows.filter((r) =>
      isDocumentListable(r.document, decision.documentScope, true),
    );
    const visible: SpaceDocumentRow[] = [];
    for (
      let i = 0;
      i < candidates.length && visible.length < stopAfter;
      i += CAN_ACCESS_CONCURRENCY
    ) {
      const chunk = candidates.slice(i, i + CAN_ACCESS_CONCURRENCY);
      const verdicts = await Promise.all(
        chunk.map((r) => this.documents.canAccess(r.document.documentId, user)),
      );
      chunk.forEach((r, k) => {
        if (isDocumentListable(r.document, decision.documentScope, verdicts[k] === true)) {
          visible.push(r);
        }
      });
    }
    return visible;
  }

  /**
   * Page des documents VISIBLES de l'espace. Le filtrage (`canAccess`, confidentialité pour un
   * lecteur de publication) s'applique AVANT la coupe `offset`/`limit` : une page ne contient que
   * des documents visibles et la pagination ne trahit pas l'existence des masqués (ni trous ni
   * pages courtes révélatrices). Aucun total n'est renvoyé.
   */
  async listDocuments(
    spaceId: number,
    user: AuthUser,
    page: DocumentPage = DEFAULT_DOCUMENT_PAGE,
  ): Promise<GedSpaceDocumentRow[]> {
    const { decision } = await this.authorize(spaceId, user, 'read');
    const visible = await this.visibleDocuments(spaceId, user, decision, page.offset + page.limit);
    return visible.slice(page.offset, page.offset + page.limit).map((r) => this.toDocumentRow(r));
  }

  async attachDocument(
    spaceId: number,
    dto: AttachDocumentDto,
    user: AuthUser,
  ): Promise<GedSpaceDocumentRow> {
    await this.authorize(spaceId, user, 'contribute');
    // Inexistant ou non accessible : même réponse, pour ne pas révéler l'existence du document.
    if (!(await this.documents.canAccess(dto.documentId, user))) {
      throw new NotFoundException('Document introuvable');
    }
    // Règle de gestion (décision du 2026-11-22) : seuls les documents ARCHIVÉS (validés) se
    // rattachent à un espace. Vérifiée APRÈS `canAccess` : un tiers n'apprend rien de l'état d'un
    // document qu'il ne voit pas. Le document créé par l'éditeur dans son espace d'origine
    // (`CollabPersistenceService`) n'emprunte pas cette route.
    const target = await this.prisma.document.findUnique({
      where: { documentId: dto.documentId },
      select: { isArchived: true },
    });
    if (!target) throw new NotFoundException('Document introuvable');
    if (!target.isArchived) throw new ConflictException(NOT_ARCHIVED_MESSAGE);
    const existing = await this.prisma.gedSpaceDocument.findUnique({
      where: { spaceId_documentId: { spaceId, documentId: dto.documentId } },
      select: { documentId: true },
    });
    if (existing) throw new ConflictException('Ce document est déjà rattaché à l’espace');

    let created: SpaceDocumentRow;
    try {
      created = await this.prisma.gedSpaceDocument.create({
        data: { spaceId, documentId: dto.documentId, addedBy: user.userGroupId },
        select: spaceDocumentSelect,
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('Ce document est déjà rattaché à l’espace');
      }
      throw e;
    }
    await this.writeAudit(user, `space:${spaceId}`, `document-attached:${dto.documentId}`);
    await this.writeAudit(user, `document:${dto.documentId}`, `space-attached:${spaceId}`);
    return this.toDocumentRow(created);
  }

  /**
   * Détache un document (le document lui-même n'est jamais supprimé).
   *
   *  - propriétaire ou gestionnaire (permission 2) : SANS `canAccess` — il doit pouvoir retirer de
   *    SON espace une pièce devenue invisible pour lui (confidentialité relevée, droit retiré) ;
   *    détacher ne lui donne rien à lire ;
   *  - simple contributeur (permission 1) : `canAccess` exigé — il n'agit pas à l'aveugle sur une
   *    pièce qu'il ne voit pas et ne peut pas s'en servir pour sonder son existence.
   */
  async detachDocument(spaceId: number, documentId: number, user: AuthUser): Promise<{ ok: true }> {
    const { decision } = await this.authorize(spaceId, user, 'contribute');
    if (!decision.canManage && !(await this.documents.canAccess(documentId, user))) {
      throw new NotFoundException('Document introuvable');
    }
    const existing = await this.prisma.gedSpaceDocument.findUnique({
      where: { spaceId_documentId: { spaceId, documentId } },
      select: { documentId: true },
    });
    if (!existing) throw new NotFoundException('Ce document n’est pas rattaché à l’espace');

    await this.prisma.gedSpaceDocument.delete({
      where: { spaceId_documentId: { spaceId, documentId } },
    });
    await this.writeAudit(user, `space:${spaceId}`, `document-detached:${documentId}`);
    await this.writeAudit(user, `document:${documentId}`, `space-detached:${spaceId}`);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------
  // Publication
  // ---------------------------------------------------------------------------------------------

  private async deriveSlug(label: string): Promise<string> {
    const base = slugify(label);
    const taken = await this.prisma.gedSpace.findMany({
      where: { publicationSlug: { startsWith: base } },
      select: { publicationSlug: true },
    });
    return nextAvailableSlug(
      base,
      new Set(taken.map((t) => t.publicationSlug).filter((s): s is string => s != null)),
    );
  }

  async publish(
    spaceId: number,
    dto: PublishSpaceDto,
    user: AuthUser,
  ): Promise<GedSpacePublishResult> {
    const { space, actor } = await this.authorize(spaceId, user, 'manage');
    if (!canPublish(space.kind)) {
      throw new ConflictException(
        "Un espace privé ne peut pas être publié : partagez-le d'abord (nature Partage ou Collaboration)",
      );
    }

    let slug: string;
    if (dto.slug) {
      const holder = await this.prisma.gedSpace.findFirst({
        where: { publicationSlug: dto.slug, NOT: { gedSpaceId: spaceId } },
        select: { gedSpaceId: true },
      });
      if (holder) throw new ConflictException('Ce slug est déjà utilisé par une autre publication');
      slug = dto.slug;
    } else {
      slug = space.publicationSlug ?? (await this.deriveSlug(space.label));
    }

    try {
      await this.prisma.gedSpace.update({
        where: { gedSpaceId: spaceId },
        data: { kind: GedSpaceKind.Publication, publicationSlug: slug, publishedAt: new Date() },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('Ce slug est déjà utilisé par une autre publication');
      }
      throw e;
    }
    await this.writeAudit(
      user,
      `space:${spaceId}`,
      `published:slug=${slug}`,
      `kind=${space.kind}${space.publicationSlug ? `;slug=${space.publicationSlug}` : ''}`,
    );

    const nonPublishableCount = await this.prisma.gedSpaceDocument.count({
      where: { spaceId, document: { confidentialiteId: { not: null } } },
    });
    const after = await this.reload(spaceId, actor);
    return { space: this.toSummary(after.space, after.decision), nonPublishableCount };
  }

  /** Dépublication : retour à « Partage », slug libéré (réutilisable par une autre publication). */
  async unpublish(spaceId: number, user: AuthUser): Promise<GedSpaceSummary> {
    const { space, actor } = await this.authorize(spaceId, user, 'manage');
    if (space.kind !== GedSpaceKind.Publication) {
      throw new ConflictException("L'espace n'est pas publié");
    }
    await this.prisma.gedSpace.update({
      where: { gedSpaceId: spaceId },
      data: { kind: GedSpaceKind.Partage, publicationSlug: null, publishedAt: null },
    });
    await this.writeAudit(
      user,
      `space:${spaceId}`,
      'unpublished',
      space.publicationSlug ? `slug=${space.publicationSlug}` : undefined,
    );
    const after = await this.reload(spaceId, actor);
    return this.toSummary(after.space, after.decision);
  }
}
