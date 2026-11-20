import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDITOR_LIMITS } from '@archivage/editor';
import { WorkingStateStore, safeDocumentId } from './collab-working-state';
import { KeyedMutex } from './keyed-mutex';

describe('safeDocumentId', () => {
  it('accepte un entier positif et le renvoie en décimal', () => {
    expect(safeDocumentId(42)).toBe('42');
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, 2_147_483_648, '1', '../1', null, undefined, {}])(
    'refuse %p',
    (bad) => {
      expect(() => safeDocumentId(bad as number)).toThrow('Identifiant de document invalide');
    },
  );
});

describe('WorkingStateStore', () => {
  let root: string;
  let store: WorkingStateStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'collab-state-'));
    store = new WorkingStateStore(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('écrit puis relit un état avec sa version de base', async () => {
    await store.write(7, Uint8Array.from([1, 2, 3]), 12);
    const read = await store.read(7);
    expect(read?.baseVersionId).toBe(12);
    expect([...(read?.state ?? [])]).toEqual([1, 2, 3]);
  });

  it("écrit sous ARCHIVES/collab et ne laisse aucun fichier temporaire", async () => {
    await store.write(7, Uint8Array.from([9]), 1);
    const files = (await readdir(join(root, 'collab'))).sort();
    expect(files).toEqual(['7.bin', '7.json']);
  });

  it('remplace atomiquement un état existant', async () => {
    await store.write(7, Uint8Array.from([1]), 1);
    await store.write(7, Uint8Array.from([2, 2]), 2);
    const read = await store.read(7);
    expect(read?.baseVersionId).toBe(2);
    expect(read?.state.length).toBe(2);
  });

  it('renvoie null quand rien n’est stocké', async () => {
    expect(await store.read(99)).toBeNull();
  });

  it('ignore un couple incohérent (binaire altéré après coup)', async () => {
    await store.write(7, Uint8Array.from([1, 2, 3]), 1);
    await writeFile(join(root, 'collab', '7.bin'), Buffer.from([9, 9, 9]));
    expect(await store.read(7)).toBeNull();
  });

  it('ignore des métadonnées illisibles ou invalides', async () => {
    await store.write(7, Uint8Array.from([1]), 1);
    await writeFile(join(root, 'collab', '7.json'), '{pas du json');
    expect(await store.read(7)).toBeNull();
    await writeFile(join(root, 'collab', '7.json'), JSON.stringify({ baseVersionId: 'x' }));
    expect(await store.read(7)).toBeNull();
  });

  it('refuse d’écrire un état trop gros', async () => {
    const big = new Uint8Array(EDITOR_LIMITS.MAX_STATE_BYTES + 1);
    await expect(store.write(7, big, 1)).rejects.toThrow('trop volumineux');
  });

  it('refuse une version de base invalide', async () => {
    await expect(store.write(7, Uint8Array.from([1]), 0)).rejects.toThrow('Version de base invalide');
  });

  it('ne permet aucune traversée de chemin : identifiant non entier refusé partout', async () => {
    const evil = '../../etc/passwd' as unknown as number;
    await expect(store.write(evil, Uint8Array.from([1]), 1)).rejects.toThrow();
    await expect(store.read(evil)).rejects.toThrow();
    await expect(store.remove(evil)).rejects.toThrow();
  });

  it('supprime les deux fichiers, sans erreur si absents', async () => {
    await store.write(7, Uint8Array.from([1]), 1);
    await store.remove(7);
    expect(await readdir(join(root, 'collab'))).toEqual([]);
    await expect(store.remove(7)).resolves.toBeUndefined();
  });
});

describe('KeyedMutex', () => {
  it('sérialise les tâches d’une même clé et libère la clé après un échec', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const a = mutex.run(1, async () => {
      order.push('a:début');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a:fin');
      throw new Error('boom');
    });
    const b = mutex.run(1, async () => {
      order.push('b');
      return 'ok';
    });
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('ok');
    expect(order).toEqual(['a:début', 'a:fin', 'b']);
  });
});
