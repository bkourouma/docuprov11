/**
 * Écran « Mon profil » (apps/web/app/profil/page.tsx, GET /auth/profile, POST /auth/change-password).
 *
 * Les comptes testés sont créés par l'API ; leur session est posée directement dans le navigateur
 * (jeton obtenu par POST /auth/login), sans passer par l'écran de connexion.
 */
import { test, expect } from '../../../fixtures';
import type { Page } from '@playwright/test';
import {
  MENU,
  anyConfidentialite,
  createRole,
  createUser,
  loginToken,
  meOf,
  rawLogin,
} from '../_helpers/accounts';
import { ADMIN_USER } from '../_helpers/admin';
import { contextWithToken, storedToken } from '../_helpers/session';

/** Ligne « Libellé : valeur » d'un bloc InfoCard (`InfoRow`). */
// `InfoRow` (components/InfoCard.tsx) : `<div><Text strong>Libellé : </Text><Text>valeur</Text></div>`.
// On vise la ligne entière (le parent du libellé), pas le seul libellé.
const infoRow = (page: Page, label: string) =>
  page.getByText(`${label} :`, { exact: true }).locator('xpath=ancestor::div[1]');

/** Formulaire « Changer mon mot de passe ». */
const passwordForm = (page: Page) => ({
  current: page.getByLabel('Mot de passe actuel', { exact: true }),
  next: page.getByLabel('Nouveau mot de passe', { exact: true }),
  confirm: page.getByLabel('Confirmer le nouveau mot de passe', { exact: true }),
  submit: page.getByRole('button', { name: 'Modifier le mot de passe' }),
});

const isChangePasswordCall = (url: string) => url.endsWith('/api/auth/change-password');

/** Ouvre /profil et attend la fiche. */
async function openProfile(page: Page) {
  const profile = page.waitForResponse((r) => r.url().endsWith('/api/auth/profile'));
  await page.goto('/profil');
  expect((await profile).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Mon profil' })).toBeVisible();
}

test('SOC-14 profil d’un compte restreint : identité, rôle, habilitation, nombre de menus', async ({
  browser,
  baseURL,
  api,
  uniq,
}) => {
  const level = await anyConfidentialite(api, uniq);
  const role = await createRole(api, {
    name: uniq('Rôle profil'),
    description: 'Rôle de test du profil',
    menuKeys: [MENU.search, MENU.documentTypes],
  });
  const user = await createUser(api, {
    username: uniq('soc14'),
    roleId: role.roleId,
    confidentialiteId: level.confidentialiteId,
    firstName: 'Awa',
    lastName: 'Traoré',
  });
  const { accessToken } = await loginToken(user.username, user.password);
  const { context, page } = await contextWithToken(browser, baseURL, accessToken);
  try {
    await openProfile(page);

    await test.step('bandeau d’identité', async () => {
      await expect(page.getByRole('heading', { name: 'Awa Traoré' })).toBeVisible();
      await expect(page.getByText(`Habilitation : ${level.label}`)).toBeVisible();
      await expect(page.getByText('Administrateur', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Compte désactivé', { exact: true })).toHaveCount(0);
    });

    await test.step('blocs Identité, Compte, Droits, Habilitation', async () => {
      await expect(infoRow(page, 'Nom')).toHaveText('Nom : Traoré');
      await expect(infoRow(page, 'Prénom')).toHaveText('Prénom : Awa');
      await expect(infoRow(page, 'Identifiant de connexion')).toHaveText(
        `Identifiant de connexion : ${user.username}`,
      );
      await expect(infoRow(page, 'Adresse e-mail')).toContainText('@e2e.test');
      await expect(infoRow(page, 'Statut')).toHaveText('Statut : Actif');
      await expect(infoRow(page, 'Changement de mot de passe')).toHaveText(
        'Changement de mot de passe : Non requis',
      );
      await expect(infoRow(page, 'Rôle')).toHaveText(`Rôle : ${role.name}`);
      await expect(infoRow(page, 'Description du rôle')).toHaveText(
        'Description du rôle : Rôle de test du profil',
      );
      // `menuCount` = menus EFFECTIFS (effectiveMenuKeys) : l'accueil « / » est toujours accordé,
      // d'où 2 menus de rôle + 1.
      await expect(infoRow(page, 'Menus accessibles')).toHaveText('Menus accessibles : 3 menu(s)');
      await expect(infoRow(page, 'Niveau')).toHaveText(`Niveau : ${level.label}`);
      await expect(
        page.getByText(
          `Vous accédez aux documents dont le niveau est inférieur ou égal à « ${level.label} ».`,
        ),
      ).toBeVisible();
    });
  } finally {
    await context.close();
  }
});

test('SOC-15 profil administrateur : marqueur et accès à tous les menus', async ({ page }) => {
  await openProfile(page);
  await expect(page.getByText('Administrateur', { exact: true })).toBeVisible();
  await expect(infoRow(page, 'Identifiant de connexion')).toHaveText(
    `Identifiant de connexion : ${ADMIN_USER}`,
  );
  await expect(infoRow(page, 'Menus accessibles')).toHaveText(
    'Menus accessibles : Tous (administrateur)',
  );
  await expect(
    page.getByText(
      'Administrateur : tous les documents restent accessibles, quel que soit leur niveau.',
    ),
  ).toBeVisible();
});

test('SOC-16 changement de mot de passe depuis le profil : effectif, ancien refusé', async ({
  browser,
  baseURL,
  api,
  uniq,
}) => {
  const user = await createUser(api, { username: uniq('soc16') });
  const { accessToken } = await loginToken(user.username, user.password);
  const { context, page } = await contextWithToken(browser, baseURL, accessToken);
  const next = 'Profil-2468!';
  try {
    await openProfile(page);
    const f = passwordForm(page);
    await f.current.fill(user.password);
    await f.next.fill(next);
    await f.confirm.fill(next);
    const changed = page.waitForResponse((r) => isChangePasswordCall(r.url()));
    await f.submit.click();
    expect((await changed).status()).toBe(200);
    await expect(page.getByText('Mot de passe modifié.')).toBeVisible();
    await expect(f.current).toHaveValue('');
    await expect(page).toHaveURL(/\/profil$/);
    expect(await storedToken(page)).toBe(accessToken);

    expect((await rawLogin(user.username, user.password)).status).toBe(401);
    expect((await rawLogin(user.username, next)).status).toBe(201);
  } finally {
    await context.close();
  }
});

test('SOC-17 changement de mot de passe depuis le profil : saisies et mot de passe actuel refusés', async ({
  browser,
  baseURL,
  api,
  uniq,
}) => {
  const user = await createUser(api, { username: uniq('soc17') });
  const { accessToken } = await loginToken(user.username, user.password);
  const { context, page } = await contextWithToken(browser, baseURL, accessToken);
  let changeCalls = 0;
  page.on('request', (r) => {
    if (isChangePasswordCall(r.url())) changeCalls += 1;
  });
  try {
    await openProfile(page);
    const f = passwordForm(page);

    await test.step('champs vides', async () => {
      await f.submit.click();
      await expect(page.getByText('Le mot de passe actuel est obligatoire')).toBeVisible();
      await expect(page.getByText('Le nouveau mot de passe est obligatoire')).toBeVisible();
      await expect(page.getByText('La confirmation est obligatoire')).toBeVisible();
    });

    const refuse = (label: string, next: string, confirm: string, message: string) =>
      test.step(label, async () => {
        await f.current.fill(user.password);
        await f.next.fill(next);
        await f.confirm.fill(confirm);
        await f.submit.click();
        await expect(page.getByText(message)).toBeVisible();
      });
    // Règle du code : 6 caractères minimum (docs/operations.md dit ≥ 8 : question ouverte).
    await refuse(
      '5 caractères',
      'abcde',
      'abcde',
      'Le mot de passe doit faire au moins 6 caractères',
    );
    await refuse(
      'espace final',
      'Profil-2468! ',
      'Profil-2468! ',
      'Le mot de passe ne doit ni commencer ni finir par une espace',
    );
    await refuse(
      'confirmation différente',
      'Profil-2468!',
      'Profil-1357!',
      'Les deux saisies diffèrent',
    );
    expect(changeCalls).toBe(0);

    await test.step('mot de passe actuel faux : refus serveur, session conservée', async () => {
      await f.current.fill('pas-le-bon');
      await f.next.fill('Profil-2468!');
      await f.confirm.fill('Profil-2468!');
      const changed = page.waitForResponse((r) => isChangePasswordCall(r.url()));
      await f.submit.click();
      expect((await changed).status()).toBe(400);
      await expect(page.getByText('Mot de passe actuel incorrect')).toBeVisible();
      await expect(page).toHaveURL(/\/profil$/);
      expect(await storedToken(page)).toBe(accessToken);
      expect((await rawLogin(user.username, user.password)).status).toBe(201);
    });
  } finally {
    await context.close();
  }
});

test('SOC-18 session ouverte avec obligation en cours : alerte du profil, levée après changement', async ({
  browser,
  baseURL,
  api,
  uniq,
}) => {
  // Jeton obtenu par l'API : l'API, elle, n'impose rien (voir rapport) — seul l'écran de connexion
  // impose l'étape. Une session ouverte AVANT une réinitialisation se retrouve dans ce cas.
  const user = await createUser(api, { username: uniq('soc18'), mustChangePwd: 'keep' });
  const { accessToken, mustChangePwd } = await loginToken(user.username, user.password);
  expect(mustChangePwd).toBe(true);
  const { context, page } = await contextWithToken(browser, baseURL, accessToken);
  try {
    await openProfile(page);
    await expect(page.getByText('Vous devez changer votre mot de passe')).toBeVisible();
    await expect(infoRow(page, 'Changement de mot de passe')).toHaveText(
      'Changement de mot de passe : Exigé à la prochaine connexion',
    );

    const f = passwordForm(page);
    await f.current.fill(user.password);
    await f.next.fill('Profil-8642!');
    await f.confirm.fill('Profil-8642!');
    const changed = page.waitForResponse((r) => isChangePasswordCall(r.url()));
    await f.submit.click();
    expect((await changed).status()).toBe(200);

    await expect(page.getByText('Vous devez changer votre mot de passe')).toBeHidden();
    await expect(infoRow(page, 'Changement de mot de passe')).toHaveText(
      'Changement de mot de passe : Non requis',
    );
    expect((await meOf(accessToken)).mustChangePwd).toBe(false);
  } finally {
    await context.close();
  }
});
