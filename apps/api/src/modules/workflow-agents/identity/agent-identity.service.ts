import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { PrincipalService } from '../../workflows/principal.service';
import {
  AgentIdentityError,
  type AgentIdentity,
  type WfAgentIdentityPort,
} from '../agent.contracts';

/**
 * Identité d'un agent = celle du LANCEUR (`started_by`), reconstruite EN BASE à chaque exécution :
 *  - jamais depuis un jeton (un jeton encore valide ne prouve ni compte actif ni droit de lancer) ;
 *  - `isAdmin` est relu en base, jamais pris d'un paramètre : aucune élévation de privilège possible ;
 *  - échec fermé : toute anomalie lève `AgentIdentityError`, le runner ne démarre pas.
 * L'agent n'a donc JAMAIS plus de droits que le lanceur.
 */
@Injectable()
export class AgentIdentityService implements WfAgentIdentityPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principals: PrincipalService,
  ) {}

  async resolve(userGroupId: number): Promise<AgentIdentity> {
    if (!Number.isSafeInteger(userGroupId) || userGroupId < 1) {
      throw new AgentIdentityError('invalid', 'Identifiant de lanceur invalide.');
    }

    const row = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId },
      select: {
        userId: true,
        user: { select: { username: true, fullName: true, isAdmin: true, isDisabled: true } },
      },
    });
    if (!row || !row.user) throw new AgentIdentityError('not_found', 'Lanceur introuvable.');
    if (row.user.isDisabled) throw new AgentIdentityError('disabled', 'Compte du lanceur désactivé.');

    // Le droit de lancer est revérifié à chaque exécution : un droit retiré depuis arrête l'agent.
    if (!(await this.principals.canLaunch(userGroupId))) {
      throw new AgentIdentityError('no_launch_right', 'Le lanceur n’a plus le droit de lancer un workflow.');
    }

    const user: AuthUser = {
      userId: row.userId,
      username: row.user.username,
      isAdmin: row.user.isAdmin === true,
      userGroupId,
      fullName: row.user.fullName ?? null,
    };

    let principal;
    try {
      principal = await this.principals.buildPrincipal(user);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw new AgentIdentityError('invalid', 'Identité du lanceur refusée.');
      }
      throw err;
    }
    if (principal.userGroupId !== userGroupId || principal.userId !== row.userId) {
      throw new AgentIdentityError('invalid', 'Identité du lanceur incohérente.');
    }
    return { principal, user };
  }
}
