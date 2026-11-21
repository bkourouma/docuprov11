import { randomUUID } from 'node:crypto';
import {
  COMMENTS_KEY,
  EDITOR_FRAGMENT,
  MENTION_NODE_NAME,
  addComment,
  addReply,
  listComments,
  setCommentResolved,
} from '@archivage/editor';
import * as Y from 'yjs';
import {
  MentionTracker,
  SERVER_FIX_ORIGIN,
  installCommentIdentityGuard,
  type CollabIdentity,
} from './collab-room-identity';

const ALICE = { origin: { who: 'alice' }, identity: { userGroupId: 11, name: 'Alice Martin' } };
const BOB = { origin: { who: 'bob' }, identity: { userGroupId: 22, name: 'Bob Diallo' } };

function identityOf(origin: unknown): CollabIdentity | null {
  if (origin === ALICE.origin) return ALICE.identity;
  if (origin === BOB.origin) return BOB.identity;
  return null;
}

/** Applique `change` à une copie « client », puis rejoue sa mise à jour sur `doc` avec `origin`. */
function fromClient(doc: Y.Doc, origin: object, change: (client: Y.Doc) => void): void {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(client);
  change(client);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(client, before), origin);
}

function insertMention(doc: Y.Doc, id: number): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(EDITOR_FRAGMENT);
    const paragraph = new Y.XmlElement('paragraph');
    fragment.insert(fragment.length, [paragraph]);
    const mention = new Y.XmlElement(MENTION_NODE_NAME);
    paragraph.insert(0, [mention]);
    mention.setAttribute('id', String(id));
  });
}

describe('MentionTracker', () => {
  function tracked(doc: Y.Doc) {
    const tracker = new MentionTracker(doc);
    const seen: Array<{ origin: unknown; ids: number[] }> = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      const ids = tracker.added(tr);
      if (ids.length > 0) seen.push({ origin: tr.origin, ids });
    });
    return { tracker, seen };
  }

  it('attribue chaque mention à la transaction qui l’introduit', () => {
    const doc = new Y.Doc();
    insertMention(doc, 5); // déjà présente avant le suivi
    const { seen } = tracked(doc);
    fromClient(doc, ALICE.origin, (c) => insertMention(c, 7));
    fromClient(doc, BOB.origin, (c) =>
      addComment(c, { id: randomUUID(), authorUserGroupId: 22, authorName: 'B', body: 'b', anchorText: '', mentions: [8, 5] }),
    );
    expect(seen).toEqual([
      { origin: ALICE.origin, ids: [7] },
      { origin: BOB.origin, ids: [8] },
    ]);
  });

  it('mention retirée puis réintroduite par un autre : attribuée au second', () => {
    const doc = new Y.Doc();
    const { seen } = tracked(doc);
    fromClient(doc, ALICE.origin, (c) => insertMention(c, 7));
    fromClient(doc, ALICE.origin, (c) => c.getXmlFragment(EDITOR_FRAGMENT).delete(0, 1));
    fromClient(doc, BOB.origin, (c) => insertMention(c, 7));
    expect(seen).toEqual([
      { origin: ALICE.origin, ids: [7] },
      { origin: BOB.origin, ids: [7] },
    ]);
  });

  it('attribut `id` d’une mention existante modifié : nouvelle mention attribuée', () => {
    const doc = new Y.Doc();
    insertMention(doc, 7);
    const { seen } = tracked(doc);
    fromClient(doc, BOB.origin, (c) => {
      const paragraph = c.getXmlFragment(EDITOR_FRAGMENT).get(0) as Y.XmlElement;
      (paragraph.get(0) as Y.XmlElement).setAttribute('id', '9');
    });
    expect(seen).toEqual([{ origin: BOB.origin, ids: [9] }]);
  });

  it('coût borné : la frappe de texte ne déclenche aucun recalcul complet', () => {
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [paragraph]);
    paragraph.insert(0, [text]);
    const { tracker } = tracked(doc);
    for (const ch of 'du texte tapé lettre à lettre') text.insert(text.length, ch, {});
    text.delete(0, 3);
    doc.getText('autre-racine').insert(0, 'x');
    expect(tracker.fullScans).toBe(0);
    insertMention(doc, 3);
    expect(tracker.fullScans).toBe(1);
  });
});

describe('installCommentIdentityGuard', () => {
  function guarded(): Y.Doc {
    const doc = new Y.Doc();
    installCommentIdentityGuard(doc, identityOf);
    return doc;
  }

  it('nouveau commentaire et ses réponses : auteur imposé', () => {
    const doc = guarded();
    const id = randomUUID();
    fromClient(doc, BOB.origin, (c) => {
      addComment(c, { id, authorUserGroupId: 11, authorName: 'Alice Martin', body: 'x', anchorText: '', mentions: [] });
      addReply(c, id, { id: randomUUID(), authorUserGroupId: 11, authorName: 'Alice', body: 'r', mentions: [] });
    });
    const [comment] = listComments(doc);
    expect(comment).toMatchObject({ authorUserGroupId: 22, authorName: 'Bob Diallo' });
    expect(comment.replies[0]).toMatchObject({ authorUserGroupId: 22, authorName: 'Bob Diallo' });
  });

  it('commentaire créé déjà résolu : résolveur imposé', () => {
    const doc = guarded();
    fromClient(doc, BOB.origin, (c) => {
      const id = randomUUID();
      addComment(c, { id, authorUserGroupId: 22, authorName: 'Bob Diallo', body: 'x', anchorText: '', mentions: [] });
      setCommentResolved(c, id, true, 'Directeur');
    });
    expect(listComments(doc)[0]).toMatchObject({ resolved: true, resolvedByName: 'Bob Diallo' });
  });

  it('identité d’un commentaire ou d’une réponse existants : immuable', () => {
    const doc = guarded();
    const id = randomUUID();
    fromClient(doc, ALICE.origin, (c) => {
      addComment(c, { id, authorUserGroupId: 11, authorName: 'Alice Martin', body: 'x', anchorText: '', mentions: [] });
      addReply(c, id, { id: randomUUID(), authorUserGroupId: 11, authorName: 'Alice Martin', body: 'r', mentions: [] });
    });
    fromClient(doc, BOB.origin, (c) => {
      const comment = c.getMap<Y.Map<unknown>>(COMMENTS_KEY).get(id)!;
      comment.set('authorName', 'Bob');
      comment.delete('authorUserGroupId');
      const reply = (comment.get('replies') as Y.Array<Y.Map<unknown>>).get(0);
      reply.set('authorUserGroupId', 22);
    });
    const [comment] = listComments(doc);
    expect(comment).toMatchObject({ authorUserGroupId: 11, authorName: 'Alice Martin' });
    expect(comment.replies[0]).toMatchObject({ authorUserGroupId: 11, authorName: 'Alice Martin' });
  });

  it('nom du résolveur modifié seul : rétabli', () => {
    const doc = guarded();
    const id = randomUUID();
    fromClient(doc, ALICE.origin, (c) => {
      addComment(c, { id, authorUserGroupId: 11, authorName: 'Alice Martin', body: 'x', anchorText: '', mentions: [] });
      setCommentResolved(c, id, true, 'Alice Martin');
    });
    fromClient(doc, BOB.origin, (c) => c.getMap<Y.Map<unknown>>(COMMENTS_KEY).get(id)!.set('resolvedByName', 'Bob'));
    expect(listComments(doc)[0].resolvedByName).toBe('Alice Martin');
  });

  it('écritures sans identité (serveur) et corrections : laissées telles quelles, sans boucle', () => {
    const doc = guarded();
    const id = randomUUID();
    addComment(doc, { id, authorUserGroupId: 77, authorName: 'Import', body: 'x', anchorText: '', mentions: [] });
    expect(listComments(doc)[0]).toMatchObject({ authorUserGroupId: 77, authorName: 'Import' });
    let updates = 0;
    doc.on('update', () => (updates += 1));
    doc.transact(() => doc.getMap<Y.Map<unknown>>(COMMENTS_KEY).get(id)!.set('authorName', 'Corrigé'), SERVER_FIX_ORIGIN);
    expect(updates).toBe(1);
    expect(listComments(doc)[0].authorName).toBe('Corrigé');
  });

  it('une exception de la garde ne casse pas la transaction', () => {
    const doc = new Y.Doc();
    const errors: unknown[] = [];
    installCommentIdentityGuard(
      doc,
      () => {
        throw new Error('panne');
      },
      (e) => errors.push(e),
    );
    expect(() =>
      fromClient(doc, BOB.origin, (c) =>
        addComment(c, { id: randomUUID(), authorUserGroupId: 22, authorName: 'B', body: 'x', anchorText: '', mentions: [] }),
      ),
    ).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(listComments(doc)).toHaveLength(1);
  });

  it('se débranche', () => {
    const doc = new Y.Doc();
    const detach = installCommentIdentityGuard(doc, identityOf);
    detach();
    fromClient(doc, BOB.origin, (c) =>
      addComment(c, { id: randomUUID(), authorUserGroupId: 11, authorName: 'Alice', body: 'x', anchorText: '', mentions: [] }),
    );
    expect(listComments(doc)[0].authorName).toBe('Alice');
  });
});
