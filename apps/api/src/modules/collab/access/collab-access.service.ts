import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentState } from '@archivage/types';
import { verify, type JwtPayload as RawJwtPayload } from 'jsonwebtoken';
import type { AuthUser, JwtPayload } from '../../auth/auth.types';
import { DocumentsService } from '../../documents/documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { CollabAccessPort, CollabMode } from '../collab.contracts';
import { COLLAB_MAX_DOCUMENT_ID } from '../server/collab-protocol';

/** Niveau « Modification » : en dessous, l'éditeur s'ouvre en lecture seule (même seuil que doc-versions). */
export const COLLAB_MIN_WRITE_LEVEL = 3;
/** Au-delà, un « jeton » n'est pas un JWT d'API : refus sans même tenter la vérification. */
const MAX_TOKEN_LENGTH = 8192;

/** Jeton vérifié : l'utilisateur ET l'instant d'expiration (ms UTC), surveillé sur les connexions longues. */
export interface VerifiedCollabToken {
  user: AuthUser;
  expiresAt: number;
}

/** Erreur volontairement muette : aucun détail (signature, expiration…) ne remonte au client. */
export class CollabAuthError extends Error {
  constructor() {
    super('Jeton invalide');
    this.name = 'CollabAuthError';
  }
}

/**
 * Contrôle d'accès de l'éditeur collaboratif (port `CollabAccessPort`).
 *
 * AUTHENTIFICATION — même secret et mêmes règles que `JwtStrategy` (signature HS256, expiration,
 * charge utile `JwtPayload` -> `AuthUser`), mais le jeton arrive par le protocole WebSocket et non
 * par l'en-tête `Authorization` : le garde HTTP global ne s'applique pas ici. Deux durcissements
 * par rapport à la stratégie HTTP : l'algorithme est figé (HS256, celui de `JwtModule`) et un jeton
 * SANS `exp` est refusé (sinon il ne cesserait jamais d'ouvrir des connexions longues). Le compte
 * est ensuite RELU en base (`authenticateToken`, 2026-11-22) : compte supprimé ou désactivé refusé,
 * `isAdmin` pris de la base et non du jeton.
 *
 * AUTORISATION — refus par défaut. `DocumentsService.canAccess` tranche d'abord (droits par
 * document + confidentialité) ; puis le niveau effectif décide écriture (>= 3) ou lecture. Un
 * document gelé ou épuré ne s'ouvre qu'en lecture. Les droits d'ESPACE ne sont jamais consultés :
 * ils ne peuvent pas élargir l'accès à une pièce.
 */
@Injectable()
export class CollabAccessService implements CollabAccessPort {
  private readonly secret: string;

  constructor(
    private readonly documents: DocumentsService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
  }

  async authenticate(token: string): Promise<AuthUser> {
    return (await this.authenticateToken(token)).user;
  }

  /**
   * Authentification COMPLÈTE d'une connexion : jeton vérifié (`verifyToken`) PUIS compte relu en
   * base. Un JWT reste valide jusqu'à son expiration même si le compte a été désactivé ou supprimé
   * entre-temps, ou s'il a perdu ses droits d'administration : faire confiance au seul jeton
   * laissait ouvrir (et garder ouvertes, au renouvellement) des connexions longues à un compte qui
   * ne peut plus se connecter à l'API. D'où :
   *  - compte absent ou désactivé => `CollabAuthError`, le MÊME refus muet qu'un jeton invalide ;
   *  - `isAdmin` vient de la BASE, jamais du jeton (il ouvre `canAccess` à tout le fonds).
   * Une panne de base n'est PAS convertie en `CollabAuthError` : elle remonte telle quelle (le
   * serveur la journalise comme erreur interne, et le client reçoit le même refus uniforme).
   */
  async authenticateToken(token: unknown): Promise<VerifiedCollabToken> {
    const verified = this.verifyToken(token);
    const account = await this.prisma.appUser.findUnique({
      where: { userId: verified.user.userId },
      select: { isAdmin: true, isDisabled: true },
    });
    if (!account || account.isDisabled) throw new CollabAuthError();
    return { ...verified, user: { ...verified.user, isAdmin: account.isAdmin === true } };
  }

  /**
   * Vérifie le JWT ; jette `CollabAuthError` (sans détail) s'il est absent, invalide ou expiré.
   * Contrôle CRYPTOGRAPHIQUE seulement : l'état du compte n'y est pas relu (voir
   * `authenticateToken`, seul point d'entrée à utiliser pour ouvrir ou prolonger une connexion).
   */
  verifyToken(token: unknown): VerifiedCollabToken {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new CollabAuthError();
    }
    let decoded: string | RawJwtPayload;
    try {
      decoded = verify(token, this.secret, { algorithms: ['HS256'] });
    } catch {
      throw new CollabAuthError();
    }
    if (typeof decoded !== 'object' || decoded === null) throw new CollabAuthError();
    const exp = decoded.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) throw new CollabAuthError();
    const expiresAt = exp * 1000;
    if (expiresAt <= Date.now()) throw new CollabAuthError();

    const payload = decoded as Partial<JwtPayload>;
    if (
      typeof payload.sub !== 'number' ||
      !Number.isSafeInteger(payload.sub) ||
      payload.sub <= 0 ||
      typeof payload.username !== 'string' ||
      typeof payload.isAdmin !== 'boolean' ||
      !(payload.userGroupId === null || Number.isSafeInteger(payload.userGroupId))
    ) {
      throw new CollabAuthError();
    }
    // Même projection que `JwtStrategy.validate` ; `isScanAgent` ne vient JAMAIS d'un JWT.
    const user: AuthUser = {
      userId: payload.sub,
      username: payload.username,
      isAdmin: payload.isAdmin,
      userGroupId: payload.userGroupId ?? null,
      fullName: typeof payload.fullName === 'string' ? payload.fullName : null,
    };
    return { user, expiresAt };
  }

  async resolveMode(documentId: number, user: AuthUser): Promise<CollabMode | null> {
    if (!Number.isSafeInteger(documentId) || documentId < 1 || documentId > COLLAB_MAX_DOCUMENT_ID) {
      return null;
    }
    // L'identité machine de l'agent de numérisation n'a rien à faire dans l'éditeur.
    if (user.isScanAgent) return null;

    // Prioritaire : un document refusé est indiscernable d'un document inconnu.
    if (!(await this.documents.canAccess(documentId, user))) return null;
    const level = await this.documents.getEffectivePermissionLevel(documentId, user);
    if (level == null) return null;

    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: { isFrozen: true, documentState: true },
    });
    if (!doc) return null;
    if (doc.isFrozen || doc.documentState === DocumentState.Epure) return 'read';
    return level >= COLLAB_MIN_WRITE_LEVEL ? 'write' : 'read';
  }
}
