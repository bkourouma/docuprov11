import type { AuthUser } from '../../auth/auth.types';
import { AsstError, type AsstIdentity, type AsstIdentityPort } from '../assistant.contracts';

/** Identité factice standard pour les tests (utilisateur actif, non administrateur, un groupe). */
export function makeAsstIdentity(
  userId = 1,
  over: { isAdmin?: boolean; userGroupId?: number; groupIds?: number[]; roleId?: number | null; username?: string } = {},
): AsstIdentity {
  const userGroupId = over.userGroupId ?? userId * 10;
  const username = over.username ?? `user${userId}`;
  return {
    user: { userId, username, isAdmin: over.isAdmin ?? false, userGroupId, fullName: null },
    principal: { userGroupId, userId, groupIds: over.groupIds ?? [1], roleId: over.roleId ?? null },
  };
}

/**
 * `AsstIdentityPort` factice : table configurable `{ userId -> AsstIdentity }`. Un utilisateur absent de la table,
 * ou déclaré refusé, lève `identity_refused`.
 */
export class FakeAsstIdentity implements AsstIdentityPort {
  private readonly table = new Map<number, AsstIdentity>();
  private readonly refused = new Set<number>();

  constructor(identities: AsstIdentity[] = []) {
    for (const identity of identities) this.set(identity);
  }

  /** Enregistre (ou remplace) l'identité d'un utilisateur. */
  set(identity: AsstIdentity): this {
    this.table.set(identity.user.userId, identity);
    this.refused.delete(identity.user.userId);
    return this;
  }

  /** Simule le refus d'identité (compte désactivé, etc.) pour cet utilisateur. */
  refuse(userId: number): this {
    this.refused.add(userId);
    return this;
  }

  /** Lève le refus simulé. */
  allow(userId: number): this {
    this.refused.delete(userId);
    return this;
  }

  async resolve(user: AuthUser): Promise<AsstIdentity> {
    const identity = this.table.get(user.userId);
    if (user.isScanAgent || !identity || this.refused.has(user.userId)) {
      throw new AsstError('identity_refused', 'Identité refusée : accès à l’assistant impossible.');
    }
    return identity;
  }
}
