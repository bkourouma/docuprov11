/** Constantes et types publics partagés (isomorphes). Ré-exportés par `index.ts`. */

/** Nom du Y.XmlFragment qui porte le contenu ProseMirror. */
export const EDITOR_FRAGMENT = 'default';
/** Y.Map des commentaires (id -> Y.Map). Stocké DANS le document Yjs, jamais en base. */
export const COMMENTS_KEY = 'comments';
/**
 * Clé historique du Y.Map de méta. Le registre des mentions notifiées vit désormais côté serveur,
 * hors Y.Doc ; la clé reste exportée pour compatibilité.
 */
export const META_KEY = 'meta';

export const EDITOR_LIMITS = {
  /** Taille max de l'état Yjs encodé accepté/persisté (octets). */
  MAX_STATE_BYTES: 8 * 1024 * 1024,
  MAX_COMMENT_LENGTH: 4000,
  MAX_COMMENTS: 2000,
  MAX_REPLIES_PER_COMMENT: 200,
  MAX_MENTIONS_PER_COMMENT: 20,
} as const;

/** Mention : attrs { id: string (user_group_id en texte), label: string }. */
export const MENTION_NODE_NAME = 'mention';
/** Marque de commentaire : attrs { commentId: string }. */
export const COMMENT_MARK_NAME = 'comment';

export interface EditorCommentReply {
  id: string;
  authorUserGroupId: number;
  authorName: string;
  createdAt: string; // ISO UTC
  body: string;
  mentions: number[]; // user_group_id
}

export interface EditorComment {
  id: string; // uuid ; identique à l'attribut `commentId` de la marque dans le texte
  authorUserGroupId: number;
  authorName: string;
  createdAt: string;
  body: string;
  /** Extrait du texte commenté au moment du commentaire (contexte si l'ancre disparaît). */
  anchorText: string;
  mentions: number[];
  /** Un commentaire résolu est CONSERVÉ (jamais supprimé) : `resolved` bascule seulement. */
  resolved: boolean;
  resolvedByName: string | null;
  resolvedAt: string | null;
  replies: EditorCommentReply[];
}

export interface NewCommentInput {
  id: string;
  authorUserGroupId: number;
  authorName: string;
  body: string;
  anchorText: string;
  mentions: number[];
}
