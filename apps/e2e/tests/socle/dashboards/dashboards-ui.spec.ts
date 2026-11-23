import { test, expect } from '../../../fixtures';
import { createRestrictedUser } from '../_helpers/accounts';
import {
  AGENCEMENT_DEFAUT,
  IDS_DEFAUT,
  LAYOUT_PATH,
  MENU_DASHBOARDS,
  OVERVIEW_PATH,
  WIDGET_TITRES,
  joursEntre,
  ouvrirTableauDeBord,
  position,
  reponseApi,
  requeteApi,
  widget,
  type Agencement,
  type Placement,
} from '../_helpers/dashboards';

/**
 * Tableaux de bord Docu-Archives — écran `/dashboards` (SOC-78..83, SOC-87).
 *
 * L'agencement est PAR UTILISATEUR : chaque test crée son propre compte (rôle limité à
 * `/dashboards`) et s'y connecte, pour ne jamais partager une disposition avec un autre test ni avec
 * l'administrateur. D'où un contexte de page vierge, sans le storageState administrateur.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const lireAgencement = async (client: { get(path: string): Promise<unknown> }) =>
  (await client.get(LAYOUT_PATH)) as Agencement;

test.describe('Tableaux de bord — affichage', () => {
  test('SOC-78 affiche l’agencement livré à un utilisateur qui n’a rien personnalisé', async ({
    page,
    api,
    uniq,
    loginAs,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    await loginAs(page, u.username, u.password);
    await expect(page).toHaveURL(/\/dashboards$/);
    // Premier chargement terminé avant de recharger : ses réponses ne se mêlent pas au second.
    await expect(widget(page, 'kpis')).toBeVisible();

    const { agencement, filtre } = await ouvrirTableauDeBord(page);
    expect(agencement.parDefaut).toBe(true);
    expect(agencement.colonnes).toBe(12);
    expect(agencement.widgets.map(position)).toEqual(AGENCEMENT_DEFAUT);
    // Tout le catalogue est proposé : chaque widget n'exige que l'accès à l'écran.
    expect(agencement.disponibles.map((d) => d.id).sort()).toEqual([...IDS_DEFAUT].sort());
    // Période initiale : 30 derniers jours, bornes incluses.
    expect(joursEntre(String(filtre.dateFrom), String(filtre.dateTo))).toBe(29);

    for (const id of IDS_DEFAUT) {
      await expect(widget(page, id)).toBeVisible();
      await expect(widget(page, id)).toContainText(WIDGET_TITRES[id as keyof typeof WIDGET_TITRES]);
    }
    await expect(widget(page, 'kpis').getByText('Documents archivés')).toBeVisible();
    await expect(page.getByText('Bienvenue sur Docu-Archives')).toBeVisible();
    // Hors mode édition, aucun contrôle de retrait n'est proposé.
    await expect(page.getByRole('button', { name: /^Retirer / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Personnaliser' })).toBeEnabled();
  });

  test('SOC-79 le filtre de période relance l’agrégat avec les bornes du préréglage', async ({
    page,
    api,
    uniq,
    loginAs,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    await loginAs(page, u.username, u.password);
    await ouvrirTableauDeBord(page);

    // On attend la RÉPONSE de chaque préréglage avant de passer au suivant : sinon la réponse encore
    // en vol du préréglage précédent serait prise pour celle du suivant.
    const sept = page.waitForResponse(reponseApi(OVERVIEW_PATH, 'POST'));
    await page.getByText('7 j', { exact: true }).click();
    const rep7 = await sept;
    expect(rep7.status()).toBe(200);
    const corps7 = rep7.request().postDataJSON() as { dateFrom: string; dateTo: string };
    expect(joursEntre(corps7.dateFrom, corps7.dateTo)).toBe(6);
    expect(corps7).toMatchObject({ granularity: 'day', basis: 'created_at' });

    const annee = page.waitForResponse(reponseApi(OVERVIEW_PATH, 'POST'));
    await page.getByText('Année', { exact: true }).click();
    const repA = await annee;
    expect(repA.status()).toBe(200);
    const corpsA = repA.request().postDataJSON() as { dateFrom: string; dateTo: string };
    expect(corpsA.dateFrom).toBe(`${corpsA.dateTo.slice(0, 4)}-01-01`);

    const jour = page.waitForResponse(reponseApi(OVERVIEW_PATH, 'POST'));
    await page.getByText("Aujourd'hui", { exact: true }).click();
    const rep = await jour;
    expect(rep.status()).toBe(200);
    const corpsJ = rep.request().postDataJSON() as Record<string, string>;
    expect(corpsJ.dateFrom).toBe(corpsJ.dateTo);

    // Plage personnalisée : le sélecteur de dates apparaît.
    await page.getByText('Perso.', { exact: true }).click();
    await expect(page.getByPlaceholder('Date de début')).toBeVisible();

    // En mode édition, le filtre est masqué : c'est la grille qu'on manipule.
    await page.getByRole('button', { name: 'Personnaliser' }).click();
    await expect(page.getByText('7 j', { exact: true })).toBeHidden();
  });
});

test.describe('Tableaux de bord — personnalisation', () => {
  test('SOC-80 ajoute un widget par la modale et le conserve après rechargement', async ({
    page,
    api,
    apiAs,
    uniq,
    loginAs,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const client = await apiAs(u.username, u.password);
    await client.put(LAYOUT_PATH, {
      widgets: AGENCEMENT_DEFAUT.filter((w) => w.id !== 'evolution'),
    });
    await loginAs(page, u.username, u.password);
    await ouvrirTableauDeBord(page);
    await expect(widget(page, 'kpis')).toBeVisible();
    await expect(widget(page, 'evolution')).toHaveCount(0);

    await page.getByRole('button', { name: 'Personnaliser' }).click();
    await page.getByRole('button', { name: 'Ajouter un widget' }).click();
    const modale = page.getByRole('dialog', { name: 'Ajouter un widget' });
    await expect(modale).toBeVisible();
    // Seul le widget NON placé est proposé : un widget ne figure qu'une fois.
    await expect(modale.getByText(WIDGET_TITRES.evolution)).toBeVisible();
    await expect(modale.getByRole('button', { name: 'Ajouter', exact: true })).toHaveCount(1);
    await modale.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(modale).toBeHidden();
    await expect(widget(page, 'evolution')).toBeVisible();

    // Plus rien à ajouter : la modale le dit.
    await page.getByRole('button', { name: 'Ajouter un widget' }).click();
    await expect(modale.getByText('Tous les widgets sont déjà affichés')).toBeVisible();
    await modale.getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(modale).toBeHidden();

    const enregistre = page.waitForResponse(reponseApi(LAYOUT_PATH, 'PUT'));
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    const rep = await enregistre;
    expect(rep.status()).toBe(200);
    const envoye = (rep.request().postDataJSON() as { widgets: Placement[] }).widgets;
    expect(envoye.map((w) => w.id)).toContain('evolution');
    await expect(page.getByText('Tableau de bord enregistré')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Personnaliser' })).toBeVisible();

    const lu = await lireAgencement(client);
    expect(lu.parDefaut).toBe(false);
    expect(lu.widgets.map((w) => w.id).sort()).toEqual([...IDS_DEFAUT].sort());

    await ouvrirTableauDeBord(page);
    await expect(widget(page, 'evolution')).toBeVisible();
  });

  test('SOC-81 retire un widget ; « Annuler » abandonne, « Enregistrer » le retire durablement', async ({
    page,
    api,
    apiAs,
    uniq,
    loginAs,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const client = await apiAs(u.username, u.password);
    await loginAs(page, u.username, u.password);
    await ouvrirTableauDeBord(page);

    let puts = 0;
    page.on('request', (r) => {
      if (requeteApi(LAYOUT_PATH, 'PUT')(r)) puts += 1;
    });

    // Retrait puis abandon : le serveur n'est pas touché, le widget revient.
    await page.getByRole('button', { name: 'Personnaliser' }).click();
    await page.getByRole('button', { name: `Retirer ${WIDGET_TITRES.dossier}` }).click();
    await expect(widget(page, 'dossier')).toHaveCount(0);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(widget(page, 'dossier')).toBeVisible();
    expect(puts).toBe(0);
    expect((await lireAgencement(client)).parDefaut).toBe(true);

    // Retrait puis enregistrement.
    await page.getByRole('button', { name: 'Personnaliser' }).click();
    await page.getByRole('button', { name: `Retirer ${WIDGET_TITRES.dossier}` }).click();
    const enregistre = page.waitForResponse(reponseApi(LAYOUT_PATH, 'PUT'));
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    expect((await enregistre).status()).toBe(200);
    await expect(page.getByText('Tableau de bord enregistré')).toBeVisible();

    const lu = await lireAgencement(client);
    expect(lu.parDefaut).toBe(false);
    expect(lu.widgets.map((w) => w.id)).toEqual(IDS_DEFAUT.filter((id) => id !== 'dossier'));

    await ouvrirTableauDeBord(page);
    await expect(widget(page, 'dossier')).toHaveCount(0);
    for (const id of IDS_DEFAUT.filter((i) => i !== 'dossier')) {
      await expect(widget(page, id)).toBeVisible();
    }
  });

  test('SOC-82 une disposition personnalisée est conservée telle quelle et réaffichée', async ({
    page,
    api,
    apiAs,
    uniq,
    loginAs,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const client = await apiAs(u.username, u.password);
    // Croissance en tête, chiffres clés dessous, « type » seul sur la moitié DROITE.
    const perso: Placement[] = [
      { id: 'evolution', x: 0, y: 0, w: 12, h: 9 },
      { id: 'kpis', x: 0, y: 9, w: 12, h: 5 },
      { id: 'type', x: 6, y: 14, w: 6, h: 9 },
    ];

    const enregistre = (await client.put(LAYOUT_PATH, { widgets: perso })) as Agencement;
    expect(enregistre.parDefaut).toBe(false);
    expect(enregistre.widgets.map(position)).toEqual(perso);
    // Persistance réelle : relu par un nouvel appel, pas seulement renvoyé par le PUT.
    expect((await lireAgencement(client)).widgets.map(position)).toEqual(perso);

    await loginAs(page, u.username, u.password);
    await ouvrirTableauDeBord(page);
    for (const id of ['dossier', 'plan']) await expect(widget(page, id)).toHaveCount(0);

    const boite = async (id: string) => {
      const b = await widget(page, id).boundingBox();
      if (!b) throw new Error(`widget ${id} sans boîte`);
      return b;
    };
    // La grille se positionne après mesure du conteneur : on attend l'ordre attendu, sans délai fixe.
    await expect
      .poll(async () => (await boite('evolution')).y < (await boite('kpis')).y)
      .toBe(true);
    await expect.poll(async () => (await boite('kpis')).y < (await boite('type')).y).toBe(true);
    await expect
      .poll(async () => {
        const [k, t] = [await boite('kpis'), await boite('type')];
        return t.x > k.x + k.width / 3;
      })
      .toBe(true);
  });

  /**
   * P3 — glisser-déposer react-grid-layout. Non activé : le déplacement dépend d'une suite
   * d'événements souris (seuil de déclenchement, compactage vertical) dont le résultat exact n'est
   * pas garanti sans attente. La PERSISTANCE des positions est couverte par SOC-82 via l'API ; ce
   * scénario ne vérifie que la chaîne poignée → onLayoutChange → PUT.
   */
  test.fixme('SOC-82 glisser l’en-tête d’un widget le déplace et l’enregistre (DnD, P3)', async ({
    page,
    api,
    apiAs,
    uniq,
    loginAs,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const client = await apiAs(u.username, u.password);
    await loginAs(page, u.username, u.password);
    await ouvrirTableauDeBord(page);
    await page.getByRole('button', { name: 'Personnaliser' }).click();

    const poignee = widget(page, 'evolution').locator('.tdb-poignee');
    const cible = widget(page, 'kpis').locator('.tdb-poignee');
    const de = await poignee.boundingBox();
    const vers = await cible.boundingBox();
    if (!de || !vers) throw new Error('poignées introuvables');
    await page.mouse.move(de.x + 20, de.y + de.height / 2);
    await page.mouse.down();
    await page.mouse.move(vers.x + 20, vers.y + 2, { steps: 20 });
    await page.mouse.up();

    const enregistre = page.waitForResponse(reponseApi(LAYOUT_PATH, 'PUT'));
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    expect((await enregistre).status()).toBe(200);
    const lu = await lireAgencement(client);
    const evolution = lu.widgets.find((w) => w.id === 'evolution');
    expect(evolution?.y).toBe(0);
  });

  test('SOC-83 « Réinitialiser » rétablit l’agencement livré et supprime la personnalisation', async ({
    page,
    api,
    apiAs,
    uniq,
    loginAs,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const client = await apiAs(u.username, u.password);
    await client.put(LAYOUT_PATH, { widgets: [{ id: 'kpis', x: 0, y: 0, w: 12, h: 5 }] });
    await loginAs(page, u.username, u.password);
    await ouvrirTableauDeBord(page);
    await expect(widget(page, 'type')).toHaveCount(0);

    await page.getByRole('button', { name: 'Personnaliser' }).click();
    const reinit = page.waitForResponse(reponseApi(LAYOUT_PATH, 'DELETE'));
    await page.getByRole('button', { name: 'Réinitialiser' }).click();
    expect((await reinit).status()).toBe(200);
    await expect(page.getByText('Agencement par défaut rétabli')).toBeVisible();
    // Sortie du mode édition, grille livrée.
    await expect(page.getByRole('button', { name: 'Personnaliser' })).toBeVisible();
    for (const id of IDS_DEFAUT) await expect(widget(page, id)).toBeVisible();

    const lu = await lireAgencement(client);
    expect(lu.parDefaut).toBe(true);
    expect(lu.widgets.map(position)).toEqual(AGENCEMENT_DEFAUT);

    await ouvrirTableauDeBord(page);
    for (const id of IDS_DEFAUT) await expect(widget(page, id)).toBeVisible();
  });
});

test.describe('Tableaux de bord — utilisateur sans le menu /dashboards', () => {
  /**
   * Comportement cible (décision de l'utilisateur du 2026-11-22) : un compte sans `/dashboards` ne
   * voit pas l'entrée et n'y est pas redirigé ; ouvert par son adresse, l'écran affiche « Accès
   * refusé ». Le correctif est dans `AuthShell` (transverse) : aujourd'hui la connexion mène à
   * `/dashboards`, l'agencement répond 403 et le squelette tourne sans fin (A-D6). Le 403 de l'API
   * est vérifié dès maintenant par SOC-86 et SOC-87 (dashboards-api.spec.ts).
   */
  test.fixme('SOC-87 en attente du lot transverse : écran Accès refusé (utilisateur sans /dashboards, A-D6)', async ({
    page,
    api,
    uniq,
    loginAs,
  }) => {
    const u = await createRestrictedUser(api, uniq, ['/search']);
    await loginAs(page, u.username, u.password);
    // Pas de redirection vers un écran non autorisé, pas d'entrée « Tableaux de bord » au menu.
    await expect(page).not.toHaveURL(/\/dashboards$/);
    await expect(page.locator('.ant-layout-sider').getByText('Tableaux de bord', { exact: true })).toHaveCount(0);
    // Ouvert par son adresse : « Accès refusé » dès l'ouverture, aucun squelette infini.
    await page.goto('/dashboards');
    await expect(page.getByText('Accès refusé').first()).toBeVisible();
    await expect(page.locator('.ant-skeleton')).toHaveCount(0);
  });
});
