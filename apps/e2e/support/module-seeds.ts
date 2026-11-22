/**
 * Seeds de module : `tests/<module>/_helpers/global-seed.ts`, découverts et exécutés par le global
 * setup après les migrations, le seed de base et la préparation de l'administrateur.
 *
 *   import type { GlobalSeedContext } from '../../../support';
 *   export default async function seed({ api }: GlobalSeedContext): Promise<void> { … }
 *
 * Chaque seed DOIT être idempotent : sur une pile gardée montée, il est rejoué à chaque lancement
 * sans que la base soit recréée.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ApiClient } from './api-client';
import { createApiClient } from './api-client';
import { E2E_ROOT } from './env';
import { step } from './stack/proc';

export interface GlobalSeedContext {
  /** Client REST administrateur. */
  api: ApiClient;
}

export type GlobalSeed = (ctx: GlobalSeedContext) => Promise<void>;

/** Chemins des seeds de module présents, triés par nom de module. */
export function discoverModuleSeeds(): string[] {
  const testsDir = path.join(E2E_ROOT, 'tests');
  if (!fs.existsSync(testsDir)) return [];
  return fs
    .readdirSync(testsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(testsDir, d.name, '_helpers', 'global-seed.ts'))
    .filter((file) => fs.existsSync(file))
    .sort();
}

export async function runModuleSeeds(adminToken: string): Promise<void> {
  const files = discoverModuleSeeds();
  if (files.length === 0) return;
  const api = await createApiClient({ token: adminToken });
  try {
    for (const file of files) {
      const moduleName = path.basename(path.dirname(path.dirname(file)));
      const done = step(`seed du module ${moduleName}`);
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- chargé par le transpileur de Playwright
      const mod = require(file) as { default?: GlobalSeed };
      if (typeof mod.default !== 'function') {
        throw new Error(`[e2e] ${file} doit exporter par défaut une fonction async seed({ api })`);
      }
      try {
        await mod.default({ api });
      } catch (err) {
        throw new Error(`[e2e] le seed du module « ${moduleName} » a échoué (${file}) : ${(err as Error).stack ?? err}`);
      }
      done();
    }
  } finally {
    await api.dispose();
  }
}
