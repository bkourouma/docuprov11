import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser, JwtPayload } from './auth.types';

/**
 * Stratégie JWT des routes HTTP.
 *
 * La signature et l'expiration ne suffisent pas : un jeton vit `JWT_EXPIRES_IN` (1 j par défaut)
 * et fige l'état du compte au moment de la connexion. `validate` relit donc le compte à CHAQUE
 * requête (une `findUnique` sur la clé primaire, deux colonnes) :
 *  - compte supprimé ou désactivé ⟹ 401, même avec un jeton encore valide ;
 *  - `isAdmin` vient de la base, jamais du jeton : un administrateur rétrogradé perd aussitôt le
 *    contournement du `MenuPermissionGuard`, de l'`AdminGuard` et des ACL documentaires.
 * Le reste de l'identité (identifiant, nom affichable, acteur effectif) reste celui du jeton : il
 * ne confère aucun droit par lui-même et les écritures d'audit le figent tel quel.
 *
 * L'éditeur collaboratif (`collab-access.service.ts`) vérifie ses jetons lui-même, hors de cette
 * stratégie : il ne bénéficie pas de cette relecture.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const userId = payload?.sub;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
      throw new UnauthorizedException('Jeton invalide');
    }

    const account = await this.prisma.appUser.findUnique({
      where: { userId },
      select: { isAdmin: true, isDisabled: true },
    });
    // Message unique : ne pas dire si le compte a été supprimé ou seulement désactivé.
    if (!account || account.isDisabled) {
      throw new UnauthorizedException('Session expirée ou compte inactif');
    }

    return {
      userId,
      username: payload.username,
      isAdmin: account.isAdmin,
      userGroupId: payload.userGroupId ?? null,
      fullName: payload.fullName ?? null,
    };
  }
}
