import * as Y from 'yjs';
import {
  COMMENTS_KEY,
  EDITOR_LIMITS,
  type EditorComment,
  type EditorCommentReply,
  type NewCommentInput,
} from './constants';

/** Origine des transactions d'écriture locales (distingue des updates distantes). */
export const EDITOR_ORIGIN = 'editor';

const UUID_LIKE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_ANCHOR_LENGTH = 300;
const MAX_NAME_LENGTH = 200;

const commentsMap = (ydoc: Y.Doc): Y.Map<Y.Map<unknown>> =>
  ydoc.getMap<Y.Map<unknown>>(COMMENTS_KEY);

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

const asAuthorId = (v: unknown): number => (isPositiveInt(v) ? v : 0);

/** Lecture tolérante d'un tableau de mentions (données distantes non fiables). */
const readMentions = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter(isPositiveInt).slice(0, EDITOR_LIMITS.MAX_MENTIONS_PER_COMMENT) : [];

const readReply = (m: Y.Map<unknown>): EditorCommentReply => ({
  id: asString(m.get('id')),
  authorUserGroupId: asAuthorId(m.get('authorUserGroupId')),
  authorName: asString(m.get('authorName')),
  createdAt: asString(m.get('createdAt')),
  body: asString(m.get('body')),
  mentions: readMentions(m.get('mentions')),
});

const readComment = (m: Y.Map<unknown>): EditorComment => {
  const replies = m.get('replies');
  const replyList: EditorCommentReply[] = [];
  if (replies instanceof Y.Array) {
    for (const r of replies.toArray()) {
      if (r instanceof Y.Map) replyList.push(readReply(r as Y.Map<unknown>));
    }
  }
  const resolvedByName = m.get('resolvedByName');
  const resolvedAt = m.get('resolvedAt');
  return {
    id: asString(m.get('id')),
    authorUserGroupId: asAuthorId(m.get('authorUserGroupId')),
    authorName: asString(m.get('authorName')),
    createdAt: asString(m.get('createdAt')),
    body: asString(m.get('body')),
    anchorText: asString(m.get('anchorText')),
    mentions: readMentions(m.get('mentions')),
    resolved: m.get('resolved') === true,
    resolvedByName: typeof resolvedByName === 'string' ? resolvedByName : null,
    resolvedAt: typeof resolvedAt === 'string' ? resolvedAt : null,
    replies: replyList,
  };
};

/** Commentaires du document, triés par date de création puis id (ordre déterministe). */
export const listComments = (ydoc: Y.Doc): EditorComment[] => {
  const out: EditorComment[] = [];
  commentsMap(ydoc).forEach((m) => {
    if (m instanceof Y.Map) out.push(readComment(m as Y.Map<unknown>));
  });
  return out.sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  );
};

const validateAuthor = (id: unknown, name: unknown): string => {
  if (!isPositiveInt(id)) throw new Error("Identifiant d'auteur invalide.");
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error("Nom d'auteur obligatoire.");
  }
  if (name.length > MAX_NAME_LENGTH) throw new Error("Nom d'auteur trop long.");
  return name;
};

const validateBody = (body: unknown): string => {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new Error('Le commentaire ne peut pas être vide.');
  }
  if (body.length > EDITOR_LIMITS.MAX_COMMENT_LENGTH) {
    throw new Error(`Le commentaire dépasse ${EDITOR_LIMITS.MAX_COMMENT_LENGTH} caractères.`);
  }
  return body;
};

const validateMentions = (mentions: unknown): number[] => {
  if (!Array.isArray(mentions)) throw new Error('Liste de mentions invalide.');
  if (mentions.length > EDITOR_LIMITS.MAX_MENTIONS_PER_COMMENT) {
    throw new Error(`Trop de mentions (maximum ${EDITOR_LIMITS.MAX_MENTIONS_PER_COMMENT}).`);
  }
  if (!mentions.every(isPositiveInt)) {
    throw new Error('Les mentions doivent être des identifiants entiers positifs.');
  }
  return Array.from(new Set(mentions as number[]));
};

const validateUuid = (id: unknown, what: string): string => {
  if (typeof id !== 'string' || !UUID_LIKE.test(id)) {
    throw new Error(`Identifiant de ${what} invalide.`);
  }
  return id;
};

/** Ajoute un commentaire. Lève une Error française si l'entrée est invalide ou si une limite est atteinte. */
export const addComment = (ydoc: Y.Doc, input: NewCommentInput): EditorComment => {
  const id = validateUuid(input.id, 'commentaire');
  const authorName = validateAuthor(input.authorUserGroupId, input.authorName);
  const body = validateBody(input.body);
  const mentions = validateMentions(input.mentions);
  if (typeof input.anchorText !== 'string') throw new Error('Texte ancré invalide.');
  const anchorText = input.anchorText.slice(0, MAX_ANCHOR_LENGTH);

  const map = commentsMap(ydoc);
  if (map.has(id)) throw new Error('Ce commentaire existe déjà.');
  if (map.size >= EDITOR_LIMITS.MAX_COMMENTS) {
    throw new Error(`Nombre maximal de commentaires atteint (${EDITOR_LIMITS.MAX_COMMENTS}).`);
  }

  const comment: EditorComment = {
    id,
    authorUserGroupId: input.authorUserGroupId,
    authorName,
    createdAt: new Date().toISOString(),
    body,
    anchorText,
    mentions,
    resolved: false,
    resolvedByName: null,
    resolvedAt: null,
    replies: [],
  };

  ydoc.transact(() => {
    const m = new Y.Map<unknown>();
    map.set(id, m);
    m.set('id', comment.id);
    m.set('authorUserGroupId', comment.authorUserGroupId);
    m.set('authorName', comment.authorName);
    m.set('createdAt', comment.createdAt);
    m.set('body', comment.body);
    m.set('anchorText', comment.anchorText);
    m.set('mentions', comment.mentions);
    m.set('resolved', false);
    m.set('resolvedByName', null);
    m.set('resolvedAt', null);
    m.set('replies', new Y.Array<Y.Map<unknown>>());
  }, EDITOR_ORIGIN);
  return comment;
};

/** Ajoute une réponse à un commentaire existant. */
export const addReply = (
  ydoc: Y.Doc,
  commentId: string,
  reply: Omit<EditorCommentReply, 'createdAt'>,
): EditorCommentReply => {
  const id = validateUuid(reply.id, 'réponse');
  const authorName = validateAuthor(reply.authorUserGroupId, reply.authorName);
  const body = validateBody(reply.body);
  const mentions = validateMentions(reply.mentions);

  const target = commentsMap(ydoc).get(commentId);
  if (!(target instanceof Y.Map)) throw new Error('Commentaire introuvable.');
  const replies = target.get('replies');
  if (!(replies instanceof Y.Array)) throw new Error('Commentaire corrompu : réponses absentes.');
  if (replies.length >= EDITOR_LIMITS.MAX_REPLIES_PER_COMMENT) {
    throw new Error(`Nombre maximal de réponses atteint (${EDITOR_LIMITS.MAX_REPLIES_PER_COMMENT}).`);
  }
  for (const r of replies.toArray()) {
    if (r instanceof Y.Map && r.get('id') === id) throw new Error('Cette réponse existe déjà.');
  }

  const created: EditorCommentReply = {
    id,
    authorUserGroupId: reply.authorUserGroupId,
    authorName,
    createdAt: new Date().toISOString(),
    body,
    mentions,
  };
  ydoc.transact(() => {
    const m = new Y.Map<unknown>();
    (replies as Y.Array<Y.Map<unknown>>).push([m]);
    m.set('id', created.id);
    m.set('authorUserGroupId', created.authorUserGroupId);
    m.set('authorName', created.authorName);
    m.set('createdAt', created.createdAt);
    m.set('body', created.body);
    m.set('mentions', created.mentions);
  }, EDITOR_ORIGIN);
  return created;
};

/** Résout / rouvre un commentaire. Le commentaire est TOUJOURS conservé (aucune suppression possible). */
export const setCommentResolved = (
  ydoc: Y.Doc,
  commentId: string,
  resolved: boolean,
  byName: string,
): void => {
  const target = commentsMap(ydoc).get(commentId);
  if (!(target instanceof Y.Map)) throw new Error('Commentaire introuvable.');
  if (
    resolved &&
    (typeof byName !== 'string' || byName.trim().length === 0 || byName.length > MAX_NAME_LENGTH)
  ) {
    throw new Error('Nom du résolveur invalide.');
  }
  ydoc.transact(() => {
    target.set('resolved', resolved);
    target.set('resolvedByName', resolved ? byName : null);
    target.set('resolvedAt', resolved ? new Date().toISOString() : null);
  }, EDITOR_ORIGIN);
};
