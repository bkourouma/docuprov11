import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { AsstError, type AsstIdentity, type AsstIdentityPort } from '../assistant.contracts';

const REFUSED = 'Identité refusée : accès à l’assistant impossible.';

/**
 * Identité d'exécution de l'assistant : l'utilisateur du jeton, RELU EN BASE (compte actif, droit
 * d'administration réel, rôle actif). N'exige aucun menu (le menu `/assistant` est vérifié par le guard)
 * et ne dépend ni du module workflows ni de `PrincipalService`.
 */
@Injectable()
export class AsstIdentityService implements AsstIdentityPort {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(user: AuthUser): Promise<AsstIdentity> {
    if (user.isScanAgent || user.userGroupId == null) {
      throw new AsstError('identity_refused', REFUSED);
    }
    const actor = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId: user.userGroupId },
      select: {
        userId: true,
        user: {
          select: {
            username: true,
            fullName: true,
            isAdmin: true,
            isDisabled: true,
            roleId: true,
            role: { select: { isActive: true } },
          },
        },
      },
    });
    if (!actor || actor.userId !== user.userId || actor.user.isDisabled) {
      throw new AsstError('identity_refused', REFUSED);
    }
    const memberships = await this.prisma.appUserGroup.findMany({
      where: { userId: actor.userId },
      select: { groupId: true },
    });
    return {
      user: {
        userId: actor.userId,
        username: actor.user.username,
        // Relu en base : jamais le `isAdmin` du jeton.
        isAdmin: actor.user.isAdmin === true,
        userGroupId: user.userGroupId,
        fullName: actor.user.fullName ?? null,
      },
      principal: {
        userGroupId: user.userGroupId,
        userId: actor.userId,
        groupIds: [...new Set(memberships.map((m) => m.groupId))],
        roleId: actor.user.roleId != null && actor.user.role?.isActive ? actor.user.roleId : null,
      },
    };
  }
}
