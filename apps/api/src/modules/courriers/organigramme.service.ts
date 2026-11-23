import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HierarchyService } from '../../common/hierarchy.service';

/**
 * Un parent désactivé est refusé (création ET déplacement) : la désactivation emporte tout le
 * sous-arbre précisément pour éviter les enfants orphelins ; accepter un enfant ACTIF sous un nœud
 * inactif en recréait un, que l'écran affichait alors comme une fausse racine.
 */
const INACTIVE_PARENT = 'Nœud parent désactivé';

/**
 * Organigramme hiérarchique (§14) — materialized-path, réutilise HierarchyService (comme les
 * arbres plan/localisation/dossier). L'« assignation rôle ↔ organigramme » (§15) écrit
 * `role.organigramme_id` (pas de table dédiée, cf. §02.15).
 */
@Injectable()
export class OrganigrammeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: HierarchyService,
  ) {}

  list() {
    return this.prisma.organigramme.findMany({
      where: { isActive: true },
      orderBy: { path: 'asc' },
    });
  }

  async create(input: { label: string; parentId?: number | null }) {
    const { parentPath } = await this.resolveParent(input.parentId ?? null);
    const depth = parentPath ? this.hierarchy.depthOf(parentPath) + 1 : 0;
    const node = await this.prisma.organigramme.create({
      data: { label: input.label.trim(), parentId: input.parentId ?? null, depth, path: '/' },
    });
    return this.prisma.organigramme.update({
      where: { organigrammeId: node.organigrammeId },
      data: { path: this.hierarchy.childPath(parentPath, node.organigrammeId) },
    });
  }

  async update(organigrammeId: number, input: { label: string }) {
    await this.assertExists(organigrammeId);
    return this.prisma.organigramme.update({
      where: { organigrammeId },
      data: { label: input.label.trim() },
    });
  }

  /** Déplace un nœud et recalcule le chemin/profondeur de tout le sous-arbre déplacé. */
  async reparent(organigrammeId: number, newParentId: number | null) {
    const node = await this.prisma.organigramme.findUnique({ where: { organigrammeId } });
    if (!node) throw new NotFoundException('Nœud introuvable');

    let parentPath: string | null = null;
    if (newParentId != null) {
      if (newParentId === organigrammeId)
        throw new BadRequestException('Un nœud ne peut être son propre parent');
      const parent = await this.prisma.organigramme.findUnique({
        where: { organigrammeId: newParentId },
      });
      if (!parent) throw new BadRequestException('Nœud parent introuvable');
      if (!parent.isActive) throw new BadRequestException(INACTIVE_PARENT);
      if (parent.path.startsWith(node.path))
        throw new BadRequestException('Déplacement cyclique interdit');
      parentPath = parent.path;
    }

    const oldPath = node.path;
    const newPath = this.hierarchy.childPath(parentPath, organigrammeId);
    const subtree = await this.prisma.organigramme.findMany({
      where: { path: { startsWith: oldPath } },
    });
    for (const n of subtree) {
      const path = `${newPath}${n.path.slice(oldPath.length)}`;
      await this.prisma.organigramme.update({
        where: { organigrammeId: n.organigrammeId },
        data: {
          path,
          depth: this.hierarchy.depthOf(path),
          ...(n.organigrammeId === organigrammeId ? { parentId: newParentId } : {}),
        },
      });
    }
    return { moved: true };
  }

  /** Désactive un nœud et tout son sous-arbre (évite les enfants orphelins). */
  async deactivate(organigrammeId: number) {
    const node = await this.prisma.organigramme.findUnique({
      where: { organigrammeId },
      select: { path: true },
    });
    if (!node) throw new NotFoundException('Nœud introuvable');
    await this.prisma.organigramme.updateMany({
      where: { path: { startsWith: node.path } },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  // ---- Assignation rôle ↔ organigramme (§15) -------------------------------
  listRoleAssignments() {
    return this.prisma.role.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        roleId: true,
        name: true,
        organigrammeId: true,
        organigramme: { select: { label: true } },
      },
    });
  }

  async assignRole(roleId: number, organigrammeId: number | null) {
    const role = await this.prisma.role.findUnique({ where: { roleId }, select: { roleId: true } });
    if (!role) throw new NotFoundException('Rôle introuvable');
    if (organigrammeId != null) {
      const node = await this.prisma.organigramme.findUnique({
        where: { organigrammeId },
        select: { organigrammeId: true, isActive: true },
      });
      if (!node) throw new BadRequestException('Nœud d’organigramme introuvable');
      // Un nœud désactivé n'apparaît plus dans l'arbre : y rattacher un rôle produirait des
      // courriers classés sous un service que plus personne ne voit.
      if (!node.isActive) throw new BadRequestException('Nœud d’organigramme désactivé');
    }
    return this.prisma.role.update({ where: { roleId }, data: { organigrammeId } });
  }

  private async resolveParent(parentId: number | null): Promise<{ parentPath: string | null }> {
    if (parentId == null) return { parentPath: null };
    const parent = await this.prisma.organigramme.findUnique({
      where: { organigrammeId: parentId },
      select: { path: true, isActive: true },
    });
    if (!parent) throw new BadRequestException('Nœud parent introuvable');
    if (!parent.isActive) throw new BadRequestException(INACTIVE_PARENT);
    return { parentPath: parent.path };
  }

  private async assertExists(organigrammeId: number): Promise<void> {
    const node = await this.prisma.organigramme.findUnique({
      where: { organigrammeId },
      select: { organigrammeId: true },
    });
    if (!node) throw new NotFoundException('Nœud introuvable');
  }
}
