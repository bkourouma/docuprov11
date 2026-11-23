import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserDto, UpdateUserDto } from './users.dto';

/** Default super-admin account: created by the seed, cannot be disabled, demoted or deleted. */
const PROTECTED_ADMIN = 'admin';

/**
 * Acteur d'une opération de gestion des comptes. Seul `isAdmin` compte : il vient de la base
 * (relu par `JwtStrategy.validate` à chaque requête), jamais du jeton.
 */
type Actor = Pick<AuthUser, 'isAdmin'>;

const ADMIN_ONLY_TARGET =
  'Seul un administrateur peut modifier, réinitialiser ou supprimer un compte administrateur.';
const ADMIN_ONLY_FLAG = 'Seul un administrateur peut accorder ou retirer le statut administrateur.';
const ADMIN_ONLY_SYSTEM_ROLE = 'Seul un administrateur peut attribuer le rôle système.';

function prismaCode(e: unknown): string | undefined {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Traduit les violations de contrainte d'une écriture de compte en 4xx lisibles (elles sortaient
 * en 500) : P2002 = identifiant pris entre la vérification et l'écriture ; P2003 = rôle,
 * habilitation ou profil inexistant.
 */
function rethrowWriteError(e: unknown): never {
  const code = prismaCode(e);
  if (code === 'P2002') throw new ConflictException('Cet identifiant est déjà utilisé');
  if (code === 'P2003') {
    throw new BadRequestException('Rôle, habilitation ou profil inexistant.');
  }
  throw e;
}

/**
 * Gestion des comptes.
 *
 * Le menu « Utilisateurs » ouvre l'écran et ses écritures, mais ne fait pas d'un utilisateur un
 * administrateur : sans ces règles, un titulaire du menu pouvait se promouvoir lui-même, créer un
 * compte administrateur, ou réinitialiser le mot de passe d'un administrateur puis se connecter à
 * sa place. Réservés donc à un acteur administrateur (403 sinon) :
 *  - poser ou retirer `isAdmin` ;
 *  - agir (modifier, désactiver, réinitialiser, supprimer, affecter un profil) sur un compte
 *    administrateur ;
 *  - attribuer le rôle système (tous les menus), que l'écran n'offre déjà pas.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  listUsers() {
    return this.prisma.appUser.findMany({
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        fullName: true,
        email: true,
        isAdmin: true,
        isDisabled: true,
        mustChangePwd: true,
        createdAt: true,
        roleId: true,
        role: { select: { roleId: true, name: true } },
        confidentialiteId: true,
        confidentialite: { select: { confidentialiteId: true, label: true, rank: true } },
      },
      orderBy: { username: 'asc' },
    });
  }

  async createUser(input: CreateUserDto, actor: Actor) {
    if (input.isAdmin && !actor.isAdmin) throw new ForbiddenException(ADMIN_ONLY_FLAG);
    await this.assertAssignableRole(input.roleId, actor);

    const dup = await this.prisma.appUser.findUnique({ where: { username: input.username } });
    if (dup) throw new ConflictException("Cet identifiant est déjà utilisé");

    const passwordHash = await bcrypt.hash(input.password, 12);
    try {
      // Une transaction : un profil inexistant ne doit pas laisser un compte créé à moitié.
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.appUser.create({
          data: {
            username: input.username,
            firstName: input.firstName,
            lastName: input.lastName,
            fullName: `${input.firstName} ${input.lastName}`,
            email: input.email ?? null,
            passwordHash,
            isAdmin: input.isAdmin ?? false,
            roleId: input.roleId ?? null,
            confidentialiteId: input.confidentialiteId ?? null,
            mustChangePwd: true,
          },
        });
        if (input.groupId != null) {
          await tx.appUserGroup.create({
            data: { userId: created.userId, groupId: input.groupId, isDefault: true },
          });
        }
        return created;
      });
      return { userId: user.userId, username: user.username };
    } catch (e) {
      rethrowWriteError(e);
    }
  }

  async updateUser(userId: number, input: UpdateUserDto, actor: Actor) {
    const target = await this.prisma.appUser.findUnique({
      where: { userId },
      select: { username: true, firstName: true, lastName: true, isAdmin: true, roleId: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable');
    if (target.username === PROTECTED_ADMIN) {
      throw new BadRequestException('Le compte administrateur par défaut ne peut pas être modifié.');
    }
    this.assertCanManage(target, actor);
    // Cible non administratrice ici (sinon refus ci-dessus) : `isAdmin: false` est sans effet,
    // seul `true` serait une promotion.
    if (input.isAdmin && !actor.isAdmin) throw new ForbiddenException(ADMIN_ONLY_FLAG);
    // Seul un CHANGEMENT de rôle est vérifié : l'écran renvoie le rôle courant à chaque
    // enregistrement, y compris pour un compte qui porte déjà le rôle système.
    if (input.roleId !== undefined && input.roleId !== target.roleId) {
      await this.assertAssignableRole(input.roleId, actor);
    }

    // Changement d'identifiant : vérifier l'unicité.
    if (input.username && input.username !== target.username) {
      const dup = await this.prisma.appUser.findUnique({ where: { username: input.username } });
      if (dup) throw new ConflictException("Cet identifiant est déjà utilisé");
    }

    // full_name est recomposé dès que le prénom ou le nom change.
    const fullName =
      input.firstName !== undefined || input.lastName !== undefined
        ? `${input.firstName ?? target.firstName} ${input.lastName ?? target.lastName}`
        : undefined;

    const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : undefined;
    try {
      return await this.prisma.appUser.update({
        where: { userId },
        data: {
          username: input.username,
          firstName: input.firstName,
          lastName: input.lastName,
          fullName,
          email: input.email,
          isDisabled: input.isDisabled,
          isAdmin: input.isAdmin,
          roleId: input.roleId,
          confidentialiteId: input.confidentialiteId,
          // Mot de passe fixé par un gestionnaire : provisoire, comme `resetPassword` (seul chemin
          // de réinitialisation offert par l'écran). Le titulaire devra le changer à la connexion.
          ...(passwordHash ? { passwordHash, mustChangePwd: true } : {}),
        },
        select: {
          userId: true,
          username: true,
          isDisabled: true,
          isAdmin: true,
          roleId: true,
          confidentialiteId: true,
        },
      });
    } catch (e) {
      rethrowWriteError(e);
    }
  }

  /**
   * Affecte (ou retire, avec `null`) un niveau de confidentialité à plusieurs utilisateurs d'un
   * coup — écran « Confidentialité des utilisateurs ». Le compte admin protégé est exclu par la
   * requête elle-même, comme `updateUser` le refuse une par une.
   */
  async setConfidentialite(userIds: number[], confidentialiteId: number | null) {
    // Niveau inexistant : 400 lisible plutôt qu'un 500 (P2003). Niveau désactivé : refusé aussi,
    // l'écran ne le propose plus et l'affecter créerait une habilitation invisible.
    if (confidentialiteId != null) {
      const level = await this.prisma.confidentialite.findFirst({
        where: { confidentialiteId, isActive: true },
        select: { confidentialiteId: true },
      });
      if (!level) throw new BadRequestException('Niveau de confidentialité introuvable');
    }
    const { count } = await this.prisma.appUser.updateMany({
      where: { userId: { in: userIds }, username: { not: PROTECTED_ADMIN } },
      data: { confidentialiteId },
    });
    return { updated: count };
  }

  /** Supprime un utilisateur, sauf le compte admin protégé. */
  async deleteUser(userId: number, actor: Actor) {
    const target = await this.prisma.appUser.findUnique({
      where: { userId },
      select: { username: true, isAdmin: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable');
    if (target.username === PROTECTED_ADMIN) {
      throw new BadRequestException('Le compte administrateur par défaut ne peut pas être supprimé.');
    }
    this.assertCanManage(target, actor);
    try {
      await this.prisma.appUser.delete({ where: { userId } });
    } catch {
      // Contrainte FK : l'utilisateur a des données liées (documents, lots, audits…).
      throw new BadRequestException(
        'Suppression impossible : des données (documents, lots…) sont liées à cet utilisateur.',
      );
    }
    return { deleted: true };
  }

  async resetPassword(userId: number, newPassword: string, actor: Actor) {
    // Lecture préalable : `update` sur un identifiant inconnu levait P2025, rendu en 500.
    const target = await this.prisma.appUser.findUnique({
      where: { userId },
      select: { username: true, isAdmin: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable');
    this.assertCanManage(target, actor);
    await this.prisma.appUser.update({
      where: { userId },
      data: { passwordHash: await bcrypt.hash(newPassword, 12), mustChangePwd: true },
    });
    return { reset: true };
  }

  async assignGroup(userId: number, groupId: number, isDefault: boolean, actor: Actor) {
    const target = await this.prisma.appUser.findUnique({
      where: { userId },
      select: { username: true, isAdmin: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable');
    this.assertCanManage(target, actor);
    try {
      await this.prisma.appUserGroup.upsert({
        where: { userId_groupId: { userId, groupId } },
        update: { isDefault },
        create: { userId, groupId, isDefault },
      });
    } catch (e) {
      if (prismaCode(e) === 'P2003') throw new BadRequestException('Profil inexistant.');
      throw e;
    }
    return { assigned: true };
  }

  listGroups() {
    return this.prisma.appGroup.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  createGroup(name: string) {
    return this.prisma.appGroup.create({ data: { name } });
  }

  /** Un compte administrateur (ou le compte `admin` protégé) ne se gère que par un administrateur. */
  private assertCanManage(target: { username: string; isAdmin: boolean }, actor: Actor): void {
    if (actor.isAdmin) return;
    if (target.isAdmin || target.username === PROTECTED_ADMIN) {
      throw new ForbiddenException(ADMIN_ONLY_TARGET);
    }
  }

  /**
   * Vérifie le rôle à attribuer : il doit exister (400, au lieu d'un 500 sur la clé étrangère), et
   * le rôle système — tous les menus, y compris « Utilisateurs » et « Rôles » — reste réservé à un
   * acteur administrateur.
   */
  private async assertAssignableRole(roleId: number | null | undefined, actor: Actor) {
    if (roleId == null) return;
    const role = await this.prisma.role.findUnique({
      where: { roleId },
      select: { isSystem: true },
    });
    if (!role) throw new BadRequestException('Rôle introuvable');
    if (role.isSystem && !actor.isAdmin) throw new ForbiddenException(ADMIN_ONLY_SYSTEM_ROLE);
  }
}
