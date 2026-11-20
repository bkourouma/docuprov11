import * as Y from 'yjs';
import {
  findMissingDependency,
  hasPendingUpdates,
  purgePendingUpdates,
  stateVectorOf,
} from './collab-update-guard';

function recordUpdates(doc: Y.Doc): Uint8Array[] {
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  return updates;
}

describe('findMissingDependency', () => {
  it('accepte une mise à jour contiguë, un doublon et un recouvrement', () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    const updates = recordUpdates(client);
    client.getText('t').insert(0, 'abc');
    client.getText('t').insert(3, 'def');
    expect(findMissingDependency(updates[0], stateVectorOf(server))).toBeNull();
    Y.applyUpdate(server, updates[0]);
    expect(findMissingDependency(updates[1], stateVectorOf(server))).toBeNull();
    expect(findMissingDependency(updates[0], stateVectorOf(server))).toBeNull(); // déjà connue
    // Sync step 2 complète (tout l'état) : recouvre ce que le serveur a déjà.
    expect(findMissingDependency(Y.encodeStateAsUpdate(client), stateVectorOf(server))).toBeNull();
  });

  it('accepte une step 2 multi-clients qui apporte elle-même ses dépendances', () => {
    const a = new Y.Doc();
    a.getText('t').insert(0, 'xyz');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getText('t').insert(1, '!');
    b.getText('t').delete(0, 1);
    expect(findMissingDependency(Y.encodeStateAsUpdate(b), new Map())).toBeNull();
  });

  it('refuse la 2e modification d’un client envoyée sans la 1re (trou d’horloge)', () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    const updates = recordUpdates(client);
    client.getText('t').insert(0, 'abc');
    client.getText('t').insert(3, 'def');
    expect(findMissingDependency(updates[1], stateVectorOf(server))).toMatch(/dépendances manquantes/);
  });

  it('refuse une mise à jour fusionnée lacunaire (structures sautées)', () => {
    const client = new Y.Doc();
    const updates = recordUpdates(client);
    client.getText('t').insert(0, 'a');
    client.getText('t').insert(1, 'b');
    client.getText('t').insert(2, 'c');
    const merged = Y.mergeUpdates([updates[0], updates[2]]);
    expect(findMissingDependency(merged, new Map())).toMatch(/lacunaire|non contiguës/);
  });

  it('refuse une référence (origine) à un élément d’un client inconnu', () => {
    const foreign = new Y.Doc();
    foreign.getText('t').insert(0, 'xyz');
    const forger = new Y.Doc();
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(foreign));
    const updates = recordUpdates(forger);
    forger.getText('t').insert(1, '!');
    expect(findMissingDependency(updates[0], new Map())).toMatch(/élément inconnu/);
    // Le même élément est accepté si le serveur connaît le client référencé.
    expect(findMissingDependency(updates[0], stateVectorOf(foreign))).toBeNull();
  });

  it('refuse un parent inconnu (élément imbriqué dans un type inconnu)', () => {
    const foreign = new Y.Doc();
    const inner = new Y.Map<unknown>();
    foreign.getMap('m').set('k', inner);
    const forger = new Y.Doc();
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(foreign));
    const updates = recordUpdates(forger);
    (forger.getMap('m').get('k') as Y.Map<unknown>).set('x', 1);
    expect(findMissingDependency(updates[0], new Map())).toMatch(/élément inconnu/);
  });

  it('refuse la suppression de contenu inconnu', () => {
    const foreign = new Y.Doc();
    foreign.getText('t').insert(0, 'xyz');
    const forger = new Y.Doc();
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(foreign));
    const updates = recordUpdates(forger);
    forger.getText('t').delete(1, 1);
    expect(findMissingDependency(updates[0], new Map())).toMatch(/suppression de contenu inconnu/);
    expect(findMissingDependency(updates[0], stateVectorOf(foreign))).toBeNull();
  });

  it('signale une mise à jour illisible sans jeter', () => {
    expect(findMissingDependency(Uint8Array.from([9, 9, 9, 9, 9]), new Map())).toMatch(/malformée/);
  });

  it('cohérence avec Yjs : ce qui est accepté ne laisse jamais de structures en attente', () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    const updates = recordUpdates(client);
    for (let i = 0; i < 20; i += 1) client.getText('t').insert(i % 3, String(i));
    client.getText('t').delete(2, 5);
    for (const u of updates) {
      const verdict = findMissingDependency(u, stateVectorOf(server));
      if (verdict === null) {
        Y.applyUpdate(server, u);
        expect(hasPendingUpdates(server)).toBe(false);
      }
    }
    expect(server.getText('t').toString()).toBe(client.getText('t').toString());
  });
});

describe('purgePendingUpdates', () => {
  it('écarte les structures en attente sans toucher au contenu intégré', () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    const updates = recordUpdates(client);
    client.getText('t').insert(0, 'abc');
    client.getText('t').insert(3, 'def');
    server.getText('t').insert(0, 'ok');
    Y.applyUpdate(server, updates[1]);
    expect(hasPendingUpdates(server)).toBe(true);
    expect(purgePendingUpdates(server)).toBe(true);
    expect(hasPendingUpdates(server)).toBe(false);
    expect(purgePendingUpdates(server)).toBe(false);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(server));
    expect(copy.getText('t').toString()).toBe('ok');
    expect(hasPendingUpdates(copy)).toBe(false);
  });
});
