import { randomUUID } from 'crypto';
import * as Y from 'yjs';
import {
  addComment,
  addReply,
  applyHtmlToYDoc,
  htmlToYDoc,
  listComments,
  setCommentResolved,
  yDocToJson,
  yDocToPlainText,
} from './server';

const nouveau = (name: string, body: string) => ({
  id: randomUUID(),
  authorUserGroupId: 1,
  authorName: name,
  body,
  anchorText: '',
  mentions: [] as number[],
});

/** Échange les updates dans un sens puis dans l'autre. */
const sync = (a: Y.Doc, b: Y.Doc): void => {
  const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, ua);
  Y.applyUpdate(a, ub);
};

/** Clone un client à partir de l'état d'un document (même historique de base). */
const clone = (src: Y.Doc): Y.Doc => {
  const d = new Y.Doc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(src));
  return d;
};

const stripDates = (c: ReturnType<typeof listComments>) =>
  c.map((x) => ({ ...x, replies: x.replies.map((r) => r.id) }));

describe('convergence de deux clients simulés', () => {
  it('édition concurrente du contenu : même JSON dans les deux sens et dans tous les ordres', () => {
    const base = htmlToYDoc('<p>Début</p><p>Fin</p>');
    const a = clone(base);
    const b = clone(base);

    applyHtmlToYDoc(a, '<h1>Titre A</h1><p>Début</p><p>Fin</p>');
    applyHtmlToYDoc(b, '<p>Début</p><p>Fin</p><p>Ajout de B</p>');

    // Ordre 1 : a puis b ; ordre 2 : mises à jour appliquées en sens inverse sur un 3e client.
    const ua = Y.encodeStateAsUpdate(a);
    const ub = Y.encodeStateAsUpdate(b);
    const c1 = clone(base);
    const c2 = clone(base);
    Y.applyUpdate(c1, ua);
    Y.applyUpdate(c1, ub);
    Y.applyUpdate(c2, ub);
    Y.applyUpdate(c2, ua);
    sync(a, b);

    expect(yDocToJson(a)).toEqual(yDocToJson(b));
    expect(yDocToJson(c1)).toEqual(yDocToJson(a));
    expect(yDocToJson(c2)).toEqual(yDocToJson(a));
    const texte = yDocToPlainText(a);
    expect(texte).toContain('Titre A');
    expect(texte).toContain('Ajout de B');
    expect(texte).toContain('Début');
  });

  it('commentaires concurrents, réponses et résolution : mêmes commentaires partout', () => {
    const base = htmlToYDoc('<p>Contrat</p>');
    const partage = addComment(base, nouveau('Base', 'commentaire initial'));
    const a = clone(base);
    const b = clone(base);

    // Concurrence : chacun ajoute un commentaire, répond au commentaire initial ; A résout, B rouvre.
    addComment(a, nouveau('Alice', 'de A'));
    addComment(b, nouveau('Bob', 'de B'));
    addReply(a, partage.id, { id: randomUUID(), authorUserGroupId: 1, authorName: 'Alice', body: 'rép A', mentions: [] });
    addReply(b, partage.id, { id: randomUUID(), authorUserGroupId: 2, authorName: 'Bob', body: 'rép B', mentions: [3] });
    setCommentResolved(a, partage.id, true, 'Alice');
    setCommentResolved(b, partage.id, false, 'Bob');

    const ua = Y.encodeStateAsUpdate(a);
    const ub = Y.encodeStateAsUpdate(b);
    const c1 = clone(base);
    const c2 = clone(base);
    Y.applyUpdate(c1, ua);
    Y.applyUpdate(c1, ub);
    Y.applyUpdate(c2, ub);
    Y.applyUpdate(c2, ua);
    sync(a, b);

    const la = listComments(a);
    expect(la).toHaveLength(3);
    expect(listComments(b)).toEqual(la);
    expect(listComments(c1)).toEqual(la);
    expect(listComments(c2)).toEqual(la);
    const initial = la.find((c) => c.id === partage.id)!;
    expect(initial.replies.map((r) => r.body).sort()).toEqual(['rép A', 'rép B']);
    // Résolution concurrente : un seul état gagnant, identique partout, jamais de perte du commentaire.
    expect(typeof initial.resolved).toBe('boolean');
    expect(stripDates(listComments(b))).toEqual(stripDates(la));
  });

  it('contenu ET commentaires en concurrence, échanges multiples dans des ordres différents', () => {
    const base = htmlToYDoc('<p>Un</p><p>Deux</p>');
    const a = clone(base);
    const b = clone(base);

    // Tour 1 : éditions concurrentes + commentaires concurrents.
    applyHtmlToYDoc(a, '<p>Un</p><p>Deux</p><p>Trois (A)</p>');
    addComment(a, nouveau('Alice', 'A1'));
    applyHtmlToYDoc(b, '<h2>Intro (B)</h2><p>Un</p><p>Deux</p>');
    addComment(b, nouveau('Bob', 'B1'));

    // Échanges en ordres différents : A reçoit l'update de B ; B reçoit seulement après une 2e édition de A.
    const ub1 = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, ub1);
    addComment(a, nouveau('Alice', 'A2'));
    applyHtmlToYDoc(a, yDocToPlainText(a).split('\n').map((l) => `<p>${l}</p>`).join(''));
    const ua2 = Y.encodeStateAsUpdate(a);
    const ub2 = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(b, ua2);
    Y.applyUpdate(a, ub2);
    sync(a, b);

    expect(yDocToJson(a)).toEqual(yDocToJson(b));
    expect(listComments(a)).toEqual(listComments(b));
    expect(listComments(a).map((c) => c.body).sort()).toEqual(['A1', 'A2', 'B1']);
    expect(yDocToPlainText(a)).toBe(yDocToPlainText(b));
    expect(Y.encodeStateVector(a)).toEqual(Y.encodeStateVector(b));
  });

  it('un update appliqué deux fois ou dans le désordre est idempotent', () => {
    const base = htmlToYDoc('<p>x</p>');
    const a = clone(base);
    addComment(a, nouveau('A', 'c'));
    applyHtmlToYDoc(a, '<p>x</p><p>y</p>');
    const maj = Y.encodeStateAsUpdate(a);
    const b = clone(base);
    Y.applyUpdate(b, maj);
    Y.applyUpdate(b, maj);
    expect(yDocToJson(b)).toEqual(yDocToJson(a));
    expect(listComments(b)).toEqual(listComments(a));
  });
});
