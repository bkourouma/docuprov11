import type { Page, Request, Response } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { createRestrictedUser } from '../_helpers/accounts';
// Client anonyme (sans jeton) : point d'import unique du paquet `support`, tenu par la tâche B.
import { createApiClient } from '../_helpers/admin';
import { PNG_1PX, oversizedPng, svgFile, tinyPng, uploadRaw } from '../_helpers/fichiers';

/**
 * Paramétrage de l'identité des e-mails — écran `/admin/parametres/email`, API
 * `/parametres/email-template` (SOC-70..77).
 *
 * HERMÉTIQUE : aucun e-mail n'est émis, aucun SMTP n'est sollicité. L'écran n'a pas de bouton
 * « envoyer un test » ; l'aperçu est un rendu local du gabarit dans une iframe.
 *
 * Le réglage est une LIGNE UNIQUE (id = 1) partagée par tout le fichier : chaque test pose lui-même
 * l'état dont il a besoin, et les tests du fichier ne tournent pas en parallèle entre eux.
 */
test.describe.configure({ mode: 'default' });

const BASE = '/parametres/email-template';
const LOGO = `${BASE}/logo`;
const MENU_EMAIL = '/admin/parametres/email';
const URL_ECRAN = '/admin/parametres/email';

interface EmailTemplateSetting {
  orgName: string | null;
  logoFileName: string | null;
  logoOriginalName: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
  updatedAt: string | null;
}

const surChemin = (url: string, path: string) => new URL(url).pathname === `/api${path}`;
const reponse = (path: string, method: string) => (r: Response) =>
  surChemin(r.url(), path) && r.request().method() === method;
const requete = (path: string, method: string) => (r: Request) =>
  surChemin(r.url(), path) && r.method() === method;

/** Réglage relu côté serveur (le contrat des fixtures renvoie le JSON non typé). */
const lire = async (client: { get(path: string): Promise<unknown> }) =>
  (await client.get(BASE)) as EmailTemplateSetting;

/** Ouvre l'écran et attend le chargement du réglage (le formulaire est désactivé avant). */
async function ouvrirEcran(page: Page): Promise<Response> {
  const charge = page.waitForResponse(reponse(BASE, 'GET'));
  await page.goto(URL_ECRAN);
  return charge;
}

/** Compte les requêtes émises vers un endpoint, pour prouver qu'une saisie refusée n'est PAS partie. */
function compterRequetes(page: Page, path: string, method: string): () => number {
  let n = 0;
  page.on('request', (r) => {
    if (requete(path, method)(r)) n += 1;
  });
  return () => n;
}

const champOrg = (page: Page) => page.getByLabel(/Nom de l.organisation/);
const champContact = (page: Page) => page.getByLabel('E-mail de contact');
const champSite = (page: Page) => page.getByLabel('Site web');
const apercu = (page: Page) => page.frameLocator('iframe[title^="Aperçu de l"]');

test.describe('Paramétrage e-mail — identité', () => {
  test('SOC-70 enregistre l’identité saisie et la conserve après rechargement', async ({
    page,
    api,
    uniq,
  }) => {
    await api.put(BASE, { orgName: uniq('Avant'), contactEmail: null, websiteUrl: null });
    const org = uniq('Organisation');

    await ouvrirEcran(page);
    await champOrg(page).fill(org);
    await champContact(page).fill('contact@exemple.ci');
    await champSite(page).fill('https://exemple.ci');
    // Le bouton vit dans l'en-tête, loin des champs : le repère de saisie en attente doit s'afficher.
    await expect(page.getByText('Modifications non enregistrées')).toBeVisible();
    // L'aperçu suit la frappe, avant tout enregistrement.
    await expect(apercu(page).getByText(org).first()).toBeVisible();

    const enregistre = page.waitForResponse(reponse(BASE, 'PUT'));
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    const res = await enregistre;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({
      orgName: org,
      contactEmail: 'contact@exemple.ci',
      websiteUrl: 'https://exemple.ci',
    });
    await expect(page.getByText('Paramétrage enregistré')).toBeVisible();
    await expect(page.getByText('Modifications non enregistrées')).toBeHidden();

    // Relu côté serveur…
    const lu = await lire(api);
    expect(lu).toMatchObject({
      orgName: org,
      contactEmail: 'contact@exemple.ci',
      websiteUrl: 'https://exemple.ci',
    });
    expect(lu.updatedAt).not.toBeNull();

    // …et réaffiché après rechargement complet.
    await ouvrirEcran(page);
    await expect(champOrg(page)).toHaveValue(org);
    await expect(champContact(page)).toHaveValue('contact@exemple.ci');
    await expect(champSite(page)).toHaveValue('https://exemple.ci');
  });

  test('SOC-70 vider un champ l’efface (null), sans toucher aux autres', async ({
    page,
    api,
    uniq,
  }) => {
    const org = uniq('Organisation');
    await api.put(BASE, {
      orgName: org,
      contactEmail: 'contact@exemple.ci',
      websiteUrl: 'https://exemple.ci',
    });

    await ouvrirEcran(page);
    await expect(champContact(page)).toHaveValue('contact@exemple.ci');
    await champContact(page).fill('');

    const enregistre = page.waitForResponse(reponse(BASE, 'PUT'));
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    expect((await enregistre).status()).toBe(200);
    await expect(page.getByText('Paramétrage enregistré')).toBeVisible();

    expect(await lire(api)).toMatchObject({
      orgName: org,
      contactEmail: null,
      websiteUrl: 'https://exemple.ci',
    });
  });

  test('SOC-71 une saisie invalide est signalée sous le champ et n’est pas envoyée', async ({
    page,
    api,
    uniq,
  }) => {
    const org = uniq('Organisation');
    await api.put(BASE, { orgName: org, contactEmail: null, websiteUrl: null });
    const puts = compterRequetes(page, BASE, 'PUT');

    await ouvrirEcran(page);
    await champContact(page).fill('pas-un-email');
    // `ftp://` : accepté par la règle `type: 'url'` d'AntD, refusé par l'API — l'écran doit
    // désormais appliquer la même règle que le serveur (http/https absolu).
    await champSite(page).fill('ftp://exemple.ci');
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();

    await expect(page.getByText('Adresse e-mail invalide')).toBeVisible();
    await expect(page.getByText(/URL absolue attendue/)).toBeVisible();
    expect(puts()).toBe(0);

    // Corrigé, l'envoi repart.
    await champContact(page).fill('contact@exemple.ci');
    await champSite(page).fill('www.exemple.ci');
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(page.getByText(/URL absolue attendue/)).toBeVisible();
    expect(puts()).toBe(0);

    expect(await lire(api)).toMatchObject({
      orgName: org,
      contactEmail: null,
      websiteUrl: null,
    });
  });

  test('SOC-72 l’API refuse proprement une saisie invalide et n’écrit que les champs fournis', async ({
    api,
    uniq,
  }) => {
    const org = uniq('Organisation');
    await api.put(BASE, {
      orgName: org,
      contactEmail: 'contact@exemple.ci',
      websiteUrl: 'https://exemple.ci',
    });
    const avant = await lire(api);

    for (const corps of [
      { websiteUrl: 'exemple.ci' },
      { websiteUrl: 'ftp://exemple.ci' },
      { websiteUrl: '//exemple.ci' },
      { contactEmail: 'pas-un-email' },
      { orgName: 'x'.repeat(201) },
      { orgName: 42 },
    ]) {
      const res = await api.raw.put(BASE, corps);
      expect(res.status(), JSON.stringify(corps)).toBe(400);
    }
    expect(await lire(api)).toEqual(avant);

    // Mise à jour PARTIELLE : un champ absent n'est pas effacé.
    const org2 = uniq('Organisation');
    await api.put(BASE, { orgName: org2 });
    expect(await lire(api)).toMatchObject({
      orgName: org2,
      contactEmail: 'contact@exemple.ci',
      websiteUrl: 'https://exemple.ci',
    });

    // Chaîne blanche ⟹ null (« non renseigné »), espaces de bord retirés.
    await api.put(BASE, { orgName: `  ${org2}  `, contactEmail: '   ' });
    expect(await lire(api)).toMatchObject({
      orgName: org2,
      contactEmail: null,
    });

    // Une clé hors contrat n'est pas écrite (le nom du fichier logo n'est pas pilotable ici).
    await api.put(BASE, { orgName: org2, logoFileName: '../../secret.txt' });
    expect((await lire(api)).logoFileName).toBe(avant.logoFileName);
  });
});

test.describe('Paramétrage e-mail — logo', () => {
  test('SOC-73 dépose un logo PNG depuis l’écran, l’affiche en aperçu et le conserve', async ({
    page,
    api,
  }) => {
    await api.del(LOGO);

    await ouvrirEcran(page);
    await expect(page.getByText('Aucun logo déposé')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Déposer un logo' })).toBeVisible();

    const depose = page.waitForResponse(reponse(LOGO, 'POST'));
    // `<Upload>` d'AntD porte un input fichier masqué : on l'alimente directement.
    await page.locator('input[type="file"]').setInputFiles(tinyPng('mon-logo.png'));
    expect((await depose).status()).toBe(201);
    await expect(page.getByText('Logo mis à jour')).toBeVisible();

    const img = page.getByRole('img', { name: 'Logo des e-mails' });
    await expect(img).toBeVisible();
    // L'image est réellement servie par la route publique (1 × 1 px décodé).
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
    await expect(page.getByRole('button', { name: 'Remplacer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retirer' })).toBeVisible();

    const lu = await lire(api);
    // Nom de fichier FIXE côté serveur, nom d'origine conservé pour l'affichage.
    expect(lu.logoFileName).toBe('email-logo.png');
    expect(lu.logoOriginalName).toBe('mon-logo.png');

    await ouvrirEcran(page);
    await expect(page.getByRole('img', { name: 'Logo des e-mails' })).toBeVisible();
  });

  test('SOC-74 l’API refuse un logo de format, de poids ou de contenu invalide', async ({
    api,
  }) => {
    await api.upload(LOGO, { field: 'file', file: tinyPng() });
    const avant = await lire(api);

    const svg = await uploadRaw(api, LOGO, svgFile());
    expect(svg.status()).toBe(400);
    expect((await svg.json()).message).toMatch(/^Format non accepté \(\.svg\)/);

    const lourd = await uploadRaw(api, LOGO, oversizedPng());
    expect(lourd.status()).toBe(400);
    expect((await lourd.json()).message).toBe('Logo trop volumineux (1 Mo maximum)');

    // Requête sans fichier du tout : 400, pas 500.
    const vide = await api.raw.post(LOGO, {});
    expect(vide.status()).toBe(400);
    expect((await vide.json()).message).toBe('Aucun fichier reçu');

    // Aucun refus n'a touché au logo en place.
    expect(await lire(api)).toEqual(avant);
  });

  test('SOC-74 l’écran refuse un logo invalide avec un message lisible, sans l’envoyer', async ({
    page,
    api,
  }) => {
    await api.del(LOGO);
    const posts = compterRequetes(page, LOGO, 'POST');

    await ouvrirEcran(page);
    const input = page.locator('input[type="file"]');

    // `accept` ne filtre que le sélecteur de fichiers : `setInputFiles` le contourne, comme un
    // glisser-déposer. Le contrôle local doit prendre le relais avec le message de l'API.
    await input.setInputFiles(svgFile());
    await expect(page.getByText(/Format non accepté \(\.svg\)/)).toBeVisible();

    await input.setInputFiles(oversizedPng());
    await expect(page.getByText('Logo trop volumineux (1 Mo maximum)')).toBeVisible();

    expect(posts()).toBe(0);
    await expect(page.getByText('Aucun logo déposé')).toBeVisible();
    expect((await lire(api)).logoFileName).toBeNull();
  });

  test('SOC-75 retire le logo après confirmation ; « Annuler » ne retire rien', async ({
    page,
    api,
  }) => {
    await api.upload(LOGO, { field: 'file', file: tinyPng() });
    const deletes = compterRequetes(page, LOGO, 'DELETE');

    await ouvrirEcran(page);
    await expect(page.getByRole('img', { name: 'Logo des e-mails' })).toBeVisible();

    // Annuler : rien ne part.
    await page.getByRole('button', { name: 'Retirer', exact: true }).click();
    let confirmation = page.getByRole('dialog').filter({ hasText: 'Retirer le logo ?' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Annuler' }).click();
    await expect(confirmation).toBeHidden();
    expect(deletes()).toBe(0);
    await expect(page.getByRole('img', { name: 'Logo des e-mails' })).toBeVisible();

    // Confirmer : le logo disparaît de l'écran, de la base et de la route publique.
    await page.getByRole('button', { name: 'Retirer', exact: true }).click();
    confirmation = page.getByRole('dialog').filter({ hasText: 'Retirer le logo ?' });
    const retire = page.waitForResponse(reponse(LOGO, 'DELETE'));
    await confirmation.getByRole('button', { name: 'Retirer', exact: true }).click();
    expect((await retire).status()).toBe(200);
    await expect(page.getByText('Logo retiré')).toBeVisible();
    await expect(page.getByText('Aucun logo déposé')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Déposer un logo' })).toBeVisible();

    const lu = await lire(api);
    expect(lu.logoFileName).toBeNull();
    expect(lu.logoOriginalName).toBeNull();
    expect((await api.raw.get(LOGO)).status()).toBe(404);

    // Retirer quand il n'y a rien : sans effet, sans erreur.
    expect((await api.raw.del(LOGO)).status()).toBe(200);
  });
});

test.describe('Paramétrage e-mail — route publique du logo', () => {
  test('SOC-77 GET du logo est public, typé et mis en cache ; 404 propre sans logo', async ({
    api,
  }) => {
    await api.upload(LOGO, { field: 'file', file: tinyPng() });

    // Client SANS jeton : la route doit répondre à un client mail, qui n'en a pas.
    const anonyme = await createApiClient({ token: null });
    try {
      // Témoin : le reste du paramétrage exige bien une authentification.
      expect((await anonyme.raw.get(BASE)).status()).toBe(401);

      const res = await anonyme.raw.get(LOGO, { query: { v: Date.now() } });
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('image/png');
      expect(res.headers()['cache-control']).toBe('public, max-age=3600');
      expect(Buffer.compare(await res.body(), PNG_1PX)).toBe(0);

      await api.del(LOGO);
      const absent = await anonyme.raw.get(LOGO, { query: { v: Date.now() } });
      // Ni 401 (route publique), ni 500 : un 404 que le client mail sait ignorer.
      expect(absent.status()).toBe(404);
    } finally {
      await anonyme.dispose();
    }
  });
});

test.describe('Paramétrage e-mail — contrôle d’accès', () => {
  test('SOC-76 l’API refuse tout le paramétrage (403) sans le menu, sauf le logo public', async ({
    api,
    apiAs,
    uniq,
  }) => {
    await api.put(BASE, { orgName: uniq('Organisation') });
    await api.upload(LOGO, { field: 'file', file: tinyPng() });
    const avant = await lire(api);

    const u = await createRestrictedUser(api, uniq, ['/search']);
    const restreint = await apiAs(u.username, u.password);

    expect((await restreint.raw.get(BASE)).status()).toBe(403);
    expect((await restreint.raw.put(BASE, { orgName: 'Écrasé' })).status()).toBe(403);
    expect((await uploadRaw(restreint, LOGO, tinyPng('autre.png'))).status()).toBe(403);
    expect((await restreint.raw.del(LOGO)).status()).toBe(403);
    // Seule exception : le logo, public par conception.
    expect((await restreint.raw.get(LOGO)).status()).toBe(200);

    expect(await lire(api)).toEqual(avant);
  });

  test('SOC-76 un non-administrateur qui détient le menu peut paramétrer', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_EMAIL]);
    const delegue = await apiAs(u.username, u.password);
    const org = uniq('Organisation');

    await delegue.put(BASE, { orgName: org });
    expect((await lire(delegue)).orgName).toBe(org);
    expect((await lire(api)).orgName).toBe(org);
  });

  test.describe('écran', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('SOC-76 sans le menu : entrée absente de la barre latérale, accès direct refusé proprement', async ({
      page,
      api,
      uniq,
      loginAs,
    }) => {
      const u = await createRestrictedUser(api, uniq, ['/search']);
      await loginAs(page, u.username, u.password);

      // La section « Administration » n'a aucune entrée visible pour ce rôle : elle est masquée.
      const barre = page.locator('.ant-layout-sider');
      await expect(barre).toBeVisible();
      await expect(barre.getByText('Administration', { exact: true })).toHaveCount(0);

      const refuse = await ouvrirEcran(page);
      expect(refuse.status()).toBe(403);
    });

    // Décision de l'utilisateur (2026-11-22) : « Accès refusé » dès l'ouverture (AuthShell, transverse).
    test.fixme('SOC-76 en attente du lot transverse : écran Accès refusé sur le paramétrage e-mail', async ({
      page,
      api,
      uniq,
      loginAs,
    }) => {
      const u = await createRestrictedUser(api, uniq, ['/search']);
      await loginAs(page, u.username, u.password);
      await page.goto('/admin/parametres/email');
      await expect(page.getByText('Accès refusé').first()).toBeVisible();
      await expect(champOrg(page)).toHaveCount(0);
      await expect(page.getByRole('img', { name: 'Logo des e-mails' })).toHaveCount(0);
    });
  });
});
