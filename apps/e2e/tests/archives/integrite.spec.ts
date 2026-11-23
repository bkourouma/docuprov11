/**
 * Intégrité du fonds — écran `/archives/integrite` : indicateurs de couverture, contrôle du fonds
 * par tranches, liste des non-conformités. Scénarios ARC-31, ARC-32 et ARC-33.
 *
 * Le fonds de la pile E2E est PARTAGÉ par les tests qui tournent en parallèle : les compteurs
 * bougent pendant un test. On ne compare donc jamais un indicateur à une valeur figée, mais à la
 * réponse du serveur que l'écran vient d'afficher, et l'effet du contrôle se lit sur le document
 * créé par le test lui-même.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Response } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { creerDocumentArchive } from './_helpers/documents';
import { creerUtilisateurAvecMenus } from './_helpers/utilisateurs';
import { MENUS, REFUS_MENU } from './_helpers/archives-data';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

interface Couverture {
  documents: number;
  fichiers: number;
  fichiersAvecEmpreinte: number;
  jamaisVerifies: number;
  verifies: number;
  conformes: number;
  nonConformes: number;
  scelles: number;
}

interface EtatIntegrite {
  dateLastVerified: string | null;
  integrityOk: boolean | null;
  files: Array<{ fileId: number; vaultName: string; hash: string | null }>;
}

interface Verification {
  integrityOk: boolean | null;
  files: Array<{ status: 'ok' | 'mismatch' | 'missing' | 'imprinted' }>;
}

const estCouverture = (r: Response) =>
  r.request().method() === 'GET' &&
  new URL(r.url()).pathname.endsWith('/api/documents/integrity/coverage');

/** Entier tel que `fmtInt` l'affiche (séparateur de milliers : une espace, fine ou non). */
function entier(n: number): RegExp {
  return new RegExp(`^${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\\s?')}$`);
}

/** Valeur d'un indicateur, repéré par son libellé en tête de carte. */
function indicateur(page: Page, libelle: string) {
  return page
    .locator('.ant-card')
    .filter({ hasText: new RegExp(`^${libelle}`) })
    .locator('.da-mono');
}

/**
 * Suit TOUTES les réponses de couverture de la page : en mode développement, React rejoue l'effet
 * de chargement (StrictMode) et c'est la DERNIÈRE réponse que l'écran affiche.
 */
function suivreCouverture(page: Page): () => Couverture | undefined {
  const recues: Couverture[] = [];
  page.on('response', (r) => {
    if (estCouverture(r) && r.status() === 200) {
      void r.json().then((c) => recues.push(c as Couverture));
    }
  });
  return () => recues.at(-1);
}

/** Les cinq indicateurs affichent exactement la dernière couverture renvoyée par le serveur. */
async function verifierIndicateurs(page: Page, derniere: () => Couverture | undefined) {
  await expect(async () => {
    const c = derniere();
    expect(c, 'couverture reçue').toBeDefined();
    const texte = async (libelle: string) => (await indicateur(page, libelle).textContent()) ?? '';
    expect(await texte('Documents au fonds')).toMatch(entier(c!.documents));
    expect(await texte('Empreintes posées')).toBe(`${c!.fichiersAvecEmpreinte} / ${c!.fichiers}`);
    expect(await texte('Documents vérifiés')).toBe(`${c!.verifies} / ${c!.documents}`);
    expect(await texte('Non conformes')).toMatch(entier(c!.nonConformes));
    expect(await texte('Documents scellés')).toBe(`${c!.scelles} / ${c!.documents}`);
  }).toPass({ timeout: 15_000 });
}

/** Ouvre l'écran ; renvoie l'accès à la dernière couverture reçue (première réponse contrôlée). */
async function ouvrirIntegrite(page: Page) {
  const derniere = suivreCouverture(page);
  const premiere = page.waitForResponse(estCouverture);
  await page.goto('/archives/integrite');
  await expect(page.getByRole('heading', { name: 'Intégrité du fonds' })).toBeVisible();
  expect((await premiere).status()).toBe(200);
  await verifierIndicateurs(page, derniere);
  return derniere;
}

test.describe('Intégrité du fonds', () => {
  test('ARC-31 affiche la couverture du fonds et contrôle tout le fonds depuis l’écran', async ({
    page,
    api,
    uniq,
  }) => {
    test.setTimeout(240_000);
    const u = uniq('ARC-31');
    const doc = await creerDocumentArchive(api, { label: `${u} doc` });

    const derniere = await ouvrirIntegrite(page);
    const avant = derniere()!;
    expect(avant.documents).toBeGreaterThan(0);
    expect(avant.verifies + avant.jamaisVerifies).toBe(avant.documents);
    await expect(page.getByText('Ce que ce contrôle établit')).toBeVisible();

    // Le contrôle enchaîne les tranches puis recharge la couverture : on attend ce rechargement.
    const balayages: Response[] = [];
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && r.url().endsWith('/api/documents/integrity/sweep')) {
        balayages.push(r);
      }
    });
    const rechargement = page.waitForResponse(estCouverture, { timeout: 200_000 });
    await page.getByRole('button', { name: 'Contrôler tout le fonds' }).click();
    expect((await rechargement).status()).toBe(200);

    await expect(page.getByText(/^Fonds contrôlé : \d+ document\(s\)$/)).toBeVisible();
    expect(balayages.length).toBeGreaterThan(0);
    for (const b of balayages) expect(b.status()).toBe(200);
    // Tranches de 50 au plus, dernière ajustée au reste (écran) — jamais plus que le plafond.
    for (const b of balayages) {
      expect((b.request().postDataJSON() as { limit: number }).limit).toBeLessThanOrEqual(50);
    }
    await verifierIndicateurs(page, derniere);
    expect(derniere()!.verifies).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Contrôler tout le fonds' })).toBeEnabled();

    // Le document du test, jamais contrôlé, l'a été — et il est conforme.
    const etat = (await api.get(`/documents/${doc.documentId}/integrity`)) as EtatIntegrite;
    expect(etat.dateLastVerified).not.toBeNull();
    expect(etat.integrityOk).toBe(true);
    expect(etat.files.length).toBeGreaterThan(0);
    for (const f of etat.files) expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
    // Il ne figure pas parmi les non-conformes.
    await expect(page.getByRole('link', { name: doc.label, exact: true })).toHaveCount(0);
  });

  /**
   * L'altération d'un binaire n'est possible que si le test connaît le coffre de la pile E2E.
   * Hypothèse remontée au lot 0 : exposer `E2E_ARCHIVES_PATH` (le `ARCHIVES_PATH` de l'API de test).
   * Le binaire altéré est celui du document créé par le test, dans la base jetable, et il est
   * restauré à la fin quoi qu'il arrive.
   */
  const coffre = process.env.E2E_ARCHIVES_PATH;

  test('ARC-32 détecte un binaire altéré sur le coffre et le liste parmi les non-conformes', async ({
    page,
    api,
    uniq,
  }) => {
    test.fixme(
      !coffre,
      'E2E_ARCHIVES_PATH non défini : la pile E2E n’expose pas son coffre, impossible d’altérer un binaire de test',
    );
    const u = uniq('ARC-32');
    const doc = await creerDocumentArchive(api, { label: `${u} doc` });

    // Référence : premier contrôle (pose l'empreinte si besoin), conforme.
    const initial = (await api.post(
      `/documents/${doc.documentId}/integrity/verify`,
      {},
    )) as Verification;
    expect(initial.integrityOk).toBe(true);
    const etat = (await api.get(`/documents/${doc.documentId}/integrity`)) as EtatIntegrite;
    const cible = join(coffre!, etat.files[0]!.vaultName);
    const original = await readFile(cible);

    try {
      await writeFile(cible, Buffer.concat([original, Buffer.from('\n<!-- altération E2E -->\n')]));
      const controle = (await api.post(
        `/documents/${doc.documentId}/integrity/verify`,
        {},
      )) as Verification;
      expect(controle.integrityOk).toBe(false);
      expect(controle.files[0]!.status).toBe('mismatch');

      const derniere = await ouvrirIntegrite(page);
      expect(derniere()!.nonConformes).toBeGreaterThan(0);
      const lien = page.getByRole('link', { name: doc.label, exact: true });
      await expect(lien).toBeVisible();
      await expect(lien).toHaveAttribute('href', `/documents/${doc.documentId}`);
      await expect(
        page.getByRole('row').filter({ hasText: doc.label }).getByText('Intégrité non garantie'),
      ).toBeVisible();
    } finally {
      await writeFile(cible, original);
    }

    // Restauré : de nouveau conforme, et sorti de la liste.
    const retabli = (await api.post(
      `/documents/${doc.documentId}/integrity/verify`,
      {},
    )) as Verification;
    expect(retabli.integrityOk).toBe(true);
    const nonConformes = (await api.get('/documents/integrity/non-compliant')) as Array<{
      documentId: number;
    }>;
    expect(nonConformes.map((n) => n.documentId)).not.toContain(doc.documentId);
  });

  test('ARC-33 sans le menu, l’écran et les routes d’intégrité du fonds sont refusés', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const u = uniq('ARC-33');
    const sans = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-sans`,
      menus: [MENUS.autre],
    });
    const avec = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-avec`,
      menus: [MENUS.integrite],
    });

    const clientSans = await apiAs(sans.username, sans.password);
    expect((await clientSans.raw.get('/documents/integrity/coverage')).status()).toBe(403);
    expect((await clientSans.raw.get('/documents/integrity/non-compliant')).status()).toBe(403);
    expect((await clientSans.raw.post('/documents/integrity/sweep', { limit: 1 })).status()).toBe(
      403,
    );
    expect(
      (await clientSans.raw.post('/documents/integrity/seal-fonds', { limit: 1 })).status(),
    ).toBe(403);
    // Contrôle positif : le menu suffit (lecture seule ici, pour ne pas balayer le fonds partagé).
    const clientAvec = await apiAs(avec.username, avec.password);
    expect((await clientAvec.raw.get('/documents/integrity/coverage')).status()).toBe(200);
    expect((await clientAvec.raw.get('/documents/integrity/non-compliant')).status()).toBe(200);

    await loginAs(page, sans.username, sans.password);
    const couverture = page.waitForResponse(estCouverture);
    await page.goto('/archives/integrite');
    expect((await couverture).status()).toBe(403);
    await expect(page.getByText(REFUS_MENU).first()).toBeVisible();
    // Aucun chiffre n'est affiché : les indicateurs restent vides.
    await expect(indicateur(page, 'Documents au fonds')).toHaveText('—');
    await expect(
      page.getByRole('menuitem', { name: 'Intégrité du fonds', exact: true }),
    ).toHaveCount(0);
  });
});
