import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, type LoginResult } from './auth.service';
import type { AuthUser } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import {
  changePasswordSchema,
  loginSchema,
  type ChangePasswordDto,
  type LoginDto,
} from './login.dto';
import { Public } from './public.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { effectiveMenuKeys } from './menu-access';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('login')
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginDto): Promise<LoginResult> {
    return this.auth.login(body.username, body.password);
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.auth.changePassword(user.userId, body.currentPassword, body.newPassword);
    return { changed: true };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const row = await this.prisma.appUser.findUnique({
      where: { userId: user.userId },
      select: {
        userId: true,
        username: true,
        firstName: true,
        lastName: true,
        fullName: true,
        isAdmin: true,
        mustChangePwd: true,
        role: {
          select: {
            roleId: true,
            name: true,
            isActive: true,
            isSystem: true,
            menus: { select: { menuKey: true } },
          },
        },
      },
    });
    if (!row) return row;

    // Menus effectifs : même règle que le MenuPermissionGuard (accès au menu ⟹ accès aux données).
    const { role, ...rest } = row;
    return {
      ...rest,
      // Identité effective (§08 acteur) : le front en a besoin pour savoir « est-ce mon
      // imputation ? » (bouton Supprimer) sans dupliquer cette logique côté serveur.
      userGroupId: user.userGroupId,
      role: role ? { roleId: role.roleId, name: role.name } : null,
      menuKeys: effectiveMenuKeys(row.isAdmin, role),
    };
  }
}
