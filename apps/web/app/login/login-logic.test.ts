// Tests de l'étape de première connexion et des règles de nouveau mot de passe.
// Lancer : cd apps/web && npx tsx --test app/login/login-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HOME_PATH,
  changeProvisionalPassword,
  errorMessageFrom,
  stepAfterLogin,
} from './first-login';
import { MIN_PASSWORD_LENGTH, PASSWORD_MESSAGES, newPasswordError } from './password-policy';

test('après connexion : changement imposé seulement si mustChangePwd vaut true', () => {
  assert.equal(stepAfterLogin({ mustChangePwd: true }), 'change-password');
  assert.equal(stepAfterLogin({ mustChangePwd: false }), 'home');
  // Serveur antérieur sans le champ : pas de blocage.
  assert.equal(stepAfterLogin({}), 'home');
  assert.equal(HOME_PATH, '/dashboards');
});

test('nouveau mot de passe : longueur minimale alignée sur le serveur (6)', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 6);
  assert.equal(newPasswordError('abcde'), PASSWORD_MESSAGES.tooShort);
  assert.equal(newPasswordError('abcdef'), null);
  // Vide : laissé à la règle `required` du formulaire.
  assert.equal(newPasswordError(''), null);
  assert.equal(newPasswordError(undefined), null);
});

test('nouveau mot de passe : espaces de début ou de fin refusés (la connexion les retire)', () => {
  assert.equal(newPasswordError('abcdef '), PASSWORD_MESSAGES.edgeSpaces);
  assert.equal(newPasswordError(' abcdef'), PASSWORD_MESSAGES.edgeSpaces);
  assert.equal(newPasswordError('abc def'), null);
});

test('première connexion : le mot de passe provisoire ne peut pas être reconduit', () => {
  assert.equal(
    newPasswordError('Init-1234!', { provisional: 'Init-1234!' }),
    PASSWORD_MESSAGES.sameAsProvisional,
  );
  assert.equal(newPasswordError('Perso-5678!', { provisional: 'Init-1234!' }), null);
  // Hors première connexion (profil) : pas de comparaison.
  assert.equal(newPasswordError('Init-1234!'), null);
});

test('messages d’erreur serveur : chaîne, tableau Zod, 401, corps vide', () => {
  assert.equal(
    errorMessageFrom(400, { message: 'Mot de passe actuel incorrect' }),
    'Mot de passe actuel incorrect',
  );
  assert.equal(
    errorMessageFrom(400, {
      message: ['newPassword: Le mot de passe doit faire au moins 6 caractères'],
    }),
    'Le mot de passe doit faire au moins 6 caractères',
  );
  assert.equal(
    errorMessageFrom(401, { message: 'Unauthorized' }),
    'Session expirée — reconnectez-vous.',
  );
  assert.equal(errorMessageFrom(500, null), 'Modification impossible (HTTP 500).');
});

/** `fetch` factice : enregistre l'appel et renvoie la réponse fournie. */
function fakeFetch(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { impl, calls };
}

test('changement du mot de passe provisoire : jeton en mémoire, corps attendu', async () => {
  const { impl, calls } = fakeFetch(
    new Response(JSON.stringify({ changed: true }), { status: 200 }),
  );
  const res = await changeProvisionalPassword(impl, '/api', 'tok-123', 'Init-1234!', 'Perso-5678!');
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, '/api/auth/change-password');
  assert.equal(calls[0]!.init?.method, 'POST');
  const headers = calls[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok-123');
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    currentPassword: 'Init-1234!',
    newPassword: 'Perso-5678!',
  });
});

test('changement du mot de passe provisoire : refus serveur et panne réseau', async () => {
  const refused = fakeFetch(
    new Response(JSON.stringify({ message: 'Mot de passe actuel incorrect' }), { status: 400 }),
  );
  assert.deepEqual(await changeProvisionalPassword(refused.impl, '/api', 't', 'a', 'bbbbbb'), {
    ok: false,
    message: 'Mot de passe actuel incorrect',
  });
  const down = fakeFetch(new Error('ECONNREFUSED'));
  const res = await changeProvisionalPassword(down.impl, '/api', 't', 'a', 'bbbbbb');
  assert.equal(res.ok, false);
});
