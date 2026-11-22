/**
 * Global teardown Playwright : arrête la pile seulement si le global setup l'a montée lui-même
 * (une pile montée par `pnpm e2e:up` reste en place) et si E2E_KEEP_STACK n'est pas à 1.
 */
import fs from 'node:fs';
import { STARTED_MARKER } from './global-setup';
import { stackDown } from './stack';

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(STARTED_MARKER)) return;
  fs.rmSync(STARTED_MARKER, { force: true });
  if (process.env.E2E_KEEP_STACK === '1') {
    console.log('[e2e] E2E_KEEP_STACK=1 : pile laissée montée (pnpm e2e:down pour l\'arrêter)');
    return;
  }
  await stackDown();
}
