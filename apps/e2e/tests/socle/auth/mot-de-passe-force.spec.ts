/**
 * Changement de mot de passe IMPOSÉ à la première connexion (`mustChangePwd`).
 *
 * Écran : apps/web/app/login/page.tsx + login/FirstLoginStep.tsx (étape « Nouveau mot de passe »).
 * Tant que le mot de passe n'est pas changé, aucune session n'est ouverte (jeton gardé en mémoire).
 * API : POST /auth/login renvoie `mustChangePwd` ; POST /auth/change-password l'efface ;
 * POST /users/:id/reset-password le rétablit.
 */
import { test, expect } from '../../../fixtures';
import { createUser, meOf, rawLogin, resetPassword } from '../_helpers/accounts';
import {
  completeFirstLogin,
  firstLoginStep,
  loginForm,
  storedToken,
  submitLogin,
} from '../_helpers/session';

test.use({ storageState: { cookies: [], origins: [] } });

const isChangePasswordCall = (url: string) => url.endsWith('/api/auth/change-password');

test('SOC-10 première connexion : changement imposé, puis accueil et obligation levée', async ({
  page,
  api,
  uniq,
}) => {
  const user = await createUser(api, { username: uniq('soc10'), mustChangePwd: 'keep' });
  const personal = 'Perso-5678!';

  await test.step('l’API signale l’obligation à la connexion', async () => {
    const res = await rawLogin(user.username, user.password);
    expect(res.status).toBe(201);
    expect(res.body.mustChangePwd).toBe(true);
  });

  await test.step('connexion par l’écran : étape imposée, aucune session ouverte', async () => {
    await submitLogin(page, user.username, user.password);
    await expect(firstLoginStep(page).heading).toBeVisible();
    await expect(page.getByText(user.username, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(await storedToken(page)).toBeNull();
  });

  await test.step('nouveau mot de passe → /dashboards', async () => {
    await completeFirstLogin(page, personal);
  });

  await test.step('/auth/me : mustChangePwd vaut false', async () => {
    const token = await storedToken(page);
    expect(token).not.toBeNull();
    expect((await meOf(token!)).mustChangePwd).toBe(false);
  });

  await test.step('ancien mot de passe refusé ; le nouveau ouvre la session sans étape', async () => {
    expect((await rawLogin(user.username, user.password)).status).toBe(401);
    const res = await rawLogin(user.username, personal);
    expect(res.status).toBe(201);
    expect(res.body.mustChangePwd).toBe(false);

    await page.evaluate(() => window.localStorage.removeItem('token'));
    await submitLogin(page, user.username, personal);
    await expect(page).toHaveURL(/\/dashboards$/);
  });
});

test('SOC-11 étape imposée : saisies refusées, abandon sans session', async ({
  page,
  api,
  uniq,
}) => {
  const user = await createUser(api, { username: uniq('soc11'), mustChangePwd: 'keep' });
  let changeCalls = 0;
  page.on('request', (r) => {
    if (isChangePasswordCall(r.url())) changeCalls += 1;
  });

  await submitLogin(page, user.username, user.password);
  const step = firstLoginStep(page);
  await expect(step.heading).toBeVisible();

  const refuse = async (label: string, next: string, confirm: string, message: string) =>
    test.step(label, async () => {
      await step.newPassword.fill(next);
      await step.confirm.fill(confirm);
      await step.submit.click();
      await expect(page.getByText(message)).toBeVisible();
    });

  await test.step('champs vides', async () => {
    await step.submit.click();
    await expect(page.getByText('Saisissez un nouveau mot de passe.')).toBeVisible();
    await expect(page.getByText('Confirmez le nouveau mot de passe.')).toBeVisible();
  });
  await refuse(
    '5 caractères',
    'abcde',
    'abcde',
    'Le mot de passe doit faire au moins 6 caractères',
  );
  await refuse(
    'mot de passe provisoire reconduit',
    user.password,
    user.password,
    'Choisissez un mot de passe différent du mot de passe provisoire',
  );
  await refuse(
    'espace final (la connexion le retirerait : compte verrouillé)',
    'Perso-5678! ',
    'Perso-5678! ',
    'Le mot de passe ne doit ni commencer ni finir par une espace',
  );
  await refuse(
    'confirmation différente',
    'Perso-5678!',
    'Autre-5678!',
    'Les deux saisies diffèrent',
  );
  expect(changeCalls).toBe(0);

  await test.step('« Revenir à la connexion » : formulaire de connexion, aucun jeton', async () => {
    await step.cancel.click();
    await expect(loginForm(page).submit).toBeVisible();
    expect(await storedToken(page)).toBeNull();
  });

  await test.step('quitter l’étape par une adresse directe ne donne pas de session', async () => {
    await submitLogin(page, user.username, user.password);
    await expect(step.heading).toBeVisible();
    await page.goto('/dashboards');
    await expect(page).toHaveURL(/\/login$/);
    expect(await storedToken(page)).toBeNull();
  });

  await test.step('l’obligation subsiste côté serveur', async () => {
    expect((await rawLogin(user.username, user.password)).body.mustChangePwd).toBe(true);
  });
});

test('SOC-12 réinitialisation par l’administrateur : l’obligation est rétablie', async ({
  page,
  api,
  uniq,
}) => {
  // `createUser` lève l'obligation (défaut 'clear') : point de départ « compte en service ».
  const user = await createUser(api, { username: uniq('soc12') });
  const provisional = 'Reset-1234!';

  await test.step('compte en service : pas d’obligation', async () => {
    const res = await rawLogin(user.username, user.password);
    expect(res.body.mustChangePwd).toBe(false);
  });

  await test.step('POST /users/:id/reset-password', async () => {
    await resetPassword(api, user.userId, provisional);
    expect((await rawLogin(user.username, user.password)).status).toBe(401);
    const res = await rawLogin(user.username, provisional);
    expect(res.status).toBe(201);
    expect(res.body.mustChangePwd).toBe(true);
  });

  await test.step('connexion par l’écran : étape imposée, puis accueil', async () => {
    await submitLogin(page, user.username, provisional);
    await completeFirstLogin(page, 'Perso-9012!');
    expect((await meOf((await storedToken(page))!)).mustChangePwd).toBe(false);
  });
});

/**
 * ANOMALIE probable (voir rapport) : la fiche « Modifier » de /admin/users est le SEUL moyen
 * offert par l'interface pour attribuer un nouveau mot de passe (aucun bouton « Réinitialiser »),
 * or `PATCH /users/:id` (apps/api/src/modules/users/users.service.ts, `updateUser`) change le hash
 * sans rétablir `mustChangePwd` — contrairement à `resetPassword` et à docs/operations.md
 * (« must_change_pwd set on seed/reset »).
 */
test('SOC-13 mot de passe attribué par l’administrateur depuis la fiche : obligation rétablie', async ({
  api,
  uniq,
}) => {
  const user = await createUser(api, { username: uniq('soc13') });
  const assigned = 'Fiche-1234!';
  await api.patch(`/users/${user.userId}`, { password: assigned });

  const res = await rawLogin(user.username, assigned);
  expect(res.status).toBe(201);
  expect(res.body.mustChangePwd).toBe(true);
});
