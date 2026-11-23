// Docu-Flow : création depuis un modèle du catalogue et en langage naturel SANS IA (scénarios WF-23 et WF-24).
//
// Aucun fournisseur IA en E2E : la génération en langage naturel doit être refusée proprement (HTTP 409
// « IA désactivée pour ce client », message français dans la modale) sans créer de brouillon. Les modèles du
// catalogue, eux, n'appellent pas l'IA : ils créent un brouillon (jamais publié).

import { test, expect } from '../../../fixtures';
import { WF_DEFINITION_STATUS, archiveDefinition, type WfDefinitionDto } from '../_helpers/wf-api';

const CHECKLIST_TEMPLATE = 'Demande avec liste de vérification';

test.describe('Docu-Flow : modèles et langage naturel', () => {
  test('WF-23 Créer un brouillon depuis le modèle « Demande avec liste de vérification »', async ({ page, api }) => {
    const before = new Set((await api.get<WfDefinitionDto[]>('/workflows/definitions')).map((d) => d.wfDefinitionId));
    const templatesLoaded = page.waitForResponse((r) => r.url().endsWith('/api/workflows/templates'));
    await page.goto('/workflows/conception');
    await templatesLoaded;
    await page.getByRole('button', { name: 'Depuis un modèle' }).click();
    const modal = page.getByRole('dialog', { name: 'Créer un brouillon depuis un modèle' });
    await expect(modal.getByText('Le modèle crée un brouillon que vous pouvez modifier : rien n’est publié.')).toBeVisible();

    const instantiated = page.waitForResponse((r) => /\/api\/workflows\/templates\/[^/]+\/instantiate$/.test(r.url()));
    await modal.getByRole('button', { name: `Créer un brouillon à partir du modèle ${CHECKLIST_TEMPLATE}` }).click();
    expect((await instantiated).status()).toBeLessThan(300);
    await expect(page).toHaveURL(/\/workflows\/conception\/\d+$/);
    const id = Number(page.url().split('/').pop());
    try {
      expect(before.has(id)).toBe(false);
      await expect(page.getByRole('toolbar', { name: 'Actions de l’éditeur' })).toBeVisible();
      const created = (await api.get<WfDefinitionDto[]>('/workflows/definitions')).find((d) => d.wfDefinitionId === id);
      expect(created?.status).toBe(WF_DEFINITION_STATUS.draft);
      expect(created?.name.startsWith(CHECKLIST_TEMPLATE)).toBe(true);
    } finally {
      // Le nom du modèle est fixe : on archive pour ne pas épuiser les suffixes « (n) » d'une exécution à l'autre.
      await archiveDefinition(api, id);
    }
  });

  test('WF-24 « Décrire le besoin » sans IA : refus propre, aucun brouillon créé', async ({ page, api }) => {
    // D'autres specs créent des définitions en parallèle : on compte seulement les brouillons issus du langage
    // naturel (wf_definition.source = 1, WfDefinitionSource.NaturalLanguage), que seule la génération crée.
    const naturalLanguageDrafts = async () =>
      (await api.get<Array<WfDefinitionDto & { source: number }>>('/workflows/definitions')).filter((d) => d.source === 1).length;
    const before = await naturalLanguageDrafts();
    await page.goto('/workflows/conception');
    await page.getByRole('button', { name: 'Décrire le besoin' }).click();
    const modal = page.getByRole('dialog', { name: 'Décrire le besoin' });
    await modal
      .getByLabel('Décrivez en français le workflow souhaité')
      .fill('Quand un courrier arrive, le secrétariat le vérifie puis le directeur valide au-delà de 1000 euros.');
    const refused = page.waitForResponse((r) => r.url().endsWith('/api/workflows/authoring/generate'));
    await modal.getByRole('button', { name: 'Générer le brouillon' }).click();
    expect((await refused).status()).toBe(409);
    await expect(
      modal.getByText('L’IA est désactivée pour ce client : décrivez le besoin dans l’éditeur ou créez le workflow à la main.'),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/workflows\/conception$/);
    expect(await naturalLanguageDrafts()).toBe(before);

    // Même refus côté API (pas d'erreur 500, aucun appel au modèle).
    const raw = await api.raw.post('/workflows/authoring/generate', { description: 'Un circuit de validation simple.' });
    expect(raw.status()).toBe(409);
    expect(await naturalLanguageDrafts()).toBe(before);
  });
});
