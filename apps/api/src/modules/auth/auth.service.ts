import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.types';
import { effectiveMenuKeys } from './menu-access';

export interface LoginResult {
  accessToken: string;
  mustChangePwd: boolean;
  isAdmin: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** Validates credentials and returns a signed JWT carrying the effective identity. */
  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.appUser.findUnique({
      where: { username },
      include: { userGroups: true },
    });

    if (!user || user.isDisabled || !user.passwordHash) {
      throw new UnauthorizedException('Identifiants invalides');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Identifiants invalides');
    }

    const defaultUg = user.userGroups.find((ug) => ug.isDefault) ?? user.userGroups[0];
    const payload: JwtPayload = {
      sub: user.userId,
      username: user.username,
      isAdmin: user.isAdmin,
      userGroupId: defaultUg?.userGroupId ?? null,
      fullName: user.fullName,
    };

    return {
      accessToken: await this.jwt.signAsync(payload),
      mustChangePwd: user.mustChangePwd,
      isAdmin: user.isAdmin,
    };
  }

  /**
   * Fiche complete du compte connecte, pour l'ecran « Mon profil ».
   *
   * Distincte de `/auth/me`, appelee a CHAQUE chargement de page par le garde d'authentification :
   * on n'y ajoute pas des jointures (role, organigramme, habilitation, profils) qui ne servent
   * qu'a un seul ecran. Aucune permission de menu requise — un utilisateur consulte toujours
   * son propre compte.
   */
  async getProfile(userId: number) {
    const row = await this.prisma.appUser.findUnique({
      where: { userId },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        fullName: true,
        email: true,
        phone: true,
        matricule: true,
        isAdmin: true,
        isDisabled: true,
        mustChangePwd: true,
        createdAt: true,
        role: {
          select: {
            roleId: true,
            name: true,
            description: true,
            isActive: true,
            isSystem: true,
            organigramme: { select: { organigrammeId: true, label: true, path: true } },
            menus: { select: { menuKey: true } },
          },
        },
        confidentialite: { select: { confidentialiteId: true, label: true, rank: true } },
        userGroups: {
          select: { userGroupId: true, isDefault: true, group: { select: { groupId: true, name: true } } },
        },
      },
    });
    if (!row) throw new UnauthorizedException('Compte introuvable');

    const { role, userGroups, ...rest } = row;
    return {
      ...rest,
      role: role
        ? {
            roleId: role.roleId,
            name: role.name,
            description: role.description,
            isActive: role.isActive,
            isSystem: role.isSystem,
            organigramme: role.organigramme,
          }
        : null,
      // Nombre de menus REELLEMENT accessibles : un admin les a tous, un role n'a que les siens.
      menuCount: effectiveMenuKeys(row.isAdmin, role).length,
      groups: userGroups.map((ug) => ({
        userGroupId: ug.userGroupId,
        groupId: ug.group.groupId,
        name: ug.group.name,
        isDefault: ug.isDefault,
      })),
    };
  }

  /** Change the current user's password after verifying the current one (clears must_change_pwd). */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.appUser.findUnique({ where: { userId } });
    if (!user?.passwordHash) throw new UnauthorizedException('Identifiants invalides');
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new BadRequestException('Mot de passe actuel incorrect');
    }
    await this.prisma.appUser.update({
      where: { userId },
      data: { passwordHash: await bcrypt.hash(newPassword, 12), mustChangePwd: false },
    });
  }
}
