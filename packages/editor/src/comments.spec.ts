import { randomUUID } from 'crypto';
import * as Y from 'yjs';
import {
  COMMENTS_KEY,
  EDITOR_LIMITS,
  addComment,
  addReply,
  extractMentionIds,
  htmlToYDoc,
  listComments,
  setCommentResolved,
  yDocToPlainText,
} from './server';
import * as api from './index';
import * as serveur from './server';

const nouveau = (over: Partial<Parameters<typeof addComment>[1]> = {}) => ({
  id: randomUUID(),
  authorUserGroupId: 7,
  authorName: 'Alice',
  body: 'Un commentaire',
  anchorText: 'extrait',
  mentions: [] as number[],
  ...over,
});

describe('commentaires dans le Y.Doc', () => {
  it('ajoute et liste un commentaire', () => {
    const ydoc = new Y.Doc();
    const input = nouveau({ mentions: [3, 3, 9] });
    const c = addComment(ydoc, input);
    expect(c).toMatchObject({
      id: input.id,
      authorUserGroupId: 7,
      resolved: false,
      resolvedByName: null,
      resolvedAt: null,
      replies: [],
      mentions: [3, 9],
    });
    expect(new Date(c.createdAt).toISOString()).toBe(c.createdAt);
    expect(listComments(ydoc)).toEqual([c]);
    expect(ydoc.getMap(COMMENTS_KEY).size).toBe(1);
  });

  it('tronque anchorText à 300 caractères', () => {
    const ydoc = new Y.Doc();
    const c = addComment(ydoc, nouveau({ anchorText: 'x'.repeat(1000) }));
    expect(c.anchorText).toHaveLength(300);
    expect(listComments(ydoc)[0]?.anchorText).toHaveLength(300);
  });

  it('écrit dans une transaction avec origine « editor »', () => {
    const ydoc = new Y.Doc();
    const origins: unknown[] = [];
    ydoc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    const c = addComment(ydoc, nouveau());
    addReply(ydoc, c.id, { id: randomUUID(), authorUserGroupId: 2, authorName: 'B', body: 'r', mentions: [] });
    setCommentResolved(ydoc, c.id, true, 'B');
    expect(origins).toEqual(['editor', 'editor', 'editor']);
  });

  it('ajoute des réponses', () => {
    const ydoc = new Y.Doc();
    const c = addComment(ydoc, nouveau());
    const r = addReply(ydoc, c.id, { id: randomUUID(), authorUserGroupId: 2, authorName: 'Bob', body: 'Réponse', mentions: [7] });
    expect(r.createdAt).toBeTruthy();
    const lu = listComments(ydoc)[0]!;
    expect(lu.replies).toHaveLength(1);
    expect(lu.replies[0]).toMatchObject({ authorName: 'Bob', body: 'Réponse', mentions: [7] });
  });

  it('résout et rouvre en conservant toujours le commentaire', () => {
    const ydoc = new Y.Doc();
    const c = addComment(ydoc, nouveau());
    setCommentResolved(ydoc, c.id, true, 'Bob');
    let lu = listComments(ydoc)[0]!;
    expect(lu).toMatchObject({ resolved: true, resolvedByName: 'Bob' });
    expect(lu.resolvedAt).toBeTruthy();
    expect(lu.body).toBe('Un commentaire');
    setCommentResolved(ydoc, c.id, false, 'Bob');
    lu = listComments(ydoc)[0]!;
    expect(lu).toMatchObject({ resolved: false, resolvedByName: null, resolvedAt: null });
    expect(listComments(ydoc)).toHaveLength(1);
  });

  it("n'expose aucune fonction de suppression", () => {
    const noms = Object.keys(api).concat(Object.keys(serveur));
    expect(noms.filter((n) => /delete|remove|supprim|destroy|purge/i.test(n))).toEqual([]);
  });

  it('refuse les entrées invalides avec un message français', () => {
    const ydoc = new Y.Doc();
    const cas: Array<[string, Partial<Parameters<typeof addComment>[1]>, RegExp]> = [
      ['id non uuid', { id: 'abc' }, /Identifiant de commentaire invalide/],
      ['auteur non entier', { authorUserGroupId: 1.5 }, /auteur invalide/],
      ['auteur négatif', { authorUserGroupId: -1 }, /auteur invalide/],
      ['auteur zéro', { authorUserGroupId: 0 }, /auteur invalide/],
      ['nom vide', { authorName: '  ' }, /auteur obligatoire/],
      ['corps vide', { body: '   ' }, /vide/],
      ['corps trop long', { body: 'a'.repeat(EDITOR_LIMITS.MAX_COMMENT_LENGTH + 1) }, /dépasse/],
      ['mention non entière', { mentions: [1.2] }, /entiers positifs/],
      ['mention négative', { mentions: [-3] }, /entiers positifs/],
      ['mention chaîne', { mentions: ['4' as unknown as number] }, /entiers positifs/],
      ['trop de mentions', { mentions: Array.from({ length: EDITOR_LIMITS.MAX_MENTIONS_PER_COMMENT + 1 }, (_, i) => i + 1) }, /Trop de mentions/],
      ['mentions non tableau', { mentions: 'x' as unknown as number[] }, /mentions invalide/],
    ];
    for (const [, over, re] of cas) {
      expect(() => addComment(ydoc, nouveau(over))).toThrow(re);
    }
    expect(listComments(ydoc)).toHaveLength(0);
  });

  it('accepte un corps exactement à la limite et refuse un doublon d’id', () => {
    const ydoc = new Y.Doc();
    const input = nouveau({ body: 'a'.repeat(EDITOR_LIMITS.MAX_COMMENT_LENGTH) });
    addComment(ydoc, input);
    expect(() => addComment(ydoc, input)).toThrow(/existe déjà/);
  });

  it(`refuse au-delà de ${EDITOR_LIMITS.MAX_COMMENTS} commentaires`, () => {
    const ydoc = new Y.Doc();
    ydoc.transact(() => {
      const map = ydoc.getMap<Y.Map<unknown>>(COMMENTS_KEY);
      for (let i = 0; i < EDITOR_LIMITS.MAX_COMMENTS; i++) map.set(`id-${i}`, new Y.Map());
    });
    expect(() => addComment(ydoc, nouveau())).toThrow(/Nombre maximal de commentaires/);
  });

  it(`refuse au-delà de ${EDITOR_LIMITS.MAX_REPLIES_PER_COMMENT} réponses et valide les réponses`, () => {
    const ydoc = new Y.Doc();
    const c = addComment(ydoc, nouveau());
    const rep = (over = {}) => ({ id: randomUUID(), authorUserGroupId: 2, authorName: 'B', body: 'r', mentions: [] as number[], ...over });
    expect(() => addReply(ydoc, randomUUID(), rep())).toThrow(/introuvable/);
    expect(() => addReply(ydoc, c.id, rep({ id: 'x' }))).toThrow(/réponse invalide/);
    expect(() => addReply(ydoc, c.id, rep({ body: '' }))).toThrow(/vide/);
    expect(() => addReply(ydoc, c.id, rep({ mentions: [0] }))).toThrow(/entiers positifs/);
    const fixe = rep();
    addReply(ydoc, c.id, fixe);
    expect(() => addReply(ydoc, c.id, fixe)).toThrow(/existe déjà/);
    for (let i = 1; i < EDITOR_LIMITS.MAX_REPLIES_PER_COMMENT; i++) addReply(ydoc, c.id, rep());
    expect(listComments(ydoc)[0]?.replies).toHaveLength(EDITOR_LIMITS.MAX_REPLIES_PER_COMMENT);
    expect(() => addReply(ydoc, c.id, rep())).toThrow(/Nombre maximal de réponses/);
  });

  it('setCommentResolved refuse un commentaire inconnu ou un nom invalide', () => {
    const ydoc = new Y.Doc();
    const c = addComment(ydoc, nouveau());
    expect(() => setCommentResolved(ydoc, randomUUID(), true, 'B')).toThrow(/introuvable/);
    expect(() => setCommentResolved(ydoc, c.id, true, '')).toThrow(/invalide/);
  });

  it('listComments tolère des données distantes malformées', () => {
    const ydoc = new Y.Doc();
    const m = new Y.Map<unknown>();
    ydoc.getMap<Y.Map<unknown>>(COMMENTS_KEY).set('zz', m);
    m.set('mentions', ['x', -2, 5]);
    m.set('authorUserGroupId', 'pas un nombre');
    const [c] = listComments(ydoc);
    expect(c).toMatchObject({ mentions: [5], authorUserGroupId: 0, replies: [], resolved: false });
  });
});

describe('extractMentionIds', () => {
  it('fait l’union texte + commentaires + réponses, entiers uniques triés', () => {
    const ydoc = htmlToYDoc(
      '<p><span data-type="mention" data-id="30" data-label="Z">@Z</span> et <strong>gras <span data-type="mention" data-id="4" data-label="D">@D</span></strong></p>' +
        '<ul><li><p><span data-type="mention" data-id="30" data-label="Z">@Z</span></p></li></ul>' +
        '<table><tbody><tr><td><p><span data-type="mention" data-id="8" data-label="H">@H</span></p></td></tr></tbody></table>',
    );
    expect(extractMentionIds(ydoc)).toEqual([4, 8, 30]);
    const c = addComment(ydoc, nouveau({ mentions: [100, 4] }));
    addReply(ydoc, c.id, { id: randomUUID(), authorUserGroupId: 1, authorName: 'A', body: 'r', mentions: [2, 100] });
    expect(extractMentionIds(ydoc)).toEqual([2, 4, 8, 30, 100]);
  });

  it('renvoie [] sans mention et ignore les ids non numériques', () => {
    expect(extractMentionIds(new Y.Doc())).toEqual([]);
    const ydoc = htmlToYDoc('<p>rien</p>');
    expect(extractMentionIds(ydoc)).toEqual([]);
    // Un id non entier ne passe pas l'assainissement : la mention est retirée.
    const ko = htmlToYDoc('<p><span data-type="mention" data-id="abc" data-label="x">@x</span></p>');
    expect(extractMentionIds(ko)).toEqual([]);
    expect(yDocToPlainText(ko)).toBe('@x');
  });
});
