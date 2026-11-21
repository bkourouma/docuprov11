// Tests purs (node:test) de l'autorisation OAuth du lot 2b. apps/web n'a pas d'infrastructure
// jest/vitest : depuis apps/web, `node --import tsx --test app/connecteurs/_tests/oauth.test.ts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GedSourceConnectorStatus,
  consumeOAuthReturn,
  oauthButtonLabel,
  oauthScopesHelp,
  oauthStatus,
  type GedConnectorView,
} from '../../lib/connecteurs';

const NOW = new Date('2026-11-20T12:00:00Z');
const oauthInfo = { oauth: { provider: 'google' as const, scopes: ['drive.readonly'] } };
const day = 24 * 60 * 60 * 1000;
const view = (over: Partial<GedConnectorView> = {}) => ({
  hasCredentials: true,
  status: GedSourceConnectorStatus.Actif,
  credentialsExpiresAt: null as string | null,
  ...over,
});
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

test('oauthStatus : type sans OAuth', () => {
  assert.equal(oauthStatus(view(), {}, NOW), 'not_applicable');
  assert.equal(oauthStatus(view(), undefined, NOW), 'not_applicable');
});
test('oauthStatus : sans identifiants', () => {
  assert.equal(oauthStatus(view({ hasCredentials: false }), oauthInfo, NOW), 'missing');
});
test('oauthStatus : statut autorisation expirée', () => {
  const v = view({ status: GedSourceConnectorStatus.AutorisationExpiree });
  assert.equal(oauthStatus(v, oauthInfo, NOW), 'expired');
});
test('oauthStatus : date dépassée', () => {
  assert.equal(oauthStatus(view({ credentialsExpiresAt: iso(-1000) }), oauthInfo, NOW), 'expired');
});
test('oauthStatus : expire dans moins de 7 jours', () => {
  const v = view({ credentialsExpiresAt: iso(6 * day) });
  assert.equal(oauthStatus(v, oauthInfo, NOW), 'expiring');
});
test('oauthStatus : autorisé (7 jours ou plus, ou sans date)', () => {
  const v = view({ credentialsExpiresAt: iso(7 * day) });
  assert.equal(oauthStatus(v, oauthInfo, NOW), 'authorized');
  assert.equal(oauthStatus(view(), oauthInfo, NOW), 'authorized');
  assert.equal(oauthStatus(view({ credentialsExpiresAt: 'n/a' }), oauthInfo, NOW), 'authorized');
});
test('libellés du bouton et périmètres', () => {
  assert.equal(oauthButtonLabel(oauthInfo.oauth, 'missing'), 'Autoriser avec Google');
  assert.equal(
    oauthButtonLabel({ provider: 'microsoft', scopes: [] }, 'expired'),
    'Autoriser de nouveau avec Microsoft',
  );
  assert.equal(oauthScopesHelp(oauthInfo.oauth), 'Accès en lecture seule : drive.readonly.');
});

test('consumeOAuthReturn : URL effacée avant l’appel, appel unique, succès', async () => {
  const order: string[] = [];
  const out = await consumeOAuthReturn({
    search: '?code=abc&state=xyz',
    clearUrl: () => order.push('clear'),
    callback: async (code, state) => {
      order.push(`call:${code}:${state}`);
      return { connectorId: 7, authorized: true, expiresAt: null };
    },
  });
  assert.deepEqual(order, ['clear', 'call:abc:xyz']);
  assert.deepEqual(out, { kind: 'success', connectorId: 7, expiresAt: null });
});
test('consumeOAuthReturn : refus de l’utilisateur, sans appel réseau', async () => {
  let cleared = 0;
  let called = 0;
  const out = await consumeOAuthReturn({
    search: '?error=access_denied&state=xyz',
    clearUrl: () => cleared++,
    callback: async () => {
      called++;
      throw new Error('ne doit pas être appelé');
    },
  });
  assert.deepEqual(out, { kind: 'invalid', reason: 'denied' });
  assert.equal(cleared, 1);
  assert.equal(called, 0);
});
test('consumeOAuthReturn : code ou state manquant', async () => {
  for (const search of ['', '?code=abc', '?state=xyz']) {
    const out = await consumeOAuthReturn({
      search,
      clearUrl: () => undefined,
      callback: async () => {
        throw new Error('ne doit pas être appelé');
      },
    });
    assert.deepEqual(out, { kind: 'invalid', reason: 'missing' });
  }
});
test('consumeOAuthReturn : échec de l’API', async () => {
  const err = new Error('Le code a expiré.');
  const out = await consumeOAuthReturn({
    search: '?code=abc&state=xyz',
    clearUrl: () => undefined,
    callback: async () => {
      throw err;
    },
  });
  assert.deepEqual(out, { kind: 'failure', error: err });
});
