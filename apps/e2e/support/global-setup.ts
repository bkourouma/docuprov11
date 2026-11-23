/**
 * Global setup Playwright : monte (ou réutilise) la pile, rend l'administrateur utilisable,
 * écrit son storageState, puis exécute les seeds de module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prepareAdmin } from './admin';
import { CONNECTOR_FS_ROOT, STACK_DIR } from './env';
import { runModuleSeeds } from './module-seeds';
import { stackUp } from './stack';
import { ARCHIVES_DIR } from './stack/services';
import { step } from './stack/proc';

/** Marqueur lu par le teardown : la pile a été montée par CE lancement (donc à arrêter). */
export const STARTED_MARKER = path.join(STACK_DIR, 'started-by-setup');

export default async function globalSetup(): Promise<void> {
  const { reused } = await stackUp();
  if (reused) {
    fs.rmSync(STARTED_MARKER, { force: true });
  } else {
    fs.writeFileSync(STARTED_MARKER, String(process.pid));
  }
  // Hérité par les workers Playwright (forkés après le global setup).
  process.env.E2E_WORKER = '1'; // le worker BullMQ de la pile tourne (vérifié par stackUp)
  process.env.E2E_CONNECTOR_FS_ROOT = CONNECTOR_FS_ROOT;
  process.env.E2E_ARCHIVES_PATH = ARCHIVES_DIR; // coffre ARCHIVES de la pile (ARCHIVES_PATH de l'API)
  fs.mkdirSync(CONNECTOR_FS_ROOT, { recursive: true });
  const done = step('administrateur et storageState');
  const token = await prepareAdmin();
  done();
  await runModuleSeeds(token);
}
