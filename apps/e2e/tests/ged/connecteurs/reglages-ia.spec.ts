/**
 * GED-58 et GED-59 — Réglages et socle IA (`/ged/ai/*`, administrateurs seulement ; aucun écran web).
 *
 * Le paramétrage IA est GLOBAL (ligne unique `ged_ai_setting`) : les tests de ce fichier s'exécutent
 * en série, ne modifient que des champs sans effet en mode 0 et RESTAURENT l'état initial
 * (`withAiSettingsRestored`). L'IA n'est jamais activée.
 * Prérequis de pile : ni `GED_AI_API_KEY` ni `OPENAI_API_KEY` dans l'environnement de l'API.
 */
import { test, expect } from '../../../fixtures';
import { createRestrictedUser } from '../_helpers/users';
import {
  AI_DISABLED_MESSAGE,
  AI_SETTINGS_VIEW_KEYS,
  MISSING_ID,
  asT4,
  asT4As,
  errorText,
  expectAiDisabled,
  getAiSettings,
  withAiSettingsRestored,
  type AiSettingsView,
} from '../_helpers/ia';

test.describe.configure({ mode: 'serial' });

const ADMIN_ONLY = 'Réservé aux administrateurs';

test.describe('Réglages IA — lecture et validation', () => {
  test('GED-58 lecture des réglages : vue complète, IA désactivée, aucune valeur de clé', async ({ api }) => {
    const admin = asT4(api);
    await expectAiDisabled(admin);
    const view = await getAiSettings(admin);
    expect(Object.keys(view).sort()).toEqual([...AI_SETTINGS_VIEW_KEYS].sort());
    expect(view.mode).toBe(0);
    expect(view.embeddingDimension).toBe(1024);
    expect(typeof view.maskingEnabled).toBe('boolean');
    expect(typeof view.apiKeyConfigured).toBe('boolean');
    expect(Number.isInteger(view.timeoutSeconds)).toBe(true);
    // La référence de clé est un NOM de variable (ou rien), jamais une valeur.
    if (view.apiKeyRef !== null) expect(view.apiKeyRef).toMatch(/^(OPENAI_API_KEY|GED_AI_[A-Z0-9][A-Z0-9_]*)$/);
  });

  test('GED-58 saisies invalides refusées (400), rien n’est écrit, aucun secret renvoyé', async ({ api }) => {
    const admin = asT4(api);
    const before = await getAiSettings(admin);
    const secret = 'MotDePasse-E2E-ne-pas-renvoyer-77';
    const cases: Array<[string, unknown, RegExp | null]> = [
      ['cloud sans masquage', { mode: 2, maskingEnabled: false }, /masquage des données est obligatoire en mode cloud/],
      ['référence de clé hors liste blanche', { apiKeyRef: 'JWT_SECRET' }, /Référence de clé invalide/],
      ['clé saisie à la place de sa référence', { apiKeyRef: `sk-${secret}` }, /Référence de clé invalide/],
      ['dimension d’embedding modifiée', { embeddingDimension: 512 }, /fixée à 1024/],
      ['délai nul', { timeoutSeconds: 0 }, null],
      ['délai trop long', { timeoutSeconds: 601 }, null],
      ['seuil hors 0..1', { autoApplyThreshold: 1.5 }, null],
      ['mode local sans endpoint', { mode: 1, endpoint: null }, /mode local exige l'endpoint/],
      ['endpoint non http', { endpoint: 'ftp://exemple.invalid/v1' }, /http ou https/],
      ['endpoint avec identifiants', { endpoint: `https://e2e:${secret}@exemple.invalid/v1` }, /ne doit pas contenir d'identifiants/],
      ['mode inconnu', { mode: 3 }, null],
      ['champ inconnu', { apiKey: secret }, null],
    ];
    for (const [label, body, pattern] of cases) {
      const res = await admin.raw.put('/ged/ai/settings', body);
      const text = await errorText(res);
      expect(res.status(), `${label} : ${text}`).toBe(400);
      if (pattern) expect(text, label).toMatch(pattern);
      expect(text, `${label} : aucun secret renvoyé`).not.toContain(secret);
    }
    // Aucune écriture : la vue est strictement identique (updatedAt compris).
    expect(await getAiSettings(admin)).toEqual(before);
    await expectAiDisabled(admin);
  });

  test('GED-58 mise à jour partielle valide puis restauration de l’état initial', async ({ api }) => {
    const admin = asT4(api);
    await expectAiDisabled(admin);
    let initial!: AiSettingsView;
    await withAiSettingsRestored(admin, async (start) => {
      initial = start;
      const timeoutSeconds = start.timeoutSeconds === 61 ? 62 : 61;
      const updated = await admin.put<AiSettingsView>('/ged/ai/settings', {
        apiKeyRef: 'GED_AI_E2E_ABSENTE',
        timeoutSeconds,
      });
      expect(Object.keys(updated).sort()).toEqual([...AI_SETTINGS_VIEW_KEYS].sort());
      expect(updated).toMatchObject({
        mode: 0,
        apiKeyRef: 'GED_AI_E2E_ABSENTE',
        timeoutSeconds,
        // La variable référencée n'existe pas (et ni GED_AI_API_KEY ni OPENAI_API_KEY sur la pile).
        apiKeyConfigured: false,
      });
      expect(typeof updated.updatedBy).toBe('number');
      expect(updated.updatedAt).not.toBeNull();
      // Champ absent = inchangé : le masquage et le fournisseur ne bougent pas.
      expect(updated.maskingEnabled).toBe(start.maskingEnabled);
      expect(updated.provider).toBe(start.provider);
      // L'IA reste désactivée : la recherche IA et la gouvernance ne sont pas affectées.
      await expectAiDisabled(admin);
    });
    const restored = await getAiSettings(admin);
    expect(restored.apiKeyRef).toBe(initial.apiKeyRef);
    expect(restored.timeoutSeconds).toBe(initial.timeoutSeconds);
    expect(restored.mode).toBe(0);
  });
});

test.describe('Socle IA — état désactivé et droits', () => {
  test('GED-59 IA désactivée : statut, analyse d’un document et journal des décisions', async ({ api }) => {
    const admin = asT4(api);
    expect(await admin.get('/ged/ai/status')).toEqual({ enabled: false, mode: 0, message: AI_DISABLED_MESSAGE });

    // Analyse : réponse explicite (200), rien n'est mis en file.
    expect(await admin.post('/ged/ai/documents/1/analyze', {})).toEqual({ disabled: true, message: AI_DISABLED_MESSAGE });
    for (const id of ['0', 'abc', '2147483648']) {
      expect((await admin.raw.post(`/ged/ai/documents/${id}/analyze`, {})).status(), id).toBe(400);
    }

    const page = await admin.get<{ items: unknown[]; total: number; page: number; pageSize: number }>(
      '/ged/ai/decisions?page=1&pageSize=5',
    );
    expect(Array.isArray(page.items)).toBe(true);
    expect(page.items.length).toBeLessThanOrEqual(5);
    expect(page).toMatchObject({ page: 1, pageSize: 5 });
    for (const q of ['status=9', 'task=8', 'pageSize=101', 'page=0', 'documentId=', 'status=abc']) {
      expect((await admin.raw.get(`/ged/ai/decisions?${q}`)).status(), q).toBe(400);
    }
    const missing = await admin.raw.get(`/ged/ai/decisions/${MISSING_ID}`);
    expect(missing.status()).toBe(404);
    expect(await errorText(missing)).toBe('Décision IA introuvable');
    for (const action of ['validate', 'reject']) {
      expect((await admin.raw.post(`/ged/ai/decisions/${MISSING_ID}/${action}`, {})).status(), action).toBe(404);
      expect((await admin.raw.post(`/ged/ai/decisions/0/${action}`, {})).status(), action).toBe(400);
    }
    expect(Array.isArray(await admin.get('/ged/ai/masking-rules'))).toBe(true);
  });

  test('GED-59 non administrateur : tout le socle IA est refusé (403), même avec des menus GED', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const user = await createRestrictedUser(asT4(api), asT4As(apiAs), uniq('ia-non-admin'), [
      '/recherche-ia',
      '/gouvernance',
    ]);
    const self = await asT4As(apiAs)(user.username, user.password);
    const calls: Array<['GET' | 'PUT' | 'POST', string, unknown?]> = [
      ['GET', '/ged/ai/settings'],
      ['PUT', '/ged/ai/settings', { timeoutSeconds: 30 }],
      ['GET', '/ged/ai/status'],
      ['GET', '/ged/ai/masking-rules'],
      ['GET', '/ged/ai/decisions'],
      ['GET', `/ged/ai/decisions/${MISSING_ID}`],
      ['POST', `/ged/ai/decisions/${MISSING_ID}/validate`, {}],
      ['POST', '/ged/ai/documents/1/analyze', {}],
    ];
    const before = await getAiSettings(asT4(api));
    for (const [method, path, body] of calls) {
      const res =
        method === 'GET' ? await self.raw.get(path) : method === 'PUT' ? await self.raw.put(path, body) : await self.raw.post(path, body);
      expect(res.status(), `${method} ${path}`).toBe(403);
      expect(await errorText(res)).toBe(ADMIN_ONLY);
    }
    expect(await getAiSettings(asT4(api))).toEqual(before);
  });
});
