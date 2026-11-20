'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Badge, Button, Card, Drawer, Dropdown, Form, Grid, Input, Modal, Skeleton } from 'antd';
import type { MenuProps } from 'antd';
import * as Y from 'yjs';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Check, ChevronDown, FileDown, FileUp, History, MessageSquare, Save, X } from 'lucide-react';
import { COMMENTS_KEY, EDITOR_FRAGMENT, createEditorExtensions, listComments } from '@archivage/editor';
import { PageHeader } from '../PageHeader';
import { EmptyState } from '../EmptyState';
import { useFeedback } from '../feedback';
import { icons, iconDefaults } from '../../theme/icons';
import { space } from '../../theme/tokens';
import {
  EditeurApiError,
  LIMIT_MAX_ATTEMPTS,
  STABLE_CONNECTION_MS,
  closeAction,
  deriveWsUrl,
  docRecreation,
  editeurApi,
  initials,
  interpretCloseCode,
  redirectToLogin,
  presenceColor,
  type GedCollabSession,
} from '../../lib/editeur';
import { EditorToolbar } from './EditorToolbar';
import { CommentsPanel, makeDraft, type CommentDraft } from './CommentsPanel';
import { VersionHistoryPanel } from './VersionHistoryPanel';
import { createMentionSuggestion } from './mention-suggestion';
import styles from './editeur.module.css';

const ICON = { size: 16, strokeWidth: iconDefaults.strokeWidth } as const;

type Panel = 'comments' | 'history' | null;
type ConnState = 'connecting' | 'connected' | 'disconnected';
type CloseBanner =
  | { type: 'structure' }
  | { type: 'retry'; attempt: number; seconds: number }
  | { type: 'giveup' };

interface PresenceUser {
  clientId: number;
  userGroupId: number | null;
  name: string;
  color: string;
}

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function readToken(): string {
  try {
    return window.localStorage.getItem('token') ?? '';
  } catch {
    return '';
  }
}

/** Attend (au plus `timeoutMs`) que le serveur ait reçu toutes nos modifications. */
async function waitSynced(provider: HocuspocusProvider, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (provider.unsyncedChanges > 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

function EditorSkeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement de l’éditeur">
      <Skeleton.Input active size="large" style={{ width: 'min(420px, 70%)' }} />
      <Card style={{ marginTop: space.lg }}>
        <Skeleton active title={{ width: '40%' }} paragraph={{ rows: 8 }} />
      </Card>
    </div>
  );
}

function Inaccessible({ onBack, message }: { onBack: () => void; message?: string }) {
  return (
    <div>
      <PageHeader
        icon="document"
        title="Document inaccessible"
        breadcrumb={[{ label: 'Recherche', href: '/search' }, { label: 'Éditeur' }]}
        actions={<Button onClick={onBack}>Retour</Button>}
      />
      <Card>
        <EmptyState icon="document" title={message ?? 'Document inaccessible'} />
      </Card>
    </div>
  );
}

/**
 * Éditeur natif collaboratif : charge la session, ouvre la connexion temps réel et affiche
 * l'éditeur, les commentaires et l'historique. Le serveur reste l'autorité (droits, taille,
 * débit) : le masquage des boutons en lecture seule n'est qu'ergonomique.
 */
export function EditorShell({ documentId }: { documentId: number }) {
  const router = useRouter();
  const [phase, setPhase] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');
  const [session, setSession] = useState<GedCollabSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  const load = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const s = await editeurApi.getSession(documentId);
      setSession(s);
      setEpoch((n) => n + 1);
      setPhase('ready');
    } catch (e) {
      if (e instanceof EditeurApiError && (e.status === 404 || e.status === 403)) {
        setPhase('notfound');
      } else {
        setError(errMsg(e, 'Chargement impossible.'));
        setPhase('error');
      }
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = useCallback(() => router.push(`/documents/${documentId}`), [router, documentId]);

  if (phase === 'loading' && !session) return <EditorSkeleton />;
  if (phase === 'notfound') return <Inaccessible onBack={() => router.push('/search')} />;
  if (phase === 'error') {
    return (
      <div>
        <PageHeader
          icon="document"
          title="Éditeur indisponible"
          breadcrumb={[{ label: 'Recherche', href: '/search' }, { label: 'Éditeur' }]}
          actions={<Button onClick={() => router.push('/search')}>Retour</Button>}
        />
        <Alert
          type="error"
          showIcon
          message="Le document n’a pas pu être chargé."
          description={error}
          action={<Button onClick={() => void load()}>Réessayer</Button>}
        />
      </div>
    );
  }
  if (!session) return <EditorSkeleton />;

  return (
    <>
      {phase === 'loading' && <EditorSkeleton />}
      {/* `key` : une session rechargée (restauration, import) repart d'un Y.Doc et d'un provider neufs. */}
      <div hidden={phase === 'loading'}>
        <EditorSession key={epoch} session={session} onReset={() => void load()} onBack={back} />
      </div>
    </>
  );
}

function EditorSession({
  session,
  onReset,
  onBack,
}: {
  session: GedCollabSession;
  onReset: () => void;
  onBack: () => void;
}) {
  const { documentId } = session;
  const [collab, setCollab] = useState<{ ydoc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [everConnected, setEverConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [unsynced, setUnsynced] = useState(0);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [inaccessible, setInaccessible] = useState(false);
  const [banner, setBanner] = useState<CloseBanner | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  const attemptsRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);
  const clearStable = useCallback(() => {
    if (stableTimerRef.current) clearTimeout(stableTimerRef.current);
    stableTimerRef.current = null;
  }, []);

  /** Reconnexion manuelle après abandon : le compteur repart à zéro. */
  const reconnect = useCallback(() => {
    clearRetry();
    attemptsRef.current = 0;
    setBanner(null);
    providerRef.current?.connect();
  }, [clearRetry]);

  useEffect(() => {
    attemptsRef.current = 0;
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: deriveWsUrl(session.wsPath, window.location, process.env.NEXT_PUBLIC_COLLAB_WS_URL),
      name: String(documentId),
      document: ydoc,
      // Fonction : le jeton est relu à chaque (re)connexion ; il voyage dans le protocole, pas dans l'URL.
      token: () => readToken(),
      onStatus: ({ status }) => {
        if (status === WebSocketStatus.Connected) {
          setConn('connected');
          setEverConnected(true);
          // Connexion stable : le compteur de tentatives repart à zéro.
          clearStable();
          stableTimerRef.current = setTimeout(() => {
            attemptsRef.current = 0;
            stableTimerRef.current = null;
          }, STABLE_CONNECTION_MS);
        } else {
          clearStable();
          setConn(status === WebSocketStatus.Connecting ? 'connecting' : 'disconnected');
        }
      },
      onSynced: ({ state }) => setSynced(state),
      onUnsyncedChanges: ({ number }) => setUnsynced(number),
      onAuthenticationFailed: () => {
        setInaccessible(true);
        provider.disconnect();
      },
      onClose: ({ event }) => {
        const kind = interpretCloseCode(event?.code, event?.reason);
        if (kind === 'session-expired') {
          provider.disconnect();
          redirectToLogin();
        } else if (kind === 'unauthorized') {
          setInaccessible(true);
          provider.disconnect(); // pas de boucle de reconnexion sur un refus
        } else if (kind === 'structure') {
          // Jamais de reconnexion automatique : le Y.Doc local contient la modification refusée.
          provider.disconnect();
          clearRetry();
          setBanner({ type: 'structure' });
        } else if (kind === 'limit') {
          provider.disconnect(); // coupe la reconnexion automatique du provider (une par seconde)
          clearRetry();
          const action = closeAction(kind, attemptsRef.current);
          if (typeof action === 'object') {
            attemptsRef.current = action.attempt;
            const deadline = Date.now() + action.retryInMs;
            const remaining = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            setBanner({ type: 'retry', attempt: action.attempt, seconds: remaining() });
            retryTimerRef.current = setInterval(() => {
              const seconds = remaining();
              if (seconds > 0) {
                setBanner({ type: 'retry', attempt: action.attempt, seconds });
                return;
              }
              clearRetry();
              setBanner(null);
              provider.connect();
            }, 1000);
          } else {
            setBanner({ type: 'giveup' });
          }
        } else if (docRecreation(kind) === 'immediate') {
          provider.disconnect();
          onResetRef.current(); // salle réinitialisée : on recharge la session puis on se reconnecte
        }
      },
      onAwarenessChange: ({ states }) => {
        const seen = new Map<string, PresenceUser>();
        for (const s of states) {
          const u = s.user as { name?: string; color?: string; userGroupId?: number } | undefined;
          if (!u?.name) continue;
          const key = u.userGroupId != null ? `u${u.userGroupId}` : `c${s.clientId}`;
          if (!seen.has(key)) {
            seen.set(key, {
              clientId: s.clientId,
              userGroupId: u.userGroupId ?? null,
              name: u.name,
              color: u.color ?? presenceColor(u.userGroupId ?? s.clientId),
            });
          }
        }
        setPresence([...seen.values()]);
      },
    });
    providerRef.current = provider;
    setCollab({ ydoc, provider });
    return () => {
      clearRetry();
      clearStable();
      providerRef.current = null;
      try {
        provider.destroy();
      } catch {
        /* déjà détruit */
      }
      ydoc.destroy();
      setCollab(null);
    };
  }, [documentId, session.wsPath, clearRetry, clearStable]);

  // Avertit avant de quitter avec des modifications pas encore reçues par le serveur.
  useEffect(() => {
    if (unsynced === 0) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [unsynced]);

  if (inaccessible) return <Inaccessible onBack={onBack} />;
  if (!collab) return <EditorSkeleton />;

  return (
    <EditorCanvas
      session={session}
      ydoc={collab.ydoc}
      provider={collab.provider}
      conn={conn}
      everConnected={everConnected}
      synced={synced}
      unsynced={unsynced}
      presence={presence}
      banner={banner}
      onReload={() => onResetRef.current()}
      onReconnect={reconnect}
      onBack={onBack}
    />
  );
}

function EditorCanvas({
  session,
  ydoc,
  provider,
  conn,
  everConnected,
  synced,
  unsynced,
  presence,
  banner,
  onReload,
  onReconnect,
  onBack,
}: {
  session: GedCollabSession;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  conn: ConnState;
  everConnected: boolean;
  synced: boolean;
  unsynced: number;
  presence: PresenceUser[];
  banner: CloseBanner | null;
  onReload: () => void;
  onReconnect: () => void;
  onBack: () => void;
}) {
  const { documentId, me } = session;
  const readOnly = session.mode === 'read';
  const frozen = banner?.type === 'structure';
  const { message, confirm } = useFeedback();
  const screens = Grid.useBreakpoint();
  const wide = screens.lg === true;

  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [openComments, setOpenComments] = useState(0);
  const [historyKey, setHistoryKey] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<null | 'import' | 'export'>(null);
  const [saveForm] = Form.useForm<{ summary?: string }>();
  const fileRef = useRef<HTMLInputElement>(null);

  const built = useMemo(() => {
    try {
      const base = createEditorExtensions({ mentionSuggestion: createMentionSuggestion(documentId) })
        // L'historique d'annulation est celui de la collaboration (Yjs), pas celui de ProseMirror.
        .filter((e) => e.name !== 'undoRedo' && e.name !== 'history')
        .map((e) => (e.name === 'starterKit' ? e.configure({ undoRedo: false }) : e));
      return {
        extensions: [
          ...base,
          Collaboration.configure({ document: ydoc, field: EDITOR_FRAGMENT }),
          CollaborationCaret.configure({
            provider,
            user: {
              name: me.name,
              userGroupId: me.userGroupId,
              color: presenceColor(me.userGroupId),
            },
            render: (user) => {
              const caret = document.createElement('span');
              caret.className = styles.caret ?? '';
              caret.style.borderColor = String(user.color);
              const label = document.createElement('span');
              label.className = styles.caretLabel ?? '';
              label.style.borderColor = String(user.color);
              label.textContent = String(user.name ?? '');
              caret.appendChild(label);
              return caret;
            },
            selectionRender: (user) => ({
              nodeName: 'span',
              class: styles.remoteSelection ?? '',
              style: `background-color: color-mix(in srgb, ${String(user.color)} 28%, transparent)`,
            }),
          }),
        ],
        error: null as string | null,
      };
    } catch (e) {
      return { extensions: [], error: errMsg(e, 'Éditeur indisponible.') };
    }
  }, [documentId, ydoc, provider, me.name, me.userGroupId]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: !readOnly,
      extensions: built.extensions,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': readOnly ? 'Contenu du document (lecture seule)' : 'Contenu du document',
          spellcheck: 'true',
          lang: 'fr',
        },
      },
    },
    [built],
  );

  // Modification refusée : éditeur figé jusqu'au rechargement (pas de saisie sur un état divergent).
  useEffect(() => {
    editor?.setEditable(!readOnly && !frozen);
  }, [editor, readOnly, frozen]);

  // Compteur de commentaires ouverts (badge du bouton).
  useEffect(() => {
    const map = ydoc.getMap(COMMENTS_KEY);
    const refresh = () => {
      try {
        setOpenComments(listComments(ydoc).filter((c) => !c.resolved).length);
      } catch {
        setOpenComments(0);
      }
    };
    refresh();
    map.observeDeep(refresh);
    return () => map.unobserveDeep(refresh);
  }, [ydoc]);

  const startComment = useCallback(
    (ed: Editor) => {
      const d = makeDraft(ed);
      if (!d) {
        message.info('Sélectionnez d’abord le passage à commenter.');
        return;
      }
      setDraft(d);
      setPanel('comments');
    },
    [message],
  );

  const closePanel = useCallback(() => {
    setPanel(null);
    setDraft(null);
  }, []);

  const doSave = async (summary?: string) => {
    setSaving(true);
    try {
      await waitSynced(provider);
      const r = await editeurApi.saveVersion(documentId, summary);
      if (!r.created) {
        message.info('Le contenu est identique à la version courante : aucune nouvelle version n’a été créée.');
      } else {
        message.success(
          r.version ? `Version ${r.version.versionNumber} enregistrée.` : 'Version enregistrée.',
        );
        setHistoryKey((k) => k + 1);
      }
      setSaveOpen(false);
      saveForm.resetFields();
    } catch (e) {
      message.error(errMsg(e, 'Enregistrement de la version impossible.'));
    } finally {
      setSaving(false);
    }
  };

  const onPickFile = (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) {
      message.error('Choisissez un fichier au format DOCX.');
      return;
    }
    confirm({
      title: 'Remplacer le contenu du document ?',
      content: `Le contenu actuel sera remplacé, pour toutes les personnes connectées, par celui de « ${file.name} ». Une version « Avant import DOCX » est créée automatiquement : vous pourrez la restaurer.`,
      okText: 'Remplacer le contenu',
      danger: true,
      onOk: async () => {
        setBusy('import');
        try {
          const r = await editeurApi.importDocx(documentId, file);
          message.success('Le fichier DOCX a été importé.');
          r.warnings.slice(0, 5).forEach((w) => message.warning(w));
          setHistoryKey((k) => k + 1);
        } catch (e) {
          message.error(errMsg(e, 'Import du DOCX impossible.'));
        } finally {
          setBusy(null);
        }
      },
    });
  };

  const doExport = async () => {
    setBusy('export');
    try {
      await waitSynced(provider);
      await editeurApi.exportDocx(documentId, session.label);
    } catch (e) {
      message.error(errMsg(e, 'Export du DOCX impossible.'));
    } finally {
      setBusy(null);
    }
  };

  const docMenu: MenuProps['items'] = [
    { key: 'import', label: 'Importer un DOCX…', icon: <FileUp {...ICON} />, disabled: readOnly },
    { key: 'export', label: 'Exporter en DOCX', icon: <FileDown {...ICON} /> },
  ];

  // Libellés d'état — annoncés par la région aria-live.
  const connLabel =
    conn === 'connected' ? 'Connecté' : conn === 'connecting' ? (everConnected ? 'Reconnexion…' : 'Connexion…') : 'Hors ligne';
  const dotClass = conn === 'connected' ? styles.dotOk : conn === 'connecting' ? styles.dotWait : styles.dotOff;
  const saveLabel =
    readOnly
      ? null
      : conn === 'connected' && synced && unsynced === 0
        ? 'Enregistré'
        : conn === 'connected'
          ? 'Enregistrement…'
          : unsynced > 0
            ? 'Modifications en attente de connexion'
            : null;

  const panelTitle = panel === 'history' ? 'Historique des versions' : 'Commentaires';
  const panelBody =
    panel === 'history' ? (
      <VersionHistoryPanel
        documentId={documentId}
        canRestore={!readOnly}
        refreshKey={historyKey}
        onRestored={(v) => message.success(`Version ${v.versionNumber} créée à partir de la restauration.`)}
        onError={(m) => message.error(m)}
      />
    ) : panel === 'comments' && editor ? (
      <CommentsPanel
        editor={editor}
        ydoc={ydoc}
        documentId={documentId}
        me={me}
        canWrite={!readOnly}
        draft={draft}
        onDraftDone={() => setDraft(null)}
      />
    ) : null;

  if (built.error) {
    return (
      <div>
        <PageHeader icon="document" title={session.label} actions={<Button onClick={onBack}>Retour à la fiche</Button>} />
        <Alert type="error" showIcon message="L’éditeur n’a pas pu démarrer." description={built.error} />
      </div>
    );
  }

  const toggle = (p: Exclude<Panel, null>) => {
    setDraft(null);
    setPanel((cur) => (cur === p ? null : p));
  };

  return (
    <div className={styles.shell} data-editeur-root>
      <PageHeader
        icon="document"
        title={session.label}
        breadcrumb={[
          { label: 'Recherche', href: '/search' },
          { label: `#${documentId}`, href: `/documents/${documentId}` },
          { label: 'Éditeur' },
        ]}
        actions={
          <>
            <Button icon={<icons.arrowLeft size={16} />} onClick={onBack}>
              Retour à la fiche
            </Button>
            <Button
              icon={<MessageSquare {...ICON} />}
              aria-pressed={panel === 'comments'}
              onClick={() => toggle('comments')}
            >
              Commentaires
              {openComments > 0 && (
                <Badge count={openComments} size="small" style={{ marginLeft: space.sm }} aria-label={`${openComments} ouverts`} />
              )}
            </Button>
            <Button icon={<History {...ICON} />} aria-pressed={panel === 'history'} onClick={() => toggle('history')}>
              Historique
            </Button>
            <Dropdown
              trigger={['click']}
              menu={{
                items: docMenu,
                onClick: ({ key }) => {
                  if (key === 'import') fileRef.current?.click();
                  else void doExport();
                },
              }}
            >
              <Button loading={busy !== null} aria-label="Importer ou exporter un DOCX">
                DOCX <ChevronDown {...ICON} />
              </Button>
            </Dropdown>
            {!readOnly && (
              <Button type="primary" icon={<Save {...ICON} />} onClick={() => setSaveOpen(true)}>
                Enregistrer une version
              </Button>
            )}
          </>
        }
      />

      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        aria-label="Fichier DOCX à importer"
        onChange={(e) => onPickFile(e.target.files?.[0])}
      />

      {banner?.type === 'structure' && (
        <Alert
          className={styles.banner}
          type="error"
          showIcon
          role="alert"
          message="Modification incompatible."
          description="Votre dernière modification est incompatible avec celle d’un collaborateur et n’a pas été enregistrée. Les modifications locales non synchronisées seront perdues. Rechargez le document."
          action={
            <Button type="primary" onClick={onReload}>
              Recharger
            </Button>
          }
        />
      )}
      {banner?.type === 'retry' && (
        <Alert
          className={styles.banner}
          type="warning"
          showIcon
          role="status"
          aria-live="polite"
          message="Limite de débit ou de taille atteinte."
          description={
            <>
              <span className={styles.srOnly}>
                Reconnexion automatique en cours, tentative {banner.attempt} sur {LIMIT_MAX_ATTEMPTS}.{' '}
              </span>
              <span aria-hidden="true">
                Reconnexion dans {banner.seconds} s (tentative {banner.attempt}/{LIMIT_MAX_ATTEMPTS}).
              </span>{' '}
              Vos dernières modifications n’ont peut-être pas été enregistrées.
            </>
          }
        />
      )}
      {banner?.type === 'giveup' && (
        <Alert
          className={styles.banner}
          type="error"
          showIcon
          role="alert"
          message="Connexion interrompue."
          description="La limite de débit ou de taille reste dépassée. Vos dernières modifications n’ont peut-être pas été enregistrées."
          action={<Button onClick={onReconnect}>Reconnecter</Button>}
        />
      )}

      <div className={styles.statusBar}>
        <div className={styles.statusGroup}>
          {/* Région annoncée aux lecteurs d'écran à chaque changement d'état. */}
          <span role="status" aria-live="polite">
            <span className={`${styles.dot} ${dotClass}`} aria-hidden="true" />
            {connLabel}
            {saveLabel && (
              <>
                {' · '}
                {saveLabel === 'Enregistré' && <Check size={12} aria-hidden="true" style={{ verticalAlign: '-1px' }} />}
                {saveLabel}
              </>
            )}
          </span>
          {readOnly && <strong>Lecture seule</strong>}
          <span>Version {session.currentVersionNumber}</span>
        </div>
        <ul className={styles.presence} aria-label={`Personnes connectées : ${presence.map((p) => p.name).join(', ') || 'aucune'}`}>
          {presence.slice(0, 6).map((p) => (
            <li
              key={p.clientId}
              className={styles.avatar}
              style={{ borderColor: p.color }}
              title={p.userGroupId === me.userGroupId ? `${p.name} (vous)` : p.name}
            >
              <span aria-hidden="true">{initials(p.name)}</span>
              <span className={styles.srOnly}>{p.name}</span>
            </li>
          ))}
          {presence.length > 6 && (
            <li className={`${styles.avatar} ${styles.avatarMore}`} title={presence.slice(6).map((p) => p.name).join(', ')}>
              +{presence.length - 6}
            </li>
          )}
        </ul>
      </div>

      {editor ? (
        <EditorToolbar
          editor={editor}
          readOnly={readOnly}
          canComment={!readOnly}
          onComment={() => startComment(editor)}
        />
      ) : null}

      <div className={styles.body}>
        <div className={styles.main}>
          <div className={`${styles.paper} ${readOnly ? styles.paperReadonly : ''}`}>
            {editor ? <EditorContent editor={editor} /> : <Skeleton active paragraph={{ rows: 8 }} />}
          </div>
        </div>

        {wide && panel && (
          <aside
            className={styles.aside}
            aria-label={panelTitle}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closePanel();
            }}
          >
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>{panelTitle}</h2>
              <Button type="text" size="small" aria-label="Fermer le panneau" icon={<X {...ICON} />} onClick={closePanel} />
            </div>
            <div className={styles.panelBody}>{panelBody}</div>
          </aside>
        )}
      </div>

      {!wide && (
        <Drawer
          title={panelTitle}
          placement="right"
          width="min(420px, 100vw)"
          open={panel !== null}
          onClose={closePanel}
          destroyOnHidden
          keyboard
        >
          {panelBody}
        </Drawer>
      )}

      <Modal
        title="Enregistrer une version"
        open={saveOpen}
        okText="Enregistrer"
        cancelText="Annuler"
        confirmLoading={saving}
        onCancel={() => !saving && setSaveOpen(false)}
        onOk={() => saveForm.submit()}
        destroyOnHidden
        forceRender
      >
        <Form form={saveForm} layout="vertical" onFinish={(v) => void doSave(v.summary)}>
          <Form.Item
            name="summary"
            label="Résumé des modifications (facultatif)"
            extra="Si le contenu est identique à la version courante, aucune version n’est créée."
          >
            <Input.TextArea rows={3} maxLength={300} showCount placeholder="Ex. : relecture du chapitre 2" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
