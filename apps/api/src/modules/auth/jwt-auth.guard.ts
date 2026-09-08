import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { timingSafeEqual } from 'node:crypto';
import type { Observable } from 'rxjs';
import type { AuthUser } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ALLOW_SCAN_AGENT_KEY } from './scan-agent-key.decorator';

/** En-tête portant la clé de service (agent de numérisation). */
const API_KEY_HEADER = 'x-api-key';

/** Identité machine attachée à la requête quand la clé de service est reconnue. */
const SCAN_AGENT_USER: AuthUser = {
  userId: -1,
  username: 'scan-agent',
  isAdmin: false,
  userGroupId: null,
  isScanAgent: true,
};

/**
 * Global guard: requires a valid JWT unless the route is marked @Public().
 *
 * Les routes `@AllowScanAgentKey()` acceptent en plus l'en-tête `X-Api-Key` : l'agent de
 * numérisation est un service installé sur un poste, il ne doit pas porter le compte ni le mot de
 * passe d'un utilisateur.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {
    super();
  }

  override canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    if (
      this.reflector.getAllAndOverride<boolean>(ALLOW_SCAN_AGENT_KEY, targets) &&
      this.matchesScanAgentKey(context)
    ) {
      context.switchToHttp().getRequest<{ user?: AuthUser }>().user = { ...SCAN_AGENT_USER };
      return true;
    }

    return super.canActivate(context) as boolean | Promise<boolean> | Observable<boolean>;
  }

  /**
   * Compare la clé présentée à `SCAN_AGENT_API_KEY`. Sans clé configurée, l'authentification par
   * clé n'existe pas : un déploiement qui n'utilise pas l'agent n'ouvre aucune porte de plus.
   */
  private matchesScanAgentKey(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('SCAN_AGENT_API_KEY');
    if (!expected) return false;

    const { headers } = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const raw = headers[API_KEY_HEADER];
    const presented = Array.isArray(raw) ? raw[0] : raw;
    if (typeof presented !== 'string' || presented.length === 0) return false;

    // Comparaison à temps constant : un `===` laisse fuir la clé caractère par caractère à qui
    // sait mesurer le temps de réponse.
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
