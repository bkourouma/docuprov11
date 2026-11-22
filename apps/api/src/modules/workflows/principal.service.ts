import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { effectiveMenuKeys } from '../auth/menu-access';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { WfDirectory, WfPrincipal } from './engine/engine.types';
import { SubjectAccessRegistry } from './extension/subject-access';
import { WORKFLOWS_MENUS } from './workflows.menus';

/**
 * Construit l'identité d'exécution du moteur (`WfPrincipal`) à partir du jeton ET de la base : un jeton
 * encore valide ne suffit pas (compte désactivé, rôle retiré ou désactivé depuis). Sert aussi
 * d'annuaire (`WfDirectory`) au moteur.
 */
@Injectable()
export class PrincipalService implements WfDirectory {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly subjects?: SubjectAccessRegistry,
  ) {}

  /**
   * Refuse (403) l'identité machine, tout jeton sans `userGroupId`, un acteur inexistant, ne
   * correspondant pas à l'utilisateur du jeton, ou dont le compte est désactivé.
   */
  async buildPrincipal(user: AuthUser): Promise<WfPrincipal> {
    if (user.isScanAgent || user.userGroupId == null) {
      throw new ForbiddenException('Identité sans acteur : accès refusé au workflow.');
    }
    const actor = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId: user.userGroupId },
      select: {
        userId: true,
        user: { select: { isDisabled: true, roleId: true, role: { select: { isActive: true } } } },
      },
    });
    if (!actor || actor.userId !== user.userId || actor.user.isDisabled) {
      throw new ForbiddenException('Compte inactif ou acteur inconnu.');
    }
    const memberships = await this.prisma.appUserGroup.findMany({
      where: { userId: actor.userId },
      select: { groupId: true },
    });
    return {
      userGroupId: user.userGroupId,
      userId: actor.userId,
      groupIds: [...new Set(memberships.map((m) => m.groupId))],
      roleId: actor.user.roleId != null && actor.user.role?.isActive ? actor.user.roleId : null,
    };
  }

  /** Menus effectifs de l'utilisateur (même règle que `MenuPermissionGuard` / `/auth/me`). */
  async hasMenu(user: AuthUser, menuKey: string): Promise<boolean> {
    if (user.isScanAgent) return false;
    const row = await this.prisma.appUser.findUnique({
      where: { userId: user.userId },
      select: {
        isAdmin: true,
        isDisabled: true,
        role: { select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } } },
      },
    });
    if (!row || row.isDisabled) return false;
    return effectiveMenuKeys(row.isAdmin, row.role).includes(menuKey);
  }

  /** Détenteur du menu d'administration des workflows (ou administrateur) : lecture globale seulement. */
  hasAdminMenu(user: AuthUser): Promise<boolean> {
    return this.hasMenu(user, WORKFLOWS_MENUS.admin);
  }

  /** L'acteur existe et son compte n'est pas désactivé. */
  async isUserGroupActive(userGroupId: number): Promise<boolean> {
    const row = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId },
      select: { user: { select: { isDisabled: true } } },
    });
    return !!row && !row.user.isDisabled;
  }

  /** Propriétaire actif de l'objet lié (via le registre des objets) ; null si inconnu ou compte désactivé. */
  async resolveSubjectOwner(subjectType: string, subjectId: string): Promise<number | null> {
    const owner = (await this.subjects?.resolveOwner(subjectType, subjectId)) ?? null;
    if (owner == null) return null;
    return (await this.isUserGroupActive(owner)) ? owner : null;
  }

  /** Libellé affichable de l'acteur (« lancé par … » dans l'explication de la boîte). */
  async describeUserGroup(userGroupId: number): Promise<string | null> {
    const row = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId },
      select: { user: { select: { fullName: true, username: true } } },
    });
    if (!row) return null;
    return row.user.fullName?.trim() || row.user.username;
  }

  /** Alias lisible de `isUserGroupActive` (annuaire du moteur). */
  isActiveUserGroup(userGroupId: number): Promise<boolean> {
    return this.isUserGroupActive(userGroupId);
  }

  /**
   * Le lanceur existe, n'est pas désactivé et possède le menu LANCER (administrateur compris).
   * Utilisé aussi par les déclencheurs : un déclencheur n'a jamais plus de droits que son `run_as`.
   */
  async canLaunch(userGroupId: number): Promise<boolean> {
    const row = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId },
      select: {
        user: {
          select: {
            isDisabled: true,
            isAdmin: true,
            role: { select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } } },
          },
        },
      },
    });
    if (!row || row.user.isDisabled) return false;
    return effectiveMenuKeys(row.user.isAdmin, row.user.role).includes(WORKFLOWS_MENUS.launch);
  }
}
