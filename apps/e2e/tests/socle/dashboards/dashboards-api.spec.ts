import { test, expect } from '../../../fixtures';
import { createRestrictedUser, setRoleMenus } from '../_helpers/accounts';
import {
  AGENCEMENT_DEFAUT,
  EXPORT_PATH,
  IDS_DEFAUT,
  LAYOUT_PATH,
  MENU_DASHBOARDS,
  OVERVIEW_PATH,
  position,
  type Agencement,
} from '../_helpers/dashboards';

/**
 * Tableaux de bord — API d'agencement et d'export (SOC-84..88). Chaque test travaille sur ses
 * propres comptes : l'agencement est rangé par utilisateur.
 */

const lire = async (client: { get(path: string): Promise<unknown> }) =>
  (await client.get(LAYOUT_PATH)) as Agencement;

const KPIS_SEUL = [{ id: 'kpis', x: 0, y: 0, w: 12, h: 5 }];

test.describe('Agencement — isolation et validation', () => {
  test('SOC-84 la disposition d’un utilisateur n’affecte pas celle d’un autre', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const a = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const b = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const ca = await apiAs(a.username, a.password);
    const cb = await apiAs(b.username, b.password);

    await ca.put(LAYOUT_PATH, { widgets: KPIS_SEUL });

    const vueB = await lire(cb);
    expect(vueB.parDefaut).toBe(true);
    expect(vueB.widgets.map(position)).toEqual(AGENCEMENT_DEFAUT);

    // B personnalise puis réinitialise : A garde sa disposition.
    await cb.put(LAYOUT_PATH, { widgets: [{ id: 'evolution', x: 0, y: 0, w: 12, h: 9 }] });
    await cb.del(LAYOUT_PATH);
    const vueA = await lire(ca);
    expect(vueA.parDefaut).toBe(false);
    expect(vueA.widgets.map(position)).toEqual(KPIS_SEUL);
    expect((await lire(cb)).parDefaut).toBe(true);
  });

  test('SOC-85 un widget inconnu est écarté, un doublon fusionné, les tailles bornées au catalogue', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const c = await apiAs(u.username, u.password);

    // Inconnu : filtré (le stockage ne doit pas devenir une porte dérobée), sans faire échouer.
    const r1 = (await c.put(LAYOUT_PATH, {
      widgets: [...KPIS_SEUL, { id: 'widget-inexistant', x: 0, y: 5, w: 6, h: 6 }],
    })) as Agencement;
    expect(r1.widgets.map((w) => w.id)).toEqual(['kpis']);
    expect((await lire(c)).widgets.map((w) => w.id)).toEqual(['kpis']);

    // Doublon : un seul bloc par identifiant.
    const r2 = (await c.put(LAYOUT_PATH, {
      widgets: [
        { id: 'type', x: 0, y: 0, w: 6, h: 9 },
        { id: 'type', x: 6, y: 9, w: 6, h: 9 },
      ],
    })) as Agencement;
    expect(r2.widgets.filter((w) => w.id === 'type')).toHaveLength(1);

    // Tailles sous le minimum du catalogue (kpis : minW 6, minH 4) : relevées, pas refusées.
    const r3 = (await c.put(LAYOUT_PATH, {
      widgets: [{ id: 'kpis', x: 0, y: 0, w: 1, h: 1 }],
    })) as Agencement;
    expect(r3.widgets.map(position)).toEqual([{ id: 'kpis', x: 0, y: 0, w: 6, h: 4 }]);

    // Valeurs numériques transmises en texte : acceptées (coercition du schéma).
    const r4 = (await c.put(LAYOUT_PATH, {
      widgets: [{ id: 'kpis', x: '0', y: '2', w: '12', h: '5' }],
    })) as Agencement;
    expect(r4.widgets.map(position)).toEqual([{ id: 'kpis', x: 0, y: 2, w: 12, h: 5 }]);
  });

  /**
   * ANOMALIE A-D3 (mineure) : `x` est borné à 0..11 et `w` à minW..12, mais pas leur SOMME. Un
   * widget de 12 colonnes posé en x = 11 est enregistré tel quel (débordement de 11 colonnes) ;
   * react-grid-layout le recale à l'affichage, donc le stocké diffère de l'affiché. Correctif
   * proposé dans `apps/api/src/common/agencement.service.ts` (transverse) : `x ≤ 12 − w`.
   */
  // Défaut confirmé (A-D3) dans un fichier transverse, `apps/api/src/common/agencement.service.ts`.
  test.fixme('SOC-85 en attente du lot transverse : une position enregistrée ne déborde jamais des 12 colonnes (A-D3)', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const c = await apiAs(u.username, u.password);

    const r = (await c.put(LAYOUT_PATH, {
      widgets: [{ id: 'evolution', x: 50, y: 0, w: 12, h: 9 }],
    })) as Agencement;
    const w = r.widgets[0]!;
    expect(w.w).toBe(12);
    expect(w.x + w.w).toBeLessThanOrEqual(r.colonnes);
  });

  test('SOC-85 un corps d’agencement mal formé est refusé en 400, sans rien écrire', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const c = await apiAs(u.username, u.password);
    await c.put(LAYOUT_PATH, { widgets: KPIS_SEUL });

    const trop = Array.from({ length: 51 }, (_, i) => ({ id: `w${i}`, x: 0, y: i, w: 1, h: 1 }));
    for (const corps of [
      {},
      { widgets: 'kpis' },
      { widgets: [{ id: 'kpis', x: -1, y: 0, w: 12, h: 5 }] },
      { widgets: [{ id: '', x: 0, y: 0, w: 12, h: 5 }] },
      { widgets: [{ id: 'kpis', x: 0, y: 0, w: 12 }] },
      // Objets stricts : une clé hors contrat (ici un titre) est refusée, pas ignorée.
      { widgets: [{ id: 'kpis', x: 0, y: 0, w: 12, h: 5, titre: 'Piraté' }] },
      { widgets: KPIS_SEUL, proprietaire: 1 },
      { widgets: trop },
    ]) {
      const res = await c.raw.put(LAYOUT_PATH, corps);
      expect(res.status(), JSON.stringify(corps).slice(0, 80)).toBe(400);
    }
    expect((await lire(c)).widgets.map(position)).toEqual(KPIS_SEUL);
  });

  test('SOC-85 un agencement vidé retombe sur l’agencement livré (pas d’écran nu)', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const c = await apiAs(u.username, u.password);

    const r = (await c.put(LAYOUT_PATH, { widgets: [] })) as Agencement;
    expect(r.parDefaut).toBe(true);
    expect(r.widgets.map((w) => w.id)).toEqual([...IDS_DEFAUT]);

    // Réinitialiser deux fois de suite : sans erreur (idempotent).
    expect((await c.raw.del(LAYOUT_PATH)).status()).toBe(200);
    expect((await c.raw.del(LAYOUT_PATH)).status()).toBe(200);
  });
});

test.describe('Agencement — contrôle d’accès', () => {
  test('SOC-86 sans le menu /dashboards, l’agencement est refusé (403) en lecture comme en écriture', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = await createRestrictedUser(api, uniq, ['/search']);
    const c = await apiAs(u.username, u.password);

    expect((await c.raw.get(LAYOUT_PATH)).status()).toBe(403);
    expect((await c.raw.put(LAYOUT_PATH, { widgets: KPIS_SEUL })).status()).toBe(403);
    expect((await c.raw.del(LAYOUT_PATH)).status()).toBe(403);
  });

  test('SOC-86 un droit retiré puis rendu retrouve sa disposition intacte', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = await createRestrictedUser(api, uniq, [MENU_DASHBOARDS]);
    const c = await apiAs(u.username, u.password);
    await c.put(LAYOUT_PATH, { widgets: KPIS_SEUL });

    // Les menus sont relus en base à chaque appel : pas besoin de se reconnecter.
    await setRoleMenus(api, u.roleId, ['/search']);
    expect((await c.raw.get(LAYOUT_PATH)).status()).toBe(403);

    await setRoleMenus(api, u.roleId, [MENU_DASHBOARDS]);
    const vue = await lire(c);
    // Re-filtrage À LA LECTURE, sans effacement : la disposition revient en place.
    expect(vue.parDefaut).toBe(false);
    expect(vue.widgets.map(position)).toEqual(KPIS_SEUL);
  });

  /**
   * Règle (décision de l'utilisateur du 2026-11-22) : les statistiques (`overview`, `targets`,
   * `export`) sont réservées aux titulaires du menu Tableaux de bord, comme l'agencement.
   */
  test('SOC-87 sans le menu /dashboards, synthèse, cibles et export sont refusés (403)', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = await createRestrictedUser(api, uniq, ['/search']);
    const c = await apiAs(u.username, u.password);

    expect((await c.raw.post(OVERVIEW_PATH, {})).status()).toBe(403);
    expect((await c.raw.post('/analytics/targets', {})).status()).toBe(403);
    expect((await c.raw.post(EXPORT_PATH, { format: 'csv' })).status()).toBe(403);

    // Le menu rendu, les mêmes appels passent avec le même jeton.
    await setRoleMenus(api, u.roleId, ['/search', MENU_DASHBOARDS]);
    expect((await c.raw.post(OVERVIEW_PATH, {})).status()).toBe(200);
    expect((await c.raw.post('/analytics/targets', {})).status()).toBe(200);
    expect((await c.raw.post(EXPORT_PATH, { format: 'csv' })).status()).toBe(200);
  });
});

test.describe('Synthèse et export', () => {
  test('SOC-88 l’export renvoie un fichier joint du type demandé, cohérent avec les filtres', async ({
    api,
  }) => {
    const filtre = { dateFrom: '2026-01-01', dateTo: '2026-01-31', granularity: 'day' };

    const csv = await api.raw.post(EXPORT_PATH, { ...filtre, format: 'csv' });
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    expect(csv.headers()['content-disposition']).toMatch(/^attachment; filename=".+\.csv"$/);
    const texte = (await csv.body()).toString('utf8');
    expect(texte).toContain('Section');
    expect(texte).toContain('Libellé');

    const xlsx = await api.raw.post(EXPORT_PATH, { ...filtre, format: 'xlsx' });
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    // Classeur OOXML = archive ZIP.
    expect((await xlsx.body()).subarray(0, 2).toString('latin1')).toBe('PK');

    const pdf = await api.raw.post(EXPORT_PATH, { ...filtre, format: 'pdf' });
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toBe('application/pdf');
    expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('SOC-88 synthèse et export refusent proprement (400, jamais 500) un filtre invalide', async ({
    api,
  }) => {
    for (const corps of [
      { format: 'html' },
      { format: 'csv', granularity: 'minute' },
      { format: 'csv', basis: 'updated_at' },
      { format: 'csv', dossierId: -1 },
      // Dates de bonne forme mais INEXISTANTES : provoquaient une 500 (RangeError / cast ::date).
      { format: 'csv', dateFrom: '2026-13-45' },
      { format: 'csv', dateTo: '2026-02-30' },
    ]) {
      expect((await api.raw.post(EXPORT_PATH, corps)).status(), JSON.stringify(corps)).toBe(400);
    }
    for (const corps of [
      { dateFrom: '2026-13-45' },
      { dateFrom: '2026-02-30' },
      { dateTo: '26-1-1' },
    ]) {
      expect((await api.raw.post(OVERVIEW_PATH, corps)).status(), JSON.stringify(corps)).toBe(400);
    }
    expect((await api.raw.post('/analytics/targets', { periodStart: '2026-02-30' })).status()).toBe(
      400,
    );

    // Témoin : une date valide passe.
    const ok = await api.raw.post(OVERVIEW_PATH, { dateFrom: '2024-02-29', dateTo: '2024-03-01' });
    expect(ok.status()).toBe(200);
    expect(((await ok.json()) as { period: { from: string } }).period.from).toBe('2024-02-29');
  });
});
