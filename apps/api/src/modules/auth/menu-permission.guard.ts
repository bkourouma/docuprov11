import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './auth.types';
import { effectiveMenuKeys } from './menu-access';
import { REQUIRE_ADMIN_KEY, REQUIRE_MENU_KEY } from './require-menu.decorator';

/**
 * Autorise l'accès selon le menu requis par le handler — règle « accès au menu ⟹ accès aux
 * données », alignée sur le calcul de `/auth/me` :
 *  - admin ou rôle système actif : tout est autorisé ;
 *  - `@RequireAdmin()` : réservé aux administrateurs ;
 *  - `@RequireMenu(...keys)` : autorisé si l'une des clés figure dans les menus effectifs du rôle ;
 *  - aucun décorateur : autorisé à tout utilisateur authentifié (référentiels en lecture).
 */
@Injectable()
export class MenuPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) throw new ForbiddenException('Non authentifié');
    if (user.isAdmin) return true;
    // Identité machine : elle ne correspond à aucun compte, donc à aucun rôle ni menu. Le
    // `JwtAuthGuard` ne la pose que sur les routes `@AllowScanAgentKey()` — l'autorisation a déjà
    // été décidée là, une recherche de menus ne ferait que la refuser à tort.
    if (user.isScanAgent) return true;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_ADMIN_KEY, targets)) {
      throw new ForbiddenException('Réservé aux administrateurs');
    }

    const requiredMenus = this.reflector.getAllAndOverride<string[]>(REQUIRE_MENU_KEY, targets);
    if (!requiredMenus?.length) return true; // lecture partagée : tout utilisateur authentifié

    const row = await this.prisma.appUser.findUnique({
      where: { userId: user.userId },
      select: {
        isAdmin: true,
        role: {
          select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } },
        },
      },
    });
    const effective = effectiveMenuKeys(row?.isAdmin ?? false, row?.role ?? null);
    if (requiredMenus.some((key) => effective.includes(key))) return true;
    throw new ForbiddenException("Vous n'avez pas accès à cette section.");
  }
}
