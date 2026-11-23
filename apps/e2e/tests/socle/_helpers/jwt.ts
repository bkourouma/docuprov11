/**
 * Jetons JWT fabriqués pour les tests de session (aucune dépendance : `node:crypto`).
 *
 * - `forgedToken()` : jeton bien FORMÉ mais mal SIGNÉ, se réclamant administrateur. L'API doit le
 *   refuser (401) : c'est aussi la preuve qu'on ne s'élève pas en forgeant la charge utile.
 * - `expiredToken(secret)` : jeton correctement signé mais EXPIRÉ. Exige le secret de la pile de
 *   test : `JWT_SECRET` de `support/env.ts` (valeur de test injectée dans l'API par le lot 0),
 *   surchargeable par `E2E_JWT_SECRET`. Sans secret, le test concerné est marqué `fixme`.
 */
import { createHmac } from 'node:crypto';
import { JWT_SECRET } from './admin';

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

function encode(payload: Record<string, unknown>, sign: (data: string) => string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

const adminPayload = (iat: number, exp: number) => ({
  sub: 1,
  username: 'admin',
  isAdmin: true,
  userGroupId: null,
  fullName: 'Admin Système',
  iat,
  exp,
});

export function forgedToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return encode(adminPayload(now, now + 3600), () => b64url('signature-invalide'));
}

const hs256 = (secret: string) => (data: string) =>
  createHmac('sha256', secret).update(data).digest('base64url');

export function expiredToken(secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  return encode(adminPayload(now - 7200, now - 3600), hs256(secret));
}

/**
 * Témoin de `expiredToken` : même secret, NON expiré, pour un compte EXISTANT et actif (`sub`).
 * S'il est accepté, le secret est le bon et le refus du jeton expiré tient bien à l'expiration.
 * (Un compte inexistant serait refusé quel que soit le secret : la stratégie JWT relit le compte.)
 */
export function freshTokenForControl(secret: string, sub: number, username: string): string {
  const now = Math.floor(Date.now() / 1000);
  return encode(
    { sub, username, isAdmin: false, userGroupId: null, fullName: null, iat: now, exp: now + 600 },
    hs256(secret),
  );
}

/** Secret JWT de la pile de test. */
export const E2E_JWT_SECRET: string | undefined =
  process.env.E2E_JWT_SECRET || JWT_SECRET || undefined;
