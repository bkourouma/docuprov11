import type { AuthUser } from '../../auth/auth.types';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SubjectActor } from '../../workflows/extension/subject-access';

/** Acteur reconstruit depuis la base (jamais depuis l'appelant). */
export interface LoadedActor {
  authUser: AuthUser;
  /** Rôle de l'utilisateur, null s'il n'en a pas ou si le rôle est INACTIF. */
  activeRoleId: number | null;
}

/** Identifiant d'objet : entier décimal strictement positif de 1 à 9 chiffres (sinon null). */
export function parseSubjectId(subjectId: string): number | null {
  if (typeof subjectId !== 'string' || !/^\d{1,9}$/.test(subjectId)) return null;
  const n = Number(subjectId);
  return n > 0 ? n : null;
}

/**
 * Charge l'acteur depuis la base. Renvoie null (refus) si le compte-groupe n'existe pas, si le compte est
 * désactivé, ou si un `userId` fourni diffère de celui de la base.
 */
export async function loadActor(prisma: PrismaService, actor: SubjectActor): Promise<LoadedActor | null> {
  if (!Number.isInteger(actor?.userGroupId) || actor.userGroupId <= 0) return null;
  const row = await prisma.appUserGroup.findUnique({
    where: { userGroupId: actor.userGroupId },
    select: {
      userId: true,
      user: {
        select: {
          userId: true,
          username: true,
          isAdmin: true,
          isDisabled: true,
          roleId: true,
          role: { select: { isActive: true } },
        },
      },
    },
  });
  if (!row || !row.user || row.user.isDisabled) return null;
  if (actor.userId !== undefined && actor.userId !== row.user.userId) return null;
  return {
    authUser: {
      userId: row.user.userId,
      username: row.user.username,
      isAdmin: row.user.isAdmin,
      userGroupId: actor.userGroupId,
    },
    activeRoleId: row.user.roleId != null && row.user.role?.isActive ? row.user.roleId : null,
  };
}

/** Le compte-groupe existe et son compte n'est pas désactivé. */
export async function isUserGroupActive(prisma: PrismaService, userGroupId: number | null): Promise<boolean> {
  if (userGroupId == null) return false;
  const row = await prisma.appUserGroup.findUnique({
    where: { userGroupId },
    select: { user: { select: { isDisabled: true } } },
  });
  return !!row && !!row.user && !row.user.isDisabled;
}
