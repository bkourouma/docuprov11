/**
 * Redis de la pile E2E : conteneur partagé `docupro-e2e-redis` (127.0.0.1:6399), une base logique
 * par pile (`E2E_REDIS_URL=redis://127.0.0.1:6399/<n>`). On ne vide jamais que SA base (FLUSHDB),
 * jamais tout le serveur.
 */
import IORedis from 'ioredis';
import { REDIS_CONTAINER, REDIS_IMAGE, REDIS_URL } from '../env';
import { capture, sleep } from './proc';

async function ping(): Promise<boolean> {
  const client = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 2000, retryStrategy: () => null });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

function isSharedContainerUrl(): boolean {
  const u = new URL(REDIS_URL);
  return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === '6399';
}

/** Vérifie que Redis répond ; démarre (ou crée) le conteneur partagé s'il le faut. */
export async function ensureRedis(): Promise<void> {
  if (await ping()) return;
  if (!isSharedContainerUrl()) {
    throw new Error(`[e2e] Redis ne répond pas sur E2E_REDIS_URL=${REDIS_URL}`);
  }
  const inspect = capture('docker', ['inspect', '-f', '{{.State.Running}}', REDIS_CONTAINER]);
  const res =
    inspect.status === 0
      ? capture('docker', ['start', REDIS_CONTAINER])
      : capture('docker', [
          'run', '-d', '--name', REDIS_CONTAINER, '--restart', 'unless-stopped',
          '-p', '127.0.0.1:6399:6379', REDIS_IMAGE,
          'redis-server', '--save', '', '--appendonly', 'no', '--databases', '16',
        ]);
  if (res.status !== 0) {
    throw new Error(`[e2e] impossible de démarrer ${REDIS_CONTAINER} : ${res.stderr.trim()} (Docker Desktop démarré ?)`);
  }
  for (let i = 0; i < 40; i++) {
    if (await ping()) return;
    await sleep(250);
  }
  throw new Error(`[e2e] ${REDIS_CONTAINER} ne répond pas sur ${REDIS_URL}`);
}

/** Vide la base logique de la pile (files BullMQ, verrous, compteurs). */
export async function flushStackRedisDb(): Promise<void> {
  const client = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1 });
  try {
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}
