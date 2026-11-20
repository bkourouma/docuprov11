'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Button, Input, Segmented, Typography } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import dayjs from 'dayjs';
import type * as Y from 'yjs';
import type { Editor } from '@tiptap/react';
import {
  COMMENTS_KEY,
  COMMENT_MARK_NAME,
  EDITOR_LIMITS,
  addComment,
  addReply,
  listComments,
  setCommentResolved,
  type EditorComment,
} from '@archivage/editor';
import { EmptyState } from '../EmptyState';
import { fontSize } from '../../theme/tokens';
import type { GedCollabMentionCandidate } from '../../lib/editeur';
import { MENTION_HELP, createMentionSearch } from './mention-suggestion';
import styles from './editeur.module.css';

const { Text } = Typography;

/** Sélection capturée au clic sur « Commenter » (elle peut bouger pendant la saisie). */
export interface CommentDraft {
  from: number;
  to: number;
  anchorText: string;
}

type Filter = 'open' | 'resolved' | 'all';

const fmtDate = (iso: string) => dayjs(iso).format('DD/MM/YYYY HH:mm');
const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Position (from/to) de l'ancre d'un commentaire : parcourt le document à la recherche de la marque. */
function findAnchor(editor: Editor, commentId: string): { from: number; to: number } | null {
  let from = -1;
  let to = -1;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const hit = node.marks.some(
      (m) => m.type.name === COMMENT_MARK_NAME && m.attrs.commentId === commentId,
    );
    if (!hit) return;
    if (from < 0) from = pos;
    to = pos + node.nodeSize;
  });
  return from < 0 ? null : { from, to };
}

/** Longueur maximale de l'extrait conservé avec le commentaire. */
const ANCHOR_MAX = 200;

/** Capture la sélection courante (non vide) comme brouillon de commentaire. */
export function makeDraft(editor: Editor): CommentDraft | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  const text = editor.state.doc.textBetween(from, to, ' ').trim();
  if (!text) return null;
  return { from, to, anchorText: text.slice(0, ANCHOR_MAX) };
}

/** Retrouve la plage commentée si le texte a bougé depuis la capture (modifications distantes). */
function resolveDraftRange(editor: Editor, d: CommentDraft): { from: number; to: number } | null {
  const doc = editor.state.doc;
  const size = doc.content.size;
  if (d.to <= size && doc.textBetween(d.from, d.to, ' ').trim().slice(0, ANCHOR_MAX) === d.anchorText) {
    return { from: d.from, to: d.to };
  }
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return;
    const i = node.text.indexOf(d.anchorText);
    if (i >= 0) found = { from: pos + i, to: pos + i + d.anchorText.length };
  });
  return found;
}

/** Zone de saisie avec suggestion @ (mêmes candidats que l'éditeur, débouncée à 250 ms). */
function Composer({
  documentId,
  placeholder,
  ariaLabel,
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  documentId: number;
  placeholder: string;
  ariaLabel: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (body: string, mentions: number[]) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState('');
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  const [items, setItems] = useState<GedCollabMentionCandidate[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = useRef(new Map<number, string>());
  const ref = useRef<TextAreaRef>(null);
  const listId = useId();
  const search = useMemo(() => createMentionSearch(documentId), [documentId]);

  useEffect(() => () => search.cancel(), [search]);

  useEffect(() => {
    if (!token) {
      search.cancel();
      return;
    }
    let alive = true;
    void search.search(token.query).then((r) => {
      if (alive) {
        setItems(r);
        setActive(0);
      }
    });
    return () => {
      alive = false;
    };
  }, [token, search]);

  const detect = (text: string, caret: number) => {
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret));
    setToken(m ? { start: m.index + (m[1] ?? '').length, query: m[2] ?? '' } : null);
  };

  const choose = (c: GedCollabMentionCandidate) => {
    const el = ref.current?.resizableTextArea?.textArea;
    const caret = el?.selectionStart ?? value.length;
    if (!token) return;
    const insert = `@${c.name} `;
    const next = value.slice(0, token.start) + insert + value.slice(caret);
    picked.current.set(c.userGroupId, c.name);
    setValue(next);
    setToken(null);
    const pos = token.start + insert.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const submit = async () => {
    const body = value.trim();
    if (!body || busy) return;
    const mentions = [...picked.current.entries()]
      .filter(([, name]) => body.includes(`@${name}`))
      .map(([id]) => id)
      .slice(0, EDITOR_LIMITS.MAX_MENTIONS_PER_COMMENT);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body, mentions);
      setValue('');
      picked.current.clear();
    } catch (e) {
      setError(errMsg(e, 'Publication impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (token && items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a + items.length - 1) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = items[active];
        if (pick) choose(pick);
        return;
      }
    }
    if (e.key === 'Escape' && token) {
      e.preventDefault();
      e.stopPropagation(); // ferme la liste, pas le panneau
      setToken(null);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const open = token !== null;

  return (
    <div className={styles.composer}>
      <Input.TextArea
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        autoSize={{ minRows: 2, maxRows: 8 }}
        maxLength={EDITOR_LIMITS.MAX_COMMENT_LENGTH}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && items.length > 0 ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onClick={(e) => detect(value, e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        disabled={busy}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label="Personnes à mentionner" className={styles.suggestBox}>
          {items.length === 0 ? (
            <li role="presentation" className={styles.mentionEmpty}>
              Aucune personne trouvée
            </li>
          ) : (
            items.map((c, i) => (
              <li
                key={c.userGroupId}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={styles.suggestItem}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c);
                }}
              >
                {c.name}
              </li>
            ))
          )}
          <li role="presentation" className={styles.mentionHelp}>
            {MENTION_HELP}
          </li>
        </ul>
      )}
      <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: fontSize.xs }}>
        @ pour mentionner. Ctrl+Entrée pour publier.
      </Text>
      {error && (
        <Text type="danger" role="alert" style={{ display: 'block', fontSize: fontSize.xs }}>
          {error}
        </Text>
      )}
      <div className={styles.commentActions}>
        <Button type="primary" size="small" loading={busy} disabled={!value.trim()} onClick={() => void submit()}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button size="small" onClick={onCancel} disabled={busy}>
            Annuler
          </Button>
        )}
      </div>
    </div>
  );
}

export function CommentsPanel({
  editor,
  ydoc,
  documentId,
  me,
  canWrite,
  draft,
  onDraftDone,
}: {
  editor: Editor;
  ydoc: Y.Doc;
  documentId: number;
  me: { userGroupId: number; name: string };
  canWrite: boolean;
  draft: CommentDraft | null;
  onDraftDone: () => void;
}) {
  const [comments, setComments] = useState<EditorComment[]>(() => safeList(ydoc));
  const [filter, setFilter] = useState<Filter>('open');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Réagit aux changements du Y.Doc (les nôtres et ceux des autres participants).
  useEffect(() => {
    const map = ydoc.getMap(COMMENTS_KEY);
    const refresh = () => setComments(safeList(ydoc));
    refresh();
    map.observeDeep(refresh);
    return () => map.unobserveDeep(refresh);
  }, [ydoc]);

  const counts = useMemo(
    () => ({
      open: comments.filter((c) => !c.resolved).length,
      resolved: comments.filter((c) => c.resolved).length,
    }),
    [comments],
  );

  const visible = useMemo(
    () =>
      comments
        .filter((c) => (filter === 'all' ? true : filter === 'open' ? !c.resolved : c.resolved))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [comments, filter],
  );

  const goTo = useCallback(
    (c: EditorComment) => {
      setActiveId(c.id);
      const r = findAnchor(editor, c.id);
      if (!r) return; // ancre disparue : l'extrait reste lisible dans la carte
      editor.chain().focus().setTextSelection(r).scrollIntoView().run();
    },
    [editor],
  );

  const publishDraft = async (body: string, mentions: number[]) => {
    if (!draft) return;
    const range = resolveDraftRange(editor, draft);
    if (!range) throw new Error('Le texte sélectionné a été modifié. Resélectionnez-le puis recommencez.');
    const id = crypto.randomUUID();
    addComment(ydoc, {
      id,
      authorUserGroupId: me.userGroupId,
      authorName: me.name,
      body,
      anchorText: draft.anchorText,
      mentions,
    });
    editor.chain().focus().setTextSelection(range).setMark(COMMENT_MARK_NAME, { commentId: id }).run();
    setActiveId(id);
    setFilter('open');
    onDraftDone();
  };

  const run = (fn: () => void) => {
    setActionError(null);
    try {
      fn();
    } catch (e) {
      setActionError(errMsg(e, 'Action impossible.'));
    }
  };

  return (
    <div>
      {draft && canWrite && (
        <section className={styles.comment} aria-label="Nouveau commentaire" style={{ marginBottom: 12 }}>
          <span className={styles.commentAnchor} style={{ cursor: 'default' }}>
            {draft.anchorText.length > 140 ? `${draft.anchorText.slice(0, 140)}…` : draft.anchorText}
          </span>
          <Composer
            documentId={documentId}
            autoFocus
            placeholder="Votre commentaire…"
            ariaLabel="Texte du commentaire"
            submitLabel="Commenter"
            onSubmit={publishDraft}
            onCancel={onDraftDone}
          />
        </section>
      )}

      <Segmented<Filter>
        block
        size="small"
        value={filter}
        onChange={setFilter}
        aria-label="Filtrer les commentaires"
        options={[
          { value: 'open', label: `Ouverts (${counts.open})` },
          { value: 'resolved', label: `Résolus (${counts.resolved})` },
          { value: 'all', label: 'Tous' },
        ]}
        style={{ marginBottom: 12 }}
      />

      {actionError && (
        <Text type="danger" role="alert" style={{ display: 'block', marginBottom: 8, fontSize: fontSize.xs }}>
          {actionError}
        </Text>
      )}

      {visible.length === 0 ? (
        <EmptyState
          compact
          icon="document"
          title={filter === 'resolved' ? 'Aucun commentaire résolu' : 'Aucun commentaire'}
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visible.map((c) => (
            <li
              key={c.id}
              className={`${styles.comment} ${c.resolved ? styles.commentResolved : ''} ${
                activeId === c.id ? styles.commentActive : ''
              }`}
            >
              {c.anchorText && (
                <button
                  type="button"
                  className={styles.commentAnchor}
                  onClick={() => goTo(c)}
                  aria-label={`Aller au passage commenté : ${c.anchorText}`}
                >
                  {c.anchorText.length > 140 ? `${c.anchorText.slice(0, 140)}…` : c.anchorText}
                </button>
              )}
              <div className={styles.commentMeta}>
                <strong>{c.authorName}</strong> · {fmtDate(c.createdAt)}
                {c.resolved && (
                  <>
                    {' '}
                    · Résolu{c.resolvedByName ? ` par ${c.resolvedByName}` : ''}
                    {c.resolvedAt ? ` le ${fmtDate(c.resolvedAt)}` : ''}
                  </>
                )}
              </div>
              <p className={styles.commentText}>{c.body}</p>

              {c.replies.length > 0 && (
                <ul className={styles.replies} aria-label="Réponses">
                  {c.replies.map((r) => (
                    <li key={r.id}>
                      <div className={styles.commentMeta}>
                        <strong>{r.authorName}</strong> · {fmtDate(r.createdAt)}
                      </div>
                      <p className={styles.commentText}>{r.body}</p>
                    </li>
                  ))}
                </ul>
              )}

              {canWrite && (
                <div className={styles.commentActions}>
                  <Button size="small" onClick={() => setReplyFor(replyFor === c.id ? null : c.id)}>
                    Répondre
                  </Button>
                  <Button
                    size="small"
                    onClick={() => run(() => setCommentResolved(ydoc, c.id, !c.resolved, me.name))}
                  >
                    {c.resolved ? 'Rouvrir' : 'Résoudre'}
                  </Button>
                </div>
              )}

              {canWrite && replyFor === c.id && (
                <div style={{ marginTop: 8 }}>
                  <Composer
                    documentId={documentId}
                    autoFocus
                    placeholder="Votre réponse…"
                    ariaLabel="Texte de la réponse"
                    submitLabel="Répondre"
                    onSubmit={(body, mentions) => {
                      addReply(ydoc, c.id, {
                        id: crypto.randomUUID(),
                        authorUserGroupId: me.userGroupId,
                        authorName: me.name,
                        body,
                        mentions,
                      });
                      setReplyFor(null);
                    }}
                    onCancel={() => setReplyFor(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function safeList(ydoc: Y.Doc): EditorComment[] {
  try {
    return listComments(ydoc);
  } catch {
    return [];
  }
}
