import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateUserDto, UpdateUserDto } from './users.dto';

/** Default super-admin account: created by the seed, cannot be disabled, demoted or deleted. */
const PROTECTED_ADMIN = 'admin';

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

  async createUser(input: CreateUserDto) {
    const dup = await this.prisma.appUser.findUnique({ where: { username: input.username } });
    if (dup) throw new ConflictException("Cet identifiant est déjà utilisé");

    const user = await this.prisma.appUser.create({
      data: {
        username: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
        fullName: `${input.firstName} ${input.lastName}`,
        email: input.email ?? null,
        passwordHash: await bcrypt.hash(input.password, 12),
        isAdmin: input.isAdmin ?? false,
        roleId: input.roleId ?? null,
        confidentialiteId: input.confidentialiteId ?? null,
        mustChangePwd: true,
      },
    });
    if (input.groupId != null) {
      await this.prisma.appUserGroup.create({
        data: { userId: user.userId, groupId: input.groupId, isDefault: true },
      });
    }
    return { userId: user.userId, username: user.username };
  }

  async updateUser(userId: number, input: UpdateUserDto) {
    const target = await this.prisma.appUser.findUnique({
      where: { userId },
      select: { username: true, firstName: true, lastName: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable');
    if (target.username === PROTECTED_ADMIN) {
      throw new BadRequestException('Le compte administrateur par défaut ne peut pas être modifié.');
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

    return this.prisma.appUser.update({
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
        ...(input.password ? { passwordHash: await bcrypt.hash(input.password, 12) } : {}),
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
  }

  /**
   * Affecte (ou retire, avec `null`) un niveau de confidentialité à plusieurs utilisateurs d'un
   * coup — écran « Confidentialité des utilisateurs ». Le compte admin protégé est exclu par la
   * requête elle-même, comme `updateUser` le refuse une par une.
   */
  async setConfidentialite(userIds: number[], confidentialiteId: number | null) {
    const { count } = await this.prisma.appUser.updateMany({
      where: { userId: { in: userIds }, username: { not: PROTECTED_ADMIN } },
      data: { confidentialiteId },
    });
    return { updated: count };
  }

  /** Supprime un utilisateur, sauf le compte admin protégé. */
  async deleteUser(userId: number) {
    const target = await this.prisma.appUser.findUnique({
      where: { userId },
      select: { username: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable');
    if (target.username === PROTECTED_ADMIN) {
      throw new BadRequestException('Le compte administrateur par défaut ne peut pas être supprimé.');
    }
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

  async resetPassword(userId: number, newPassword: string) {
    await this.prisma.appUser.update({
      where: { userId },
      data: { passwordHash: await bcrypt.hash(newPassword, 12), mustChangePwd: true },
    });
    return { reset: true };
  }

  async assignGroup(userId: number, groupId: number, isDefault: boolean) {
    await this.prisma.appUserGroup.upsert({
      where: { userId_groupId: { userId, groupId } },
      update: { isDefault },
      create: { userId, groupId, isDefault },
    });
    return { assigned: true };
  }

  listGroups() {
    return this.prisma.appGroup.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  createGroup(name: string) {
    return this.prisma.appGroup.create({ data: { name } });
  }
}
