import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';
import { generateHTML, generateJSON } from '@tiptap/html/server';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { EDITOR_FRAGMENT, EDITOR_LIMITS } from './constants';
import { EDITOR_ORIGIN } from './comments';
import { createEditorExtensions, getEditorSchema } from './schema';
import { sanitizeEditorHtml } from './sanitize';
import { projectFragment } from './structure';

/** Extensions partagées pour les conversions serveur (créées une fois). */
let extensions: ReturnType<typeof createEditorExtensions> | null = null;
const serverExtensions = () => {
  if (!extensions) extensions = createEditorExtensions();
  return extensions;
};

/** HTML (assaini d'abord) -> JSON ProseMirror valide pour le schéma de l'éditeur. */
const htmlToJson = (html: string): JSONContent => {
  const clean = sanitizeEditorHtml(html);
  const json = generateJSON(clean, serverExtensions());
  if (!json.content || json.content.length === 0) {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  return json;
};

/**
 * Remplace le contenu (fragment `EDITOR_FRAGMENT`) du ydoc par ce HTML (assaini d'abord).
 * Une seule transaction ; mise à jour par différentiel ; les commentaires ne sont pas touchés.
 */
export const applyHtmlToYDoc = (ydoc: Y.Doc, html: string): void => {
  const json = htmlToJson(html);
  const schema = getEditorSchema();
  ydoc.transact(() => {
    prosemirrorJSONToYXmlFragment(schema, json, ydoc.getXmlFragment(EDITOR_FRAGMENT));
  }, EDITOR_ORIGIN);
};

/** Crée un Y.Doc neuf (fragment peuplé) depuis du HTML. */
export const htmlToYDoc = (html: string): Y.Doc => {
  const ydoc = new Y.Doc();
  applyHtmlToYDoc(ydoc, html);
  return ydoc;
};

const EMPTY_DOC: JSONContent = { type: 'doc' };

/**
 * JSON ProseMirror du document. TOLÉRANT : parcours itératif borné (profondeur 64, 100000 nœuds),
 * nœuds invalides ignorés, jamais d'exception ; renvoie le contenu valide restant (ou un doc vide).
 */
export const yDocToJson = (ydoc: Y.Doc): JSONContent => {
  try {
    const result = projectFragment(ydoc.getXmlFragment(EDITOR_FRAGMENT), 'tolerant');
    return result.ok ? (result.root.toJSON() as JSONContent) : { ...EMPTY_DOC };
  } catch {
    return { ...EMPTY_DOC };
  }
};

/** Instantané HTML assaini du document (stocké comme pièce `.html` de la version). Ne lève pas. */
export const yDocToHtml = (ydoc: Y.Doc): string => {
  try {
    const json = yDocToJson(ydoc);
    if (!json.content || json.content.length === 0) return '';
    return sanitizeEditorHtml(generateHTML(json, serverExtensions()));
  } catch {
    return '';
  }
};

/** Encode l'état complet du document. */
export const encodeState = (ydoc: Y.Doc): Uint8Array => Y.encodeStateAsUpdate(ydoc);

/** Décode un état complet ; rejette au-delà de `EDITOR_LIMITS.MAX_STATE_BYTES` ou si corrompu. */
export const decodeState = (bytes: Uint8Array): Y.Doc => {
  if (!(bytes instanceof Uint8Array)) throw new Error("État du document invalide : octets attendus.");
  if (bytes.byteLength > EDITOR_LIMITS.MAX_STATE_BYTES) {
    throw new Error(
      `État du document trop volumineux (maximum ${Math.floor(EDITOR_LIMITS.MAX_STATE_BYTES / (1024 * 1024))} Mo).`,
    );
  }
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, bytes);
  } catch {
    ydoc.destroy();
    throw new Error('État du document corrompu : décodage impossible.');
  }
  // Une mise à jour tronquée/incohérente laisse des structures en attente : on la refuse.
  if (ydoc.store.pendingStructs !== null || ydoc.store.pendingDs !== null) {
    ydoc.destroy();
    throw new Error('État du document corrompu ou incomplet.');
  }
  return ydoc;
};
