import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.types';

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
