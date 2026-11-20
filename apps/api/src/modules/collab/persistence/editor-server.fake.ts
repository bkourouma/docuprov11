/**
 * Doublure de `@archivage/editor/server` POUR LES TESTS JEST de l'API (`jest.mock('@archivage/editor/server',
 * () => require('./editor-server.fake'))`).
 *
 * Le vrai module charge `sanitize-html` (htmlparser2, ESM pur) que la configuration jest actuelle
 * de l'API ne transforme pas. On garde donc le VRAI code pour tout ce qui ne dépend que de Yjs
 * (commentaires, mentions, limites, décodage d'état) et on remplace les conversions HTML/DOCX par
 * une version déterministe : l'instantané HTML est stocké tel quel dans un `Y.Map` du document.
 * Aucun code de production n'importe ce fichier.
 */
import * as Y from 'yjs';
import { EDITOR_LIMITS } from '@archivage/editor';

export * from '@archivage/editor';

const FAKE_MAP = 'fakeHtml';

export const applyHtmlToYDoc = (ydoc: Y.Doc, html: string): void => {
  ydoc.transact(() => ydoc.getMap<string>(FAKE_MAP).set('html', html), 'editor');
};

export const htmlToYDoc = (html: string): Y.Doc => {
  const ydoc = new Y.Doc();
  applyHtmlToYDoc(ydoc, html);
  return ydoc;
};

export const yDocToHtml = (ydoc: Y.Doc): string => ydoc.getMap<string>(FAKE_MAP).get('html') ?? '';

export const yDocToJson = (ydoc: Y.Doc) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: yDocToHtml(ydoc) }] }],
});

export const encodeState = (ydoc: Y.Doc): Uint8Array => Y.encodeStateAsUpdate(ydoc);

/** Même contrat que le vrai `decodeState` : taille bornée, corruption et état incomplet refusés. */
export const decodeState = (bytes: Uint8Array): Y.Doc => {
  if (bytes.byteLength > EDITOR_LIMITS.MAX_STATE_BYTES) {
    throw new Error('État du document trop volumineux.');
  }
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, bytes);
  } catch {
    ydoc.destroy();
    throw new Error('État du document corrompu : décodage impossible.');
  }
  if (ydoc.store.pendingStructs !== null || ydoc.store.pendingDs !== null) {
    ydoc.destroy();
    throw new Error('État du document corrompu ou incomplet.');
  }
  return ydoc;
};

export const importDocxToHtml = async (): Promise<{ html: string; warnings: string[] }> => ({
  html: '<p>Contenu importé</p>',
  warnings: [],
});

export const exportDocx = async (): Promise<Buffer> => Buffer.from('docx-factice');

/** Doublure : valide sauf si le document porte le drapeau de test `fakeInvalid` (map Yjs). */
export const validateYDocStructure = (
  ydoc: Y.Doc,
): { ok: true } | { ok: false; reason: string } =>
  ydoc.getMap<boolean>('fakeInvalid').get('invalid')
    ? { ok: false, reason: 'structure invalide' }
    : { ok: true };
