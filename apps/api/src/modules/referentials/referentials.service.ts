import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { exportRows, type ExportFormat } from '@archivage/exports';
import { PrismaService } from '../prisma/prisma.service';
import { HierarchyService } from '../../common/hierarchy.service';
import { findLabelConflict } from '../courriers/domain/label-normalisation';
import type {
  CreateConfidentialiteDto,
  CreateDocumentTypeDto,
  CreateDossierDto,
  CreateFileTypeDto,
  CreatePlanDto,
  CreateTreeNodeDto,
  GrantDocumentPermissionDto,
  GrantTypePermissionDto,
  UpdateConfidentialiteDto,
  UpdateDocumentTypeDto,
  UpdateDossierDto,
  UpdateLocationDto,
  UpdatePlanDto,
} from './referentials.dto';

/** Code d'une erreur Prisma connue (`P2002` unicité, `P2003` clé étrangère, `P2025` introuvable). */
function prismaCode(e: unknown): string | undefined {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Filet de sécurité des écritures : le contrôle applicatif précède toujours l'écriture, mais une
 * course (deux créations simultanées du même libellé, du même rang) atteint quand même l'index
 * unique. Sans cette traduction, le filtre global la rendait en 500 générique.
 */
async function conflictOnDuplicate<T>(write: Promise<T>, message: string): Promise<T> {
  try {
    return await write;
  } catch (e) {
    if (prismaCode(e) === 'P2002') throw new ConflictException(message);
    throw e;
  }
}

@Injectable()
export class ReferentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: HierarchyService,
  ) {}

  // ---- Document types (flat) ------------------------------------------------
  listDocumentTypes() {
    return this.prisma.documentType.findMany({ where: { isActive: true }, orderBy: { label: 'asc' } });
  }

  async createDocumentType(input: CreateDocumentTypeDto) {
    const dup = await this.prisma.documentType.findFirst({
      where: { label: input.label, isActive: true },
      select: { documentTypeId: true },
    });
    if (dup) throw new ConflictException('Un type de document actif porte déjà ce libellé');
    return conflictOnDuplicate(
      this.prisma.documentType.create({ data: { label: input.label, code: input.code ?? null } }),
      'Un type de document actif porte déjà ce libellé',
    );
  }

  async updateDocumentType(documentTypeId: number, input: UpdateDocumentTypeDto) {
    const node = await this.prisma.documentType.findUnique({
      where: { documentTypeId },
      select: { documentTypeId: true },
    });
    if (!node) throw new NotFoundException('Type de document introuvable');
    const dup = await this.prisma.documentType.findFirst({
      where: { label: input.label, isActive: true, documentTypeId: { not: documentTypeId } },
      select: { documentTypeId: true },
    });
    if (dup) throw new ConflictException('Un type de document actif porte déjà ce libellé');
    return conflictOnDuplicate(
      this.prisma.documentType.update({ where: { documentTypeId }, data: { label: input.label } }),
      'Un type de document actif porte déjà ce libellé',
    );
  }

  /**
   * Désactivation (le type reste référencé par ses documents). Un identifiant inconnu rendait
   * l'erreur Prisma P2025 brute, donc un 500 : il rend désormais 404, comme les autres référentiels.
   */
  async deactivateDocumentType(documentTypeId: number) {
    const node = await this.prisma.documentType.findUnique({
      where: { documentTypeId },
      select: { documentTypeId: true },
    });
    if (!node) throw new NotFoundException('Type de document introuvable');
    await this.prisma.documentType.update({ where: { documentTypeId }, data: { isActive: false } });
    return { deactivated: true };
  }

  /** Export the active document types (flat list, label only). */
  async exportDocumentTypes(format: ExportFormat) {
    const types = await this.prisma.documentType.findMany({ where: { isActive: true }, orderBy: { label: 'asc' } });
    const res = await exportRows(format, {
      title: 'Types de document',
      columns: [{ key: 'label', header: 'Libellé' }],
      rows: types.map((t) => ({ label: t.label })),
    });
    return { ...res, filename: `types-document.${format}` };
  }

  // ---- File types (unique extension) ---------------------------------------
  listFileTypes() {
    return this.prisma.fileType.findMany({ where: { isActive: true }, orderBy: { extension: 'asc' } });
  }

  // ---- Authors (« Ajouté par ») --------------------------------------------
  /** Distinct users who have created at least one document, for the search "Ajouté par" filter. */
  /** Trié par `rank` : c'est l'ordre qui porte la règle d'accès, pas le libellé. */
  listConfidentialites() {
    return this.prisma.confidentialite.findMany({
      where: { isActive: true },
      select: { confidentialiteId: true, label: true, rank: true },
      orderBy: { rank: 'asc' },
    });
  }

  /**
   * Sécurité Documentaire — CRUD du référentiel confidentialités (jusqu'ici lecture seule).
   * `rank` est auto-assigné : +10 après le plus haut rang actif, pour préserver l'espacement du
   * seed (Public 0 / Interne 10 / Confidentiel 20 / Secret 30) plutôt que le laisser saisir.
   */
  async createConfidentialite(input: CreateConfidentialiteDto) {
    await this.assertConfidentialiteLabelFree(input.label, null);
    const max = await this.prisma.confidentialite.aggregate({ _max: { rank: true } });
    const rank = (max._max.rank ?? -10) + 10;
    // P2002 restant = course : même libellé, ou même rang calculé par deux créations simultanées.
    return conflictOnDuplicate(
      this.prisma.confidentialite.create({ data: { label: input.label, rank } }),
      'Un niveau de confidentialité actif porte déjà ce libellé ou ce rang — réessayez',
    );
  }

  async updateConfidentialite(confidentialiteId: number, input: UpdateConfidentialiteDto) {
    const node = await this.prisma.confidentialite.findUnique({
      where: { confidentialiteId },
      select: { confidentialiteId: true },
    });
    if (!node) throw new NotFoundException('Niveau de confidentialité introuvable');
    await this.assertConfidentialiteLabelFree(input.label, confidentialiteId);
    return conflictOnDuplicate(
      this.prisma.confidentialite.update({ where: { confidentialiteId }, data: { label: input.label } }),
      'Un niveau de confidentialité actif porte déjà ce libellé',
    );
  }

  /**
   * Unicité du libellé parmi les niveaux ACTIFS, insensible à la casse et aux espaces : c'est la
   * sémantique de l'index `confidentialite_label_active_key` (`lower(replace(label, ' ', ''))`).
   * La comparaison au libellé brut laissait passer « secret » à côté de « Secret », que l'index
   * refusait ensuite en 500 au lieu du 409 attendu.
   */
  private async assertConfidentialiteLabelFree(label: string, excludeId: number | null) {
    const active = await this.prisma.confidentialite.findMany({
      where: { isActive: true },
      select: { confidentialiteId: true, label: true },
    });
    const rows = active.map((r) => ({ id: r.confidentialiteId, label: r.label }));
    if (findLabelConflict(label, rows, excludeId)) {
      throw new ConflictException('Un niveau de confidentialité actif porte déjà ce libellé');
    }
  }

  /** Désactivation ; un identifiant inconnu rend 404 (P2025 brut = 500 auparavant). */
  async deactivateConfidentialite(confidentialiteId: number) {
    const node = await this.prisma.confidentialite.findUnique({
      where: { confidentialiteId },
      select: { confidentialiteId: true },
    });
    if (!node) throw new NotFoundException('Niveau de confidentialité introuvable');
    await this.prisma.confidentialite.update({ where: { confidentialiteId }, data: { isActive: false } });
    return { deactivated: true };
  }

  /**
   * Référentiel figé (`permission_level_id` = valeurs de domaine, pas un autoincrement).
   *
   * Exclut `1 Denied` (2026-08-04) : c'est l'ABSENCE de droit qui vaut refus (deny-by-default hors
   * confidentialité), pas une ligne à accorder explicitement — il n'a donc rien à faire dans les
   * listes déroulantes d'octroi (`AccessTab`, `TypeSecurityPage`). `DocumentTabsService.grantPermission`
   * le refuse aussi côté serveur, pour un appel direct à l'API qui contournerait cet écran.
   */
  listPermissionLevels() {
    return this.prisma.permissionLevel.findMany({
      where: { permissionLevelId: { not: 1 } },
      select: { permissionLevelId: true, name: true },
      orderBy: { permissionLevelId: 'asc' },
    });
  }

  async listAuthors(): Promise<Array<{ userId: number; label: string }>> {
    const groups = await this.prisma.appUserGroup.findMany({
      where: { documentsCreated: { some: {} } },
      select: { userId: true, user: { select: { fullName: true, username: true } } },
    });
    // A user may hold several group accounts (created_by points at a user_group); collapse per user.
    const byUser = new Map<number, string>();
    for (const g of groups) {
      if (!byUser.has(g.userId)) byUser.set(g.userId, g.user.fullName?.trim() || g.user.username);
    }
    return [...byUser]
      .map(([userId, label]) => ({ userId, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }

  async createFileType(input: CreateFileTypeDto) {
    const ext = input.extension.startsWith('.') ? input.extension : `.${input.extension}`;
    const dup = await this.prisma.fileType.findUnique({ where: { extension: ext } });
    if (dup) throw new ConflictException('Cette extension existe déjà');
    return this.prisma.fileType.create({
      data: { extension: ext, friendlyName: input.friendlyName, isMedia: input.isMedia ?? false },
    });
  }

  // ---- Hierarchies (plan / location / dossier) -----------------------------
  listPlans() {
    return this.prisma.classificationPlan.findMany({ where: { isActive: true }, orderBy: { path: 'asc' } });
  }

  listLocations() {
    return this.prisma.location.findMany({ where: { isActive: true }, orderBy: { path: 'asc' } });
  }

  listDossiers() {
    return this.prisma.dossier.findMany({ where: { isActive: true }, orderBy: { path: 'asc' } });
  }

  async createPlan(input: CreatePlanDto) {
    const { parentPath, depth } = await this.resolveParent('classificationPlan', input.parentId);
    const node = await this.prisma.classificationPlan.create({
      // `?? null` explicite : un parent absent crée une RACINE, il ne laisse pas la colonne
      // « non renseignée » au sens Prisma.
      data: { label: input.label, code: input.code ?? null, parentId: input.parentId ?? null, depth, path: '/' },
    });
    return this.prisma.classificationPlan.update({
      where: { planId: node.planId },
      data: { path: this.hierarchy.childPath(parentPath, node.planId) },
    });
  }

  /** Inline edit of a classification plan's label and/or code (code may be cleared). */
  async updatePlan(planId: number, input: UpdatePlanDto) {
    const node = await this.prisma.classificationPlan.findUnique({ where: { planId }, select: { planId: true } });
    if (!node) throw new NotFoundException('Plan de classement introuvable');
    return this.prisma.classificationPlan.update({
      where: { planId },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.code !== undefined ? { code: input.code === '' ? null : input.code } : {}),
      },
    });
  }

  /**
   * Soft-delete a classification plan node and its whole subtree.
   * Walks descendants by parentId (robust to the legacy, non-standard `path` values in this table).
   */
  async deactivatePlan(planId: number) {
    const node = await this.prisma.classificationPlan.findUnique({ where: { planId }, select: { planId: true } });
    if (!node) throw new NotFoundException('Plan de classement introuvable');

    const all = await this.prisma.classificationPlan.findMany({ select: { planId: true, parentId: true } });
    const childrenByParent = new Map<number, number[]>();
    for (const p of all) {
      if (p.parentId != null) {
        const siblings = childrenByParent.get(p.parentId) ?? [];
        siblings.push(p.planId);
        childrenByParent.set(p.parentId, siblings);
      }
    }
    const ids: number[] = [];
    const stack = [planId];
    while (stack.length) {
      const id = stack.pop() as number;
      ids.push(id);
      for (const child of childrenByParent.get(id) ?? []) stack.push(child);
    }
    await this.prisma.classificationPlan.updateMany({
      where: { planId: { in: ids } },
      data: { isActive: false },
    });
    return { deactivated: true, count: ids.length };
  }

  /** Export the active classification plan tree (label indented by depth; parent resolved to label). */
  async exportPlans(format: ExportFormat) {
    const plans = await this.prisma.classificationPlan.findMany({ where: { isActive: true }, orderBy: { path: 'asc' } });
    const labelById = new Map(plans.map((p) => [p.planId, p.label]));
    const rows = plans.map((p) => ({
      label: `${'    '.repeat(p.depth)}${p.label}`,
      code: p.code ?? '',
      parent: p.parentId != null ? (labelById.get(p.parentId) ?? '') : '',
    }));
    const res = await exportRows(format, {
      title: 'Plan de classement',
      columns: [
        { key: 'label', header: "Nom de l'élément" },
        { key: 'code', header: 'Code' },
        { key: 'parent', header: 'Parent' },
      ],
      rows,
    });
    return { ...res, filename: `plan-classement.${format}` };
  }

  async createLocation(input: CreateTreeNodeDto) {
    const { parentPath, depth } = await this.resolveParent('location', input.parentId);
    const node = await this.prisma.location.create({
      data: { label: input.label, code: input.code ?? null, parentId: input.parentId ?? null, depth, path: '/' },
    });
    return this.prisma.location.update({
      where: { locationId: node.locationId },
      data: { path: this.hierarchy.childPath(parentPath, node.locationId) },
    });
  }

  /** Inline edit of a geolocation node's label and/or code. */
  async updateLocation(locationId: number, input: UpdateLocationDto) {
    const node = await this.prisma.location.findUnique({ where: { locationId }, select: { locationId: true } });
    if (!node) throw new NotFoundException('Localisation introuvable');
    return this.prisma.location.update({
      where: { locationId },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.code !== undefined ? { code: input.code } : {}),
      },
    });
  }

  /** Export the active geolocation tree (label indented by depth to show the hierarchy). */
  async exportLocations(format: ExportFormat) {
    const locs = await this.prisma.location.findMany({ where: { isActive: true }, orderBy: { path: 'asc' } });
    const labelById = new Map(locs.map((l) => [l.locationId, l.label]));
    const rows = locs.map((l) => ({
      label: `${'    '.repeat(l.depth)}${l.label}`,
      code: l.code ?? '',
      parent: l.parentId != null ? (labelById.get(l.parentId) ?? '') : '',
    }));
    const res = await exportRows(format, {
      title: 'Géolocalisation',
      columns: [
        { key: 'label', header: "Nom de l'élément" },
        { key: 'code', header: 'Code' },
        { key: 'parent', header: 'Parent' },
      ],
      rows,
    });
    return { ...res, filename: `geolocalisation.${format}` };
  }

  /** Export the active dossier categories (flat list). */
  /** Soft-delete a geolocation node and its whole subtree (keeps children from orphaning). */
  async deactivateLocation(locationId: number) {
    const node = await this.prisma.location.findUnique({ where: { locationId }, select: { path: true } });
    if (!node) throw new NotFoundException('Localisation introuvable');
    await this.prisma.location.updateMany({
      where: { path: { startsWith: node.path } },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  async createDossier(input: CreateDossierDto) {
    const dup = await this.prisma.dossier.findFirst({
      where: { label: input.label, isActive: true },
      select: { dossierId: true },
    });
    if (dup) throw new ConflictException('Un dossier actif porte déjà ce libellé');

    const { parentPath, depth } = await this.resolveParent('dossier', input.parentId);
    const node = await conflictOnDuplicate(
      this.prisma.dossier.create({
        data: {
          label: input.label,
          code: input.code ?? null,
          parentId: input.parentId ?? null,
          depth,
          path: '/',
        },
      }),
      'Un dossier actif porte déjà ce libellé',
    );
    return this.prisma.dossier.update({
      where: { dossierId: node.dossierId },
      data: { path: this.hierarchy.childPath(parentPath, node.dossierId) },
    });
  }

  /** Move a dossier and recompute the whole moved subtree's path/depth (representative path-recompute). */
  async reparentDossier(dossierId: number, newParentId: number | null) {
    const node = await this.prisma.dossier.findUnique({ where: { dossierId } });
    if (!node) throw new NotFoundException('Dossier introuvable');

    let parentPath: string | null = null;
    let parentDepth = -1;
    if (newParentId != null) {
      const parent = await this.prisma.dossier.findUnique({ where: { dossierId: newParentId } });
      // Un parent désactivé vaut un parent absent : l'écran ne le liste plus, le dossier déplacé
      // sous lui s'afficherait comme une racine orpheline.
      if (!parent || !parent.isActive) throw new BadRequestException('Dossier parent introuvable');
      if (parent.path.startsWith(node.path)) throw new BadRequestException('Déplacement cyclique interdit');
      parentPath = parent.path;
      parentDepth = parent.depth;
    }

    const oldPath = node.path;
    const newPath = this.hierarchy.childPath(parentPath, dossierId);
    const subtree = await this.prisma.dossier.findMany({ where: { path: { startsWith: oldPath } } });

    for (const d of subtree) {
      const suffix = d.path.slice(oldPath.length);
      const path = `${newPath}${suffix}`;
      await this.prisma.dossier.update({
        where: { dossierId: d.dossierId },
        data: {
          path,
          depth: this.hierarchy.depthOf(path),
          ...(d.dossierId === dossierId ? { parentId: newParentId } : {}),
        },
      });
    }
    return { moved: true, depth: parentDepth + 1 };
  }

  /** Inline edit of a dossier's label and/or code. */
  async updateDossier(dossierId: number, input: UpdateDossierDto) {
    const node = await this.prisma.dossier.findUnique({ where: { dossierId }, select: { dossierId: true } });
    if (!node) throw new NotFoundException('Dossier introuvable');
    if (input.label !== undefined) {
      const dup = await this.prisma.dossier.findFirst({
        where: { label: input.label, isActive: true, dossierId: { not: dossierId } },
        select: { dossierId: true },
      });
      if (dup) throw new ConflictException('Un dossier actif porte déjà ce libellé');
    }
    return conflictOnDuplicate(
      this.prisma.dossier.update({
        where: { dossierId },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.code !== undefined ? { code: input.code } : {}),
        },
      }),
      'Un dossier actif porte déjà ce libellé',
    );
  }

  /** Soft-delete a dossier and its whole subtree (keeps children from orphaning). */
  async deactivateDossier(dossierId: number) {
    const node = await this.prisma.dossier.findUnique({ where: { dossierId }, select: { path: true } });
    if (!node) throw new NotFoundException('Dossier introuvable');
    await this.prisma.dossier.updateMany({
      where: { path: { startsWith: node.path } },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  /** Export the active dossier tree (label indented by depth; parent resolved to its label). */
  async exportDossiers(format: ExportFormat) {
    const dossiers = await this.prisma.dossier.findMany({
      where: { isActive: true },
      orderBy: { path: 'asc' },
    });
    const dossierLabelById = new Map(dossiers.map((d) => [d.dossierId, d.label]));
    const rows = dossiers.map((d) => ({
      label: `${'    '.repeat(d.depth)}${d.label}`,
      code: d.code ?? '',
      parent: d.parentId != null ? (dossierLabelById.get(d.parentId) ?? '') : '',
    }));
    const res = await exportRows(format, {
      title: 'Dossiers',
      columns: [
        { key: 'label', header: "Nom de l'élément" },
        { key: 'code', header: 'Code' },
        { key: 'parent', header: 'Élément parent' },
      ],
      rows,
    });
    return { ...res, filename: `dossiers.${format}` };
  }

  // ---- Permission grants ----------------------------------------------------
  async grantDocumentPermission(input: GrantDocumentPermissionDto) {
    try {
      return await this.prisma.documentPermission.upsert({
        where: {
          documentId_userGroupId_permissionLevelId: {
            documentId: input.documentId,
            userGroupId: input.userGroupId,
            permissionLevelId: input.permissionLevelId,
          },
        },
        update: {},
        create: input,
      });
    } catch (e) {
      // Document, acteur ou niveau inexistant : clé étrangère violée, rendue en 500 auparavant.
      if (prismaCode(e) === 'P2003') {
        throw new BadRequestException('Document, utilisateur ou niveau de permission introuvable');
      }
      throw e;
    }
  }

  /**
   * Octroi d'un droit par type. Chaque référence est vérifiée AVANT l'écriture : un identifiant
   * inconnu violait une clé étrangère, rendue en 500 par le filtre global.
   *
   * « Denied » (niveau 1) est refusé, comme dans `DocumentTabsService.grantPermission` et comme
   * l'exige la recette (« un appel API direct avec le niveau 1 est refusé ») : l'écran ne le
   * propose pas, et une telle ligne n'aurait de toute façon aucun effet — la visibilité par type ne
   * compte que les niveaux ≥ 2, l'absence de droit tenant lieu de refus.
   */
  async grantTypePermission(input: GrantTypePermissionDto) {
    if (input.permissionLevelId === 1) {
      throw new BadRequestException('Le niveau « Denied » ne peut pas être accordé explicitement');
    }
    const [type, level] = await Promise.all([
      this.prisma.documentType.findUnique({
        where: { documentTypeId: input.documentTypeId },
        select: { isActive: true },
      }),
      this.prisma.permissionLevel.findUnique({
        where: { permissionLevelId: input.permissionLevelId },
        select: { permissionLevelId: true },
      }),
    ]);
    if (!type || !type.isActive) throw new BadRequestException('Type de document introuvable');
    if (!level) throw new BadRequestException('Niveau de permission inconnu');
    if (input.roleId != null) {
      const role = await this.prisma.role.findUnique({
        where: { roleId: input.roleId },
        select: { roleId: true },
      });
      if (!role) throw new BadRequestException('Rôle introuvable');
    }
    if (input.userGroupId != null) {
      const actor = await this.prisma.appUserGroup.findUnique({
        where: { userGroupId: input.userGroupId },
        select: { userGroupId: true },
      });
      if (!actor) throw new BadRequestException('Utilisateur introuvable');
    }
    return this.prisma.documentTypePermission.create({
      data: {
        documentTypeId: input.documentTypeId,
        permissionLevelId: input.permissionLevelId,
        roleId: input.roleId ?? null,
        userGroupId: input.userGroupId ?? null,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
      },
    });
  }

  /**
   * Droits par TYPE de document, acteurs nommés ET rôles confondus — même patron que
   * `DocumentTabsService.listPermissions` pour les droits par document : les écrans « Sécurité type
   * document par utilisateur »/« par rôle »/« par classification » lisent tous cette même liste,
   * `scope` disant lequel est lequel.
   */
  async listTypePermissions() {
    const rows = await this.prisma.documentTypePermission.findMany({
      select: {
        documentTypePermissionId: true,
        documentTypeId: true,
        documentType: { select: { label: true } },
        permissionLevelId: true,
        permissionLevel: { select: { name: true } },
        roleId: true,
        role: { select: { roleId: true, name: true } },
        userGroupId: true,
        userGroup: {
          select: {
            userGroupId: true,
            user: { select: { fullName: true, username: true } },
            group: { select: { name: true } },
          },
        },
        startDate: true,
        endDate: true,
      },
      orderBy: { documentTypePermissionId: 'desc' },
    });
    return rows.map((r) => ({
      documentTypePermissionId: r.documentTypePermissionId,
      documentTypeId: r.documentTypeId,
      documentTypeLabel: r.documentType.label,
      permissionLevelId: r.permissionLevelId,
      permissionLevelName: r.permissionLevel.name,
      scope: r.roleId != null ? ('role' as const) : ('user' as const),
      // Identifiant du bénéficiaire collectif : l'écran « par rôle » regroupe ses lignes dessus, et
      // non sur `label` — rien n'impose l'unicité du nom d'un rôle.
      roleId: r.roleId,
      userGroupId: r.userGroupId,
      label:
        r.roleId != null
          ? (r.role?.name ?? `Rôle #${r.roleId}`)
          : r.userGroup?.user?.fullName || r.userGroup?.user?.username || `#${r.userGroupId}`,
      // Profil de l'acteur nommé, affiché en second rang par l'écran « par utilisateur ». Un droit
      // « par rôle » n'a pas d'acteur, donc pas de profil à montrer.
      groupName: r.roleId != null ? null : (r.userGroup?.group?.name ?? null),
      startDate: r.startDate,
      endDate: r.endDate,
    }));
  }

  async revokeTypePermission(documentTypePermissionId: number) {
    const { count } = await this.prisma.documentTypePermission.deleteMany({
      where: { documentTypePermissionId },
    });
    if (count === 0) throw new NotFoundException('Droit introuvable');
    return { deleted: count };
  }

  /**
   * Plans de classement ayant AU MOINS un type de document rattaché (paramétrage), avec la liste
   * de ces types — legacy `GetClassificationsWithDocumentTypes`, pour « Sécurité par
   * classification » : la page résout le produit cartésien acteur × type côté client à partir
   * de ce lookup, sans table dédiée (façade de saisie sur `document_type_permission`).
   */
  async listPlansWithDocumentTypes() {
    const settings = await this.prisma.documentTypeSetting.findMany({
      where: { planId: { not: null } },
      select: { planId: true, documentTypeId: true },
    });
    const byPlan = new Map<number, number[]>();
    for (const s of settings) {
      if (s.planId == null) continue;
      const list = byPlan.get(s.planId) ?? [];
      list.push(s.documentTypeId);
      byPlan.set(s.planId, list);
    }
    if (byPlan.size === 0) return [];
    const plans = await this.prisma.classificationPlan.findMany({
      where: { planId: { in: [...byPlan.keys()] }, isActive: true },
      select: { planId: true, label: true },
    });
    return plans.map((p) => ({
      planId: p.planId,
      label: p.label,
      documentTypeIds: byPlan.get(p.planId) ?? [],
    }));
  }

  private async resolveParent(
    kind: 'classificationPlan' | 'location' | 'dossier',
    parentId?: number,
  ): Promise<{ parentPath: string | null; depth: number }> {
    if (parentId == null) return { parentPath: null, depth: 0 };
    const select = { path: true, depth: true, isActive: true } as const;
    let parent: { path: string; depth: number; isActive: boolean } | null = null;
    if (kind === 'classificationPlan') {
      parent = await this.prisma.classificationPlan.findUnique({ where: { planId: parentId }, select });
    } else if (kind === 'location') {
      parent = await this.prisma.location.findUnique({ where: { locationId: parentId }, select });
    } else {
      parent = await this.prisma.dossier.findUnique({ where: { dossierId: parentId }, select });
    }
    // Un parent DÉSACTIVÉ vaut un parent absent : les listes ne renvoient que les actifs, l'enfant
    // créé sous lui s'afficherait donc comme une racine orpheline, et réapparaîtrait seul alors que
    // sa branche a été supprimée.
    if (!parent || !parent.isActive) throw new BadRequestException('Élément parent introuvable');
    return { parentPath: parent.path, depth: parent.depth + 1 };
  }
}
