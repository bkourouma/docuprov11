import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ASSIGNABLE_MENU_CATALOG, ASSIGNABLE_MENU_KEYS, sanitizeMenuKeys } from './menu-catalog';
import type { CreateRoleDto, UpdateRoleDto } from './roles.dto';

interface RoleRow {
  roleId: number;
  name: string;
  description: string | null;
  isActive: boolean;
  isSystem: boolean;
  menus: { menuKey: string }[];
  _count: { users: number };
}

/** Forme renvoyée au frontend : le rôle + la liste plate de ses clés de menu. */
function toRoleDto(r: RoleRow) {
  return {
    roleId: r.roleId,
    name: r.name,
    description: r.description,
    isActive: r.isActive,
    isSystem: r.isSystem,
    // Le rôle système accorde TOUJOURS tous les menus (robuste si le catalogue évolue).
    menuKeys: r.isSystem ? [...ASSIGNABLE_MENU_KEYS] : r.menus.map((m) => m.menuKey),
    userCount: r._count.users,
  };
}

const ROLE_INCLUDE = {
  menus: { select: { menuKey: true } },
  _count: { select: { users: true } },
} as const;

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Catalogue des menus assignables (l'accueil reste toujours visible). */
  listMenus() {
    return ASSIGNABLE_MENU_CATALOG;
  }

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      orderBy: { name: 'asc' },
      include: ROLE_INCLUDE,
    });
    return roles.map(toRoleDto);
  }

  async getRole(roleId: number) {
    const role = await this.prisma.role.findUnique({ where: { roleId }, include: ROLE_INCLUDE });
    if (!role) throw new NotFoundException('Rôle introuvable');
    return toRoleDto(role);
  }

  async createRole(input: CreateRoleDto) {
    const keys = sanitizeMenuKeys(input.menuKeys);
    const role = await this.prisma.role.create({
      data: {
        name: input.name.trim(),
        description: input.description?.trim() || null,
        menus: { create: keys.map((menuKey) => ({ menuKey })) },
      },
      include: ROLE_INCLUDE,
    });
    return toRoleDto(role);
  }

  async updateRole(roleId: number, input: UpdateRoleDto) {
    const exists = await this.prisma.role.findUnique({
      where: { roleId },
      select: { roleId: true, isSystem: true },
    });
    if (!exists) throw new NotFoundException('Rôle introuvable');
    // Le rôle système par défaut n'est pas modifiable.
    if (exists.isSystem) {
      throw new BadRequestException('Le rôle système par défaut ne peut pas être modifié.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({
        where: { roleId },
        data: {
          name: input.name?.trim(),
          description:
            input.description === undefined ? undefined : input.description?.trim() || null,
          isActive: input.isActive,
        },
      });
      // menuKeys fourni => on remplace l'intégralité des permissions de menu du rôle.
      if (input.menuKeys) {
        const keys = sanitizeMenuKeys(input.menuKeys);
        await tx.roleMenuPermission.deleteMany({ where: { roleId } });
        if (keys.length > 0) {
          await tx.roleMenuPermission.createMany({
            data: keys.map((menuKey) => ({ roleId, menuKey })),
          });
        }
      }
    });
    return this.getRole(roleId);
  }

  /** Supprime un rôle. Les utilisateurs liés voient leur role_id remis à NULL (FK SetNull). */
  async deleteRole(roleId: number) {
    const exists = await this.prisma.role.findUnique({
      where: { roleId },
      select: { roleId: true, isSystem: true },
    });
    if (!exists) throw new NotFoundException('Rôle introuvable');
    if (exists.isSystem) {
      throw new BadRequestException('Le rôle système par défaut ne peut pas être supprimé.');
    }
    await this.prisma.role.delete({ where: { roleId } });
    return { deleted: true };
  }
}
