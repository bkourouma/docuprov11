import { defineConfig, devices } from '@playwright/test';
import { ADMIN_STORAGE_STATE, API_URL, WEB_URL } from './support/env';

const CI = !!process.env.CI;

// URL exposées aux specs (ce fichier est chargé par le runner ET par chaque worker).
process.env.E2E_API_URL = `${API_URL}/api`;
process.env.E2E_BASE_URL = WEB_URL;

/** Specs qui modifient un état global de la pile (arrêt d'urgence, plafond global…). */
const GLOBAL_STATE_SPECS = '**/*.global.spec.ts';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS) || 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: WEB_URL,
    storageState: ADMIN_STORAGE_STATE,
    locale: 'fr-FR',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: GLOBAL_STATE_SPECS },
    {
      // Un seul worker, après le projet principal : ces specs ne tournent jamais en même temps
      // qu'un test qui dépendrait de l'état global qu'elles modifient.
      name: 'etat-global',
      use: { browserName: 'chromium' },
      testMatch: GLOBAL_STATE_SPECS,
      dependencies: ['chromium'],
      fullyParallel: false,
      workers: 1,
    },
  ],
});
