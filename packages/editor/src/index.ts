/**
 * @archivage/editor — entrée ISOMORPHE (navigateur + serveur) : aucun import node-only ici
 * (mammoth, docx, sanitize-html vivent dans `./server`).
 *
 * CONTRAT posé par le chef de lot ; les signatures exportées sont stables (les lots API et
 * web compilent contre elles).
 */
import type { JSONContent } from '@tiptap/core';

export {
  EDITOR_FRAGMENT,
  COMMENTS_KEY,
  META_KEY,
  EDITOR_LIMITS,
  MENTION_NODE_NAME,
  COMMENT_MARK_NAME,
} from './constants';
export type { EditorCommentReply, EditorComment, NewCommentInput } from './constants';
export { createEditorExtensions, getEditorSchema, CommentMark, isAllowedLinkUri } from './schema';
export { listComments, addComment, addReply, setCommentResolved, EDITOR_ORIGIN } from './comments';
export { extractMentionIds, yDocToPlainText } from './content';
export type { JSONContent };
