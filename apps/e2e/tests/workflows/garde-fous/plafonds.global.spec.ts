// Docu-Flow : arrêt d'urgence GLOBAL des agents (scénario WF-78).
//
// État global de la pile : ce fichier est exécuté seul, après le projet principal (projet `etat-global`, un
// worker). Il remet l'arrêt global dans l'état trouvé au départ, même en cas d'échec.

import { test, expect } from '../../../fixtures';
import { getBudget, setEmergencyStop } from '../_helpers/agents';

test.describe('Docu-Flow : arrêt d’urgence global', () => {
  test('WF-78 Activer puis lever l’arrêt d’urgence global depuis l’écran', async ({ page, api, uniq }) => {
    const initial = (await getBudget(api)).global;
    const reason = uniq('Arret global WF-78');
    try {
      if (initial.emergencyStop) await setEmergencyStop(api, null, false);

      const loaded = page.waitForResponse((r) => r.url().endsWith('/api/workflows/agents/budget') && r.request().method() === 'GET');
      await page.goto('/workflows/administration/plafonds');
      await loaded;
      await expect(page.getByText('Arrêt global : inactif')).toBeVisible();

      const global = page.getByRole('article', { name: 'Plafond global', exact: true });
      await global.getByRole('button', { name: 'Arrêt d’urgence', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Activer l’arrêt d’urgence' });
      await expect(dialog.getByText('Tous les workflows (arrêt global)')).toBeVisible();
      await dialog.getByLabel(/^Motif \(recommandé, 500 caractères au plus\)$/).fill(reason);
      await dialog.getByLabel('Pour confirmer, saisissez le mot « ARRÊT »').fill('ARRÊT');
      const stopped = page.waitForResponse((r) => r.url().endsWith('/api/workflows/agents/emergency-stop'));
      await dialog.getByRole('button', { name: 'Activer l’arrêt d’urgence' }).click();
      expect((await stopped).status()).toBe(200);

      await expect(page.getByText('Arrêt d’urgence activé. Portée : Tous les workflows (arrêt global).')).toBeVisible();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Arrêt d’urgence global actif : aucun agent ne fonctionne.' }),
      ).toBeVisible();
      await expect(page.getByText('Arrêt global : actif')).toBeVisible();
      let budget = (await getBudget(api)).global;
      expect(budget.emergencyStop).toBe(true);
      expect(budget.emergencyStopReason).toBe(reason);
      const status = await api.get<{ emergencyStopGlobal: boolean }>('/workflows/agents/status');
      expect(status.emergencyStopGlobal).toBe(true);

      await global.getByRole('button', { name: 'Lever l’arrêt d’urgence' }).click();
      const lift = page.getByRole('dialog', { name: 'Lever l’arrêt d’urgence' });
      const lifted = page.waitForResponse((r) => r.url().endsWith('/api/workflows/agents/emergency-stop'));
      await lift.getByRole('button', { name: 'Lever l’arrêt d’urgence' }).click();
      expect((await lifted).status()).toBe(200);
      await expect(
        page.getByText('Arrêt d’urgence levé. Portée : Tous les workflows (arrêt global). Les agents reprennent.'),
      ).toBeVisible();
      await expect(page.getByText('Arrêt global : inactif')).toBeVisible();
      budget = (await getBudget(api)).global;
      expect(budget.emergencyStop).toBe(false);
    } finally {
      const now = (await getBudget(api)).global;
      if (now.emergencyStop !== initial.emergencyStop) {
        await setEmergencyStop(api, null, initial.emergencyStop, initial.emergencyStopReason ?? undefined);
      }
    }
  });
});
