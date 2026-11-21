import { Mark, getSchema, mergeAttributes } from '@tiptap/core';
import type { AnyExtension } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { Mention } from '@tiptap/extension-mention';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { Schema } from '@tiptap/pm/model';
import { COMMENT_MARK_NAME, MENTION_NODE_NAME } from './constants';

/** Protocoles de lien autorisés (aucun javascript:, data:, file:...). */
const ALLOWED_LINK_PROTOCOLS = ['http', 'https', 'mailto'];

/** Un lien est accepté s'il n'a pas de schéma (protocole par défaut) ou si son schéma est autorisé. */
export const isAllowedLinkUri = (uri: string): boolean => {
  // eslint-disable-next-line no-control-regex
  const clean = uri.replace(/[\u0000- \u007F-\u009F]/g, '');
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(clean);
  if (!match) return true;
  return ALLOWED_LINK_PROTOCOLS.includes((match[1] ?? '').toLowerCase());
};

/** Marque `comment` : ancre d'un commentaire (le contenu du commentaire vit dans le Y.Map). */
export const CommentMark = Mark.create({
  name: COMMENT_MARK_NAME,
  inclusive: false,
  // Des commentaires peuvent se chevaucher : une marque `comment` n'exclut pas les autres.
  excludes: '',
  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (element: { getAttribute(name: string): string | null }) =>
          element.getAttribute('data-comment-id'),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.commentId ? { 'data-comment-id': String(attributes.commentId) } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

/**
 * Extensions Tiptap PARTAGÉES web/serveur (même schéma ProseMirror des deux côtés).
 * Pas d'image ni d'iframe ; l'historique est désactivé (la collaboration Yjs gère l'annulation).
 */
export const createEditorExtensions = (opts?: { mentionSuggestion?: unknown }): AnyExtension[] => {
  const mention = Mention.configure({
    HTMLAttributes: { class: 'mention' },
    ...(opts?.mentionSuggestion
      ? { suggestion: opts.mentionSuggestion as NonNullable<Parameters<typeof Mention.configure>[0]>['suggestion'] }
      : {}),
  });
  return [
    StarterKit.configure({
      undoRedo: false,
      trailingNode: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        isAllowedUri: (url: string) => isAllowedLinkUri(url),
        HTMLAttributes: { rel: 'noopener noreferrer', target: null },
      },
    }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    mention,
    CommentMark,
  ];
};

let cachedSchema: Schema | null = null;

/** Schéma ProseMirror issu des extensions partagées (mis en cache). */
export const getEditorSchema = (): Schema => {
  if (!cachedSchema) cachedSchema = getSchema(createEditorExtensions());
  return cachedSchema;
};

export { MENTION_NODE_NAME, COMMENT_MARK_NAME };
