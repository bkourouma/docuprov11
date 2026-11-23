/**
 * GED-50 à GED-57 — Connecteurs de sources (`/connecteurs`, API `/ged/connectors`).
 *
 * Réservé à l'administrateur (`@RequireAdmin`, menu non assignable). Hermétique :
 *  - dossier surveillé (`filesystem`) pointant vers un dossier temporaire créé par le test sous la
 *    racine autorisée (voir `_helpers/connecteurs.ts` : `E2E_CONNECTOR_FS_ROOT` / `os.tmpdir()`,
 *    identique à `GED_CONNECTOR_FS_ROOTS` côté API) ;
 *  - OAuth (Google, Microsoft) SANS identifiants d'application : refus propres, aucun appel externe.
 * Prérequis de pile : `GED_CONNECTOR_KEY` renseignée (clé de test base64 de 32 octets), et AUCUNE
 * des variables `GED_GOOGLE_CLIENT_*`, `GED_MS_CLIENT_*`, `GED_MS_TENANT`.
 */
import * as path from 'node:path';
import { test, expect } from '../../../fixtures';
import { createRestrictedUser } from '../_helpers/users';
import { MISSING_ID, asT4, asT4As, errorText, isApiCall, openPageAs, pickAntOption } from '../_helpers/ia';
import {
  CONNECTOR_VIEW_KEYS,
  DEFAULT_CONNECTOR_TYPES,
  GOOGLE_DRIVE_TYPE,
  ONEDRIVE_TYPE,
  allowedFsBase,
  createFilesystemConnector,
  createOAuthConnector,
  makeWatchedDir,
  oauthRedirectUri,
  outsideAllowedRoot,
  type ConnectorView,
} from '../_helpers/connecteurs';

const ADMIN_ONLY = 'Réservé aux administrateurs';
const CONNECTORS_FORBIDDEN_TEXT =
  'Accès réservé aux administrateurs. Les connecteurs de sources ne sont gérés que par un compte administrateur.';

interface TypeInfo {
  type: string;
  label: string;
  supportedModes: number[];
  configFields: Array<{ name: string; label: string; required: boolean }>;
  credentialFields: Array<{ name: string }>;
  oauth?: { provider: string; scopes: string[] };
}

/** Message d'un toast Ant Design (`message.success/error`). */
function toast(page: import('@playwright/test').Page, text: string | RegExp) {
  // `.first()` : en mode développement (StrictMode), un effet peut afficher deux fois le même toast.
  return page.locator('.ant-message').getByText(text).first();
}

test.describe('Connecteurs — types et création', () => {
  test('GED-50 types de sources : registre complet, OAuth sans saisie d’identifiants', async ({ page, api }) => {
    const types = await asT4(api).get<TypeInfo[]>('/ged/connectors/types');
    expect(types.map((t) => t.type)).toEqual([...DEFAULT_CONNECTOR_TYPES]);
    const fs = types.find((t) => t.type === 'filesystem')!;
    expect(fs.label).toBe('Dossier surveillé');
    expect(fs.supportedModes).toEqual([0, 1, 2]);
    expect(fs.credentialFields).toEqual([]);
    expect(fs.configFields.find((f) => f.name === 'rootPath')).toMatchObject({ label: 'Dossier à surveiller', required: true });
    expect(types.find((t) => t.type === GOOGLE_DRIVE_TYPE)?.oauth?.provider).toBe('google');
    expect(types.find((t) => t.type === ONEDRIVE_TYPE)?.oauth?.provider).toBe('microsoft');
    expect(types.find((t) => t.type === 'whatsapp')?.supportedModes).toEqual([0]);

    await page.goto('/connecteurs');
    await expect(page.getByRole('heading', { name: 'Connecteurs' })).toBeVisible();
    await page.getByRole('button', { name: 'Nouveau connecteur' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Nouveau connecteur' });
    await expect(dialog).toBeVisible();
    // Type proposé par défaut : le premier du registre.
    await expect(dialog.locator('.ant-select-selection-item').first()).toHaveText('Dossier surveillé');
    await expect(dialog.getByLabel('Dossier à surveiller')).toBeVisible();

    // Type OAuth : aucune zone d'identifiants, consigne d'autorisation après enregistrement.
    await pickAntOption(page, dialog.getByLabel('Type de source'), 'Google Drive');
    await expect(
      dialog.getByText('Après l’enregistrement, utilisez le bouton « Autoriser » pour relier le compte.'),
    ).toBeVisible();
    await expect(dialog.getByText('Identifiants', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('Dossier à surveiller')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).toBeHidden();
  });

  test('GED-51 création d’un dossier surveillé par l’écran (dossier temporaire autorisé)', async ({ page, api, uniq }) => {
    const watched = await makeWatchedDir();
    const label = uniq('Dossier surveillé E2E');
    try {
      await page.goto('/connecteurs');
      await page.getByRole('button', { name: 'Nouveau connecteur' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Nouveau connecteur' });
      await dialog.getByLabel('Libellé').fill(label);
      await dialog.getByLabel('Dossier à surveiller').fill(watched.dir);
      await dialog.getByLabel('Délai de stabilité (secondes)').fill('0');

      const createdP = page.waitForResponse(isApiCall('POST', '/ged/connectors'));
      await dialog.getByRole('button', { name: 'Créer le connecteur' }).click();
      const res = await createdP;
      expect(res.status(), await res.text()).toBe(201);
      await expect(toast(page, 'Connecteur créé')).toBeVisible();
      await expect(dialog).toBeHidden();

      const row = page.getByRole('row').filter({ hasText: label });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Dossier surveillé');
      await expect(row).toContainText('Copie');
      await expect(row).toContainText('Actif');
      await expect(row).toContainText('Oui');

      // Enregistrement : chemin, groupe de repli posé d'office, aucun secret dans la vue.
      const list = await asT4(api).get<ConnectorView[]>('/ged/connectors');
      const saved = list.find((c) => c.label === label);
      expect(saved).toBeDefined();
      expect(Object.keys(saved!).sort()).toEqual([...CONNECTOR_VIEW_KEYS].sort());
      expect(saved!.config?.rootPath).toBe(watched.dir);
      expect(saved!.config?.minAgeSeconds).toBe(0);
      expect(saved!.config?.rights?.fallbackUserGroupIds).toHaveLength(1);
      expect(saved!.hasCredentials).toBe(false);
      expect(saved!.syncIntervalMinutes).toBeNull();
    } finally {
      await watched.cleanup();
    }
  });
});

test.describe('Connecteurs — test de connexion', () => {
  test('GED-52 test de connexion : réussite, puis échec explicite quand le dossier disparaît', async ({ page, api, uniq }) => {
    const watched = await makeWatchedDir({ 'note.txt': 'contenu de test' });
    try {
      const c = await createFilesystemConnector(asT4(api), { label: uniq('Test connexion E2E'), rootPath: watched.dir });
      expect(await asT4(api).post(`/ged/connectors/${c.gedSourceConnectorId}/test`, {})).toEqual({
        ok: true,
        message: 'Connexion réussie.',
      });

      await page.goto(`/connecteurs/${c.gedSourceConnectorId}`);
      await expect(page.getByRole('heading', { name: c.label })).toBeVisible();
      await expect(page.getByText(/Aucune synchronisation pour l.instant/)).toBeVisible();

      let testP = page.waitForResponse(isApiCall('POST', `/ged/connectors/${c.gedSourceConnectorId}/test`));
      await page.getByRole('button', { name: 'Tester', exact: true }).click();
      expect((await testP).status()).toBe(200);
      const okAlert = page.getByRole('alert').filter({ hasText: 'Test de connexion réussi' });
      await expect(okAlert).toBeVisible();
      await expect(okAlert).toContainText('Connexion réussie.');

      await watched.cleanup();
      testP = page.waitForResponse(isApiCall('POST', `/ged/connectors/${c.gedSourceConnectorId}/test`));
      await page.getByRole('button', { name: 'Tester', exact: true }).click();
      expect((await testP).status()).toBe(200); // un échec de connexion n'est jamais une erreur HTTP
      const koAlert = page.getByRole('alert').filter({ hasText: 'Test de connexion échoué' });
      await expect(koAlert).toBeVisible();
      await expect(koAlert).toContainText('Dossier surveillé introuvable ou inaccessible');
    } finally {
      await watched.cleanup();
    }
  });

  test('GED-52 test d’un connecteur OAuth non autorisé : échec propre, sans appel externe', async ({ api, uniq }) => {
    const c = await createOAuthConnector(asT4(api), { label: uniq('Drive non autorisé'), connectorType: GOOGLE_DRIVE_TYPE });
    const result = await asT4(api).post<{ ok: boolean; message: string }>(`/ged/connectors/${c.gedSourceConnectorId}/test`, {});
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Identifiants du connecteur « Google Drive » invalides/);
  });
});

test.describe('Connecteurs — erreurs de saisie', () => {
  test('GED-53 formulaire : champs requis, groupes invalides, chemin refusé par l’API', async ({ page, uniq }) => {
    let posts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/ged/connectors')) posts += 1;
    });
    await page.goto('/connecteurs');
    await page.getByRole('button', { name: 'Nouveau connecteur' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Nouveau connecteur' });
    const submit = dialog.getByRole('button', { name: 'Créer le connecteur' });

    await submit.click();
    await expect(dialog.getByText('Saisissez un libellé')).toBeVisible();
    await expect(dialog.getByText('Renseignez « Dossier à surveiller »')).toBeVisible();

    await dialog.getByLabel('Libellé').fill(uniq('Saisie invalide'));
    await dialog.getByLabel('Groupes de repli (identifiants, séparés par des virgules)').fill('3, abc');
    await dialog.getByLabel('Dossier à surveiller').fill('relatif/dossier');
    await submit.click();
    await expect(dialog.getByText('Saisissez uniquement des identifiants numériques positifs')).toBeVisible();
    expect(posts).toBe(0); // la validation locale bloque l'envoi

    // Saisie valide côté écran, refusée par l'API (chemin relatif) : message lisible, modale ouverte.
    await dialog.getByLabel('Groupes de repli (identifiants, séparés par des virgules)').fill('');
    const resP = page.waitForResponse(isApiCall('POST', '/ged/connectors'));
    await submit.click();
    expect((await resP).status()).toBe(400);
    await expect(toast(page, /Le chemin du dossier doit être absolu/)).toBeVisible();
    await expect(dialog).toBeVisible();

    // Dossier absolu mais hors des racines autorisées.
    await dialog.getByLabel('Dossier à surveiller').fill(outsideAllowedRoot());
    const res2P = page.waitForResponse(isApiCall('POST', '/ged/connectors'));
    await submit.click();
    expect((await res2P).status()).toBe(400);
    await expect(toast(page, /n'est pas dans les racines autorisées/)).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('GED-53 API : configurations et identifiants invalides refusés (400), jamais de 500', async ({ api, uniq }) => {
    const raw = asT4(api).raw;
    const watched = await makeWatchedDir();
    const secret = 'MotDePasse-E2E-ne-pas-renvoyer-42';
    const fsBody = (over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({
      label: uniq('Connecteur invalide'),
      connectorType: 'filesystem',
      mode: 0,
      config: { rootPath: watched.dir, ...config },
      ...over,
    });
    try {
      const cases: Array<[string, unknown, RegExp | null]> = [
        ['champ inconnu', fsBody({ intrus: 1 }), null],
        ['libellé vide', fsBody({ label: '   ' }), null],
        ['type mal formé', fsBody({ connectorType: 'Mauvais-Type' }), null],
        ['type inconnu', fsBody({ connectorType: 'inconnu_e2e' }), /Type de connecteur inconnu/],
        ['mode non supporté (whatsapp)', { ...fsBody(), connectorType: 'whatsapp', mode: 1, config: {} }, /mode demandé n'est pas supporté/],
        ['chemin relatif', fsBody({}, { rootPath: 'relatif/dossier' }), /doit être absolu/],
        ['segment « .. »', fsBody({}, { rootPath: `${allowedFsBase()}${path.sep}..${path.sep}x` }), /« \.\. »/],
        ['hors racines autorisées', fsBody({}, { rootPath: outsideAllowedRoot() }), /racines autorisées/],
        ['réglage inconnu', fsBody({}, { profondeur: 3 }), /invalide/],
        ['référence d’identifiants hors liste blanche', fsBody({ credentialsRef: 'JWT_SECRET' }), /Référence refusée/],
        ['repli vide', fsBody({}, { rights: { fallbackUserGroupIds: [] } }), /ne peut pas être vide/],
        ['groupe inexistant', fsBody({}, { rights: { fallbackUserGroupIds: [MISSING_ID] } }), /Groupe\(s\) de droits inexistant\(s\)/],
        // ANO-GED-T4-1 : identifiant hors int4 -> 500 avant correctif (packages/connectors/src/rights-config.ts).
        ['groupe hors int4', fsBody({}, { rights: { fallbackUserGroupIds: [2147483648] } }), /droits/],
        ['intervalle trop court', fsBody({ syncIntervalMinutes: 4 }), null],
        ['intervalle trop long', fsBody({ syncIntervalMinutes: 10081 }), null],
        ['dossier cible inexistant', fsBody({ targetDossierId: MISSING_ID }), /Dossier cible introuvable/],
        ['identifiants inattendus (dossier)', fsBody({ credentials: { password: secret } }), null],
        ['OAuth : jeton saisi à la main', { ...fsBody(), connectorType: GOOGLE_DRIVE_TYPE, config: {}, credentials: { refreshToken: secret } }, /uniquement par le bouton « Autoriser »/],
      ];
      for (const [label, body, pattern] of cases) {
        const res = await raw.post('/ged/connectors', body);
        const text = await errorText(res);
        expect(res.status(), `${label} : ${text}`).toBe(400);
        if (pattern) expect(text, label).toMatch(pattern);
        expect(text, `${label} : aucun secret renvoyé`).not.toContain(secret);
      }

      // Lecture et modification : identifiants de route et corps invalides.
      expect((await raw.get('/ged/connectors/abc')).status()).toBe(400);
      expect((await raw.get('/ged/connectors/0')).status()).toBe(400);
      const missing = await raw.get(`/ged/connectors/${MISSING_ID}`);
      expect(missing.status()).toBe(404);
      expect(await errorText(missing)).toBe('Connecteur introuvable');
      const c = await createFilesystemConnector(asT4(api), { label: uniq('Connecteur à modifier'), rootPath: watched.dir });
      const changeType = await raw.put(`/ged/connectors/${c.gedSourceConnectorId}`, { connectorType: 'imap' });
      expect(changeType.status()).toBe(400);
      const badPath = await raw.put(`/ged/connectors/${c.gedSourceConnectorId}`, { config: { rootPath: 'relatif' } });
      expect(badPath.status()).toBe(400);
      expect(await errorText(badPath)).toMatch(/doit être absolu/);
    } finally {
      await watched.cleanup();
    }
  });
});

test.describe('Connecteurs — activation et synchronisation', () => {
  test('GED-54 désactivation confirmée, synchronisation bloquée, réactivation', async ({ page, api, uniq }) => {
    const watched = await makeWatchedDir();
    try {
      const c = await createFilesystemConnector(asT4(api), { label: uniq('Activation E2E'), rootPath: watched.dir });
      await page.goto('/connecteurs');
      const row = page.getByRole('row').filter({ hasText: c.label });
      await expect(row).toBeVisible();

      await row.getByRole('button', { name: 'Désactiver', exact: true }).click();
      const confirm = page.getByRole('dialog').filter({ hasText: `Désactiver « ${c.label} » ?` });
      await expect(confirm).toBeVisible();
      const offP = page.waitForResponse(isApiCall('POST', `/ged/connectors/${c.gedSourceConnectorId}/deactivate`));
      await confirm.getByRole('button', { name: 'Désactiver', exact: true }).click();
      expect((await offP).status()).toBe(200);
      await expect(toast(page, 'Connecteur désactivé')).toBeVisible();
      await expect(row).toContainText('Inactif');
      await expect(row).toContainText('Non');
      await expect(row.getByRole('button', { name: 'Synchroniser maintenant' })).toBeDisabled();

      const blocked = await asT4(api).raw.post(`/ged/connectors/${c.gedSourceConnectorId}/sync`, {});
      expect(blocked.status()).toBe(409);
      expect(await errorText(blocked)).toMatch(/Connecteur inactif/);

      const onP = page.waitForResponse(isApiCall('POST', `/ged/connectors/${c.gedSourceConnectorId}/activate`));
      await row.getByRole('button', { name: 'Activer', exact: true }).click(); // pas de confirmation pour réactiver
      expect((await onP).status()).toBe(200);
      await expect(toast(page, 'Connecteur activé')).toBeVisible();
      await expect(row).toContainText('Oui');
      await expect(row.getByRole('button', { name: 'Synchroniser maintenant' })).toBeEnabled();
    } finally {
      await watched.cleanup();
    }
  });

  test('GED-54 « Synchroniser maintenant » : demande mise en file', async ({ page, api, uniq }) => {
    const watched = await makeWatchedDir();
    try {
      const c = await createFilesystemConnector(asT4(api), { label: uniq('Synchro E2E'), rootPath: watched.dir });
      await page.goto('/connecteurs');
      const row = page.getByRole('row').filter({ hasText: c.label });
      const syncP = page.waitForResponse(isApiCall('POST', `/ged/connectors/${c.gedSourceConnectorId}/sync`));
      await row.getByRole('button', { name: 'Synchroniser maintenant' }).click();
      const res = await syncP;
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toEqual({ queued: true });
      await expect(toast(page, 'Synchronisation demandée : elle démarre en arrière-plan.')).toBeVisible();
    } finally {
      await watched.cleanup();
    }
  });

  test('GED-54 synchronisation traitée par le worker : passe réussie et élément repris', async ({ api, uniq }) => {
    // Le worker BullMQ (file ged-connector-sync) tourne dans la pile E2E : son absence est un échec.
    expect(process.env.E2E_WORKER, 'le worker BullMQ de la pile doit tourner (E2E_WORKER=1)').toBe('1');
    const watched = await makeWatchedDir({ 'piece-e2e.txt': `Pièce de test ${uniq('fs')}` });
    try {
      const c = await createFilesystemConnector(asT4(api), {
        label: uniq('Synchro worker E2E'),
        rootPath: watched.dir,
        mode: 1, // indexation en place : le fichier reste à la source
      });
      expect(await asT4(api).post(`/ged/connectors/${c.gedSourceConnectorId}/sync`, {})).toEqual({ queued: true });
      await expect
        .poll(
          async () => {
            const runs = await asT4(api).get<Array<{ status: number }>>(`/ged/connectors/${c.gedSourceConnectorId}/runs`);
            return runs[0]?.status ?? -1;
          },
          { timeout: 60_000, message: 'passe de synchronisation terminée et réussie' },
        )
        .toBe(1);
      const items = await asT4(api).get<{ items: Array<{ name: string }>; total: number }>(
        `/ged/connectors/${c.gedSourceConnectorId}/items`,
      );
      expect(items.items.map((i) => i.name)).toContain('piece-e2e.txt');
    } finally {
      await watched.cleanup();
    }
  });
});

test.describe('Connecteurs — OAuth sans fournisseur configuré', () => {
  test('GED-55 autorisation Google/Microsoft sans identifiants d’application : refus propre', async ({ page, api, uniq }, testInfo) => {
    const admin = asT4(api);
    const redirectUri = oauthRedirectUri(testInfo.project.use.baseURL);
    const google = await createOAuthConnector(admin, { label: uniq('Drive E2E'), connectorType: GOOGLE_DRIVE_TYPE });
    const ms = await createOAuthConnector(admin, { label: uniq('OneDrive E2E'), connectorType: ONEDRIVE_TYPE });

    const g = await admin.raw.post(`/ged/connectors/${google.gedSourceConnectorId}/oauth/start`, { redirectUri });
    expect(g.status(), await errorText(g)).toBe(409);
    expect(await errorText(g)).toMatch(/^Fournisseur Google non configuré : variable\(s\) d’environnement manquante\(s\) .*GED_GOOGLE_CLIENT_ID/);
    const m = await admin.raw.post(`/ged/connectors/${ms.gedSourceConnectorId}/oauth/start`, { redirectUri });
    expect(m.status(), await errorText(m)).toBe(409);
    expect(await errorText(m)).toMatch(/^Fournisseur Microsoft non configuré/);

    // Corps et cibles invalides.
    expect((await admin.raw.post(`/ged/connectors/${google.gedSourceConnectorId}/oauth/start`, {})).status()).toBe(400);
    expect(
      (await admin.raw.post(`/ged/connectors/${google.gedSourceConnectorId}/oauth/start`, { redirectUri, scope: 'x' })).status(),
    ).toBe(400);
    const missing = await admin.raw.post(`/ged/connectors/${MISSING_ID}/oauth/start`, { redirectUri });
    expect(missing.status()).toBe(404);
    const watched = await makeWatchedDir();
    try {
      const fsc = await createFilesystemConnector(admin, { label: uniq('Dossier sans OAuth'), rootPath: watched.dir });
      const notOAuth = await admin.raw.post(`/ged/connectors/${fsc.gedSourceConnectorId}/oauth/start`, { redirectUri });
      expect(notOAuth.status()).toBe(400);
      expect(await errorText(notOAuth)).toBe('Ce type de connecteur ne s’autorise pas par OAuth');
    } finally {
      await watched.cleanup();
    }

    // Écran : état « Non autorisé », bouton « Autoriser avec Google », refus affiché, aucune redirection.
    await page.goto('/connecteurs');
    const row = page.getByRole('row').filter({ hasText: google.label });
    await expect(row).toContainText('Non autorisé');
    const startP = page.waitForResponse(isApiCall('POST', `/ged/connectors/${google.gedSourceConnectorId}/oauth/start`));
    await row.getByRole('button', { name: `Autoriser avec Google — ${google.label}` }).click();
    expect((await startP).status()).toBe(409);
    await expect(toast(page, /Fournisseur Google non configuré/)).toBeVisible();
    await expect(page).toHaveURL(/\/connecteurs$/);
  });
});

test.describe('Connecteurs — retour d’autorisation', () => {
  test('GED-56 page de retour : paramètres absents, refus du fournisseur, état invalide', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('/connecteurs/oauth/callback');
    await expect(page.getByRole('heading', { name: 'Autorisation du compte' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Retour d’autorisation incomplet' })).toBeVisible();

    await page.goto('/connecteurs/oauth/callback?error=access_denied&state=etat-quelconque');
    await expect(page.getByRole('alert').filter({ hasText: 'Autorisation refusée' })).toBeVisible();
    await expect(page).toHaveURL(/\/connecteurs\/oauth\/callback$/); // URL nettoyée

    const cbP = page.waitForResponse(isApiCall('POST', '/ged/connectors/oauth/callback'));
    await page.goto('/connecteurs/oauth/callback?code=code-e2e-factice&state=etat-invalide');
    const cb = await cbP;
    expect(cb.status()).toBe(400);
    const failure = page.getByRole('alert').filter({ hasText: 'Autorisation impossible' });
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('Autorisation invalide ou expirée : recommencez');
    await expect(failure).not.toContainText('code-e2e-factice');
    await expect(page).toHaveURL(/\/connecteurs\/oauth\/callback$/); // le code ne reste pas dans l'URL

    await page.getByRole('button', { name: 'Retour aux connecteurs' }).click();
    await expect(page).toHaveURL(/\/connecteurs$/);
    expect(pageErrors).toEqual([]);
  });

  test('GED-56 API de retour : état forgé ou corps invalide refusés (400)', async ({ api }) => {
    const raw = asT4(api).raw;
    const forged = await raw.post('/ged/connectors/oauth/callback', { code: 'x', state: 'etat-forge' });
    expect(forged.status()).toBe(400);
    expect(await errorText(forged)).toBe('Autorisation invalide ou expirée : recommencez');
    // Forme d'un état signé (charge.signature de 43 caractères) mais signature fausse.
    const fakeSigned = await raw.post('/ged/connectors/oauth/callback', {
      code: 'x',
      state: `eyJuIjoiYWJjIn0.${'A'.repeat(43)}`,
    });
    expect(fakeSigned.status()).toBe(400);
    for (const body of [{ code: 'x' }, { state: 'y' }, { code: '', state: 'y' }, { code: 'x', state: 'y', extra: 1 }]) {
      expect((await raw.post('/ged/connectors/oauth/callback', body)).status(), JSON.stringify(body)).toBe(400);
    }
  });
});

test.describe('Connecteurs — droits', () => {
  test('GED-57 non administrateur : écrans refusés et API 403, même avec un rôle très ouvert', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    // `/connecteurs` n'est pas assignable à un rôle : l'API l'écarte silencieusement.
    const user = await createRestrictedUser(asT4(api), asT4As(apiAs), uniq('conn-non-admin'), [
      '/connecteurs',
      '/gouvernance',
      '/recherche-ia',
    ]);
    const self = await asT4As(apiAs)(user.username, user.password);
    const me = await self.get<{ isAdmin: boolean; menuKeys?: string[] }>('/auth/me');
    expect(me.isAdmin).toBe(false);
    expect(me.menuKeys ?? []).not.toContain('/connecteurs');

    const watched = await makeWatchedDir();
    try {
      const c = await createFilesystemConnector(asT4(api), { label: uniq('Connecteur protégé'), rootPath: watched.dir });
      const id = c.gedSourceConnectorId;
      const calls: Array<['GET' | 'POST' | 'PUT', string, unknown?]> = [
        ['GET', '/ged/connectors'],
        ['GET', '/ged/connectors/types'],
        ['GET', `/ged/connectors/${id}`],
        ['GET', `/ged/connectors/${id}/runs`],
        ['GET', `/ged/connectors/${id}/items`],
        ['POST', '/ged/connectors', { label: 'x', connectorType: 'filesystem', mode: 0, config: { rootPath: watched.dir } }],
        ['PUT', `/ged/connectors/${id}`, { label: 'piraté' }],
        ['POST', `/ged/connectors/${id}/test`, {}],
        ['POST', `/ged/connectors/${id}/sync`, {}],
        ['POST', `/ged/connectors/${id}/deactivate`, {}],
        ['POST', '/ged/connectors/rotate-keys', {}],
        ['POST', `/ged/connectors/${id}/oauth/start`, { redirectUri: 'http://localhost/connecteurs/oauth/callback' }],
        ['POST', '/ged/connectors/oauth/callback', { code: 'x', state: 'y' }],
      ];
      for (const [method, p, body] of calls) {
        const res =
          method === 'GET' ? await self.raw.get(p) : method === 'PUT' ? await self.raw.put(p, body) : await self.raw.post(p, body);
        expect(res.status(), `${method} ${p}`).toBe(403);
        expect(await errorText(res)).toBe(ADMIN_ONLY);
      }
      // Rien n'a bougé.
      const after = await asT4(api).get<ConnectorView>(`/ged/connectors/${id}`);
      expect(after.label).toBe(c.label);
      expect(after.isActive).toBe(true);

      const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
      try {
        const p = session.page;
        await p.goto('/connecteurs');
        await expect(p.getByText(CONNECTORS_FORBIDDEN_TEXT)).toBeVisible();
        await expect(p.getByRole('button', { name: 'Nouveau connecteur' })).toHaveCount(0);
        await expect(p.getByText(c.label)).toHaveCount(0);

        await p.goto(`/connecteurs/${id}`);
        await expect(p.getByText(CONNECTORS_FORBIDDEN_TEXT)).toBeVisible();
        await expect(p.getByRole('button', { name: 'Tester', exact: true })).toHaveCount(0);

        await p.goto('/connecteurs/oauth/callback?code=x&state=y');
        await expect(p.getByText(CONNECTORS_FORBIDDEN_TEXT)).toBeVisible();
      } finally {
        await session.close();
      }
    } finally {
      await watched.cleanup();
    }
  });

  test('GED-57 fiche d’un connecteur inexistant ou d’un identifiant invalide', async ({ page }) => {
    await page.goto('/connecteurs/abc');
    await expect(page.getByText('Ce connecteur est introuvable.')).toBeVisible();
    await page.goto(`/connecteurs/${MISSING_ID}`);
    await expect(page.getByText('Ce connecteur est introuvable.')).toBeVisible();
    await expect(toast(page, 'Connecteur introuvable')).toBeVisible();
    await page.getByRole('button', { name: 'Retour aux connecteurs' }).click();
    await expect(page).toHaveURL(/\/connecteurs$/);
  });
});

