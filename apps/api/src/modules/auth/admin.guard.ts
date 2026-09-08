import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthUser } from './auth.types';

/** Allows only administrators (D-17 ACL bypass). */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user?.isAdmin) {
      throw new ForbiddenException('Réservé aux administrateurs');
    }
    return true;
  }
}
