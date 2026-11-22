'use client';

// Panneau global de l'assistant : Drawer AntD à droite (plein écran sur mobile). Ce composant assemble l'état
// (useAssistantChat) et les composants présentationnels ; il ne contient aucune règle métier.
// Il reste monté tant que l'utilisateur détient le menu : l'état du chat survit à la fermeture du panneau.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Drawer, Grid, Skeleton } from 'antd';
import type { AsstPageContext } from '@archivage/types';
import { icons } from '../../theme/icons';
import { ConversationList } from './ConversationList';
import { MessageInput } from './MessageInput';
import { MessageThread } from './MessageThread';
import { UiErrorBanner } from './UiErrorBanner';
import { ASSISTANT_SHORTCUT_LABEL } from './_lib/composer-logic';
import { useAssistantChat } from './useAssistantChat';
import './assistant-card.css';
import './assistant.css';

export interface AssistantDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Contexte de la page courante (donnée, jamais consigne) ; null si aucune route exploitable. */
  pageContext: AsstPageContext | null;
}

export function AssistantDrawer({ open, onClose, pageContext }: AssistantDrawerProps) {
  const screens = Grid.useBreakpoint();
  // Plein écran sous 768 px ; sinon 480 px (jamais plus large que l'écran).
  const fullScreen = !screens.md;
  const chat = useAssistantChat({ open, pageContext });
  const { state } = chat;
  const [draft, setDraft] = useState('');
  const [announce, setAnnounce] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const startedRef = useRef(false);
  const lastAssistantRef = useRef<string | null>(null);

  // À la première ouverture : on démarre sur un échange vierge (la liste reste à un clic).
  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true;
      chat.newConversation();
    }
  }, [open, chat]);

  const messages = state.current.messages;
  const lastAssistant = [...messages].reverse().find((m) => m.role === 1) ?? null;

  // Annonce vocale (texte constant) à l'arrivée d'une NOUVELLE réponse, jamais pour l'historique chargé.
  useEffect(() => {
    const id = lastAssistant?.messageId ?? null;
    if (lastAssistantRef.current !== null && id !== null && id !== lastAssistantRef.current && state.send.status === 'idle') {
      setAnnounce('Nouvelle réponse de l’assistant.');
    } else if (id !== lastAssistantRef.current) {
      setAnnounce('');
    }
    lastAssistantRef.current = id;
  }, [lastAssistant?.messageId, state.send.status]);

  // Fil : on suit le bas à chaque nouveau message ou état d'attente.
  useEffect(() => {
    if (open && state.view === 'chat') endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [open, state.view, messages.length, state.send.status]);

  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  const submit = (text: string) => {
    chat.send(text);
    setDraft('');
  };

  const inChat = state.view === 'chat';
  const blocked = state.blocked;

  const title = (
    <span className="asst-drawer-title">
      <icons.sparkle size={18} strokeWidth={1.75} aria-hidden="true" />
      <span>Assistant</span>
    </span>
  );

  const extra = inChat ? (
    <div className="asst-drawer-actions">
      <Button type="text" onClick={chat.openList}>
        Mes échanges
      </Button>
      <Button type="text" onClick={chat.newConversation}>
        Nouvel échange
      </Button>
    </div>
  ) : null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      width={fullScreen ? '100%' : 480}
      title={title}
      extra={extra}
      closeIcon={undefined}
      aria-label="Assistant"
      afterOpenChange={(visible) => {
        if (visible && state.view === 'chat') focusInput();
      }}
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } }}
    >
      <div className="asst-panel">
        {!inChat ? (
          <ConversationList
            items={state.list.items}
            total={state.list.total}
            status={state.list.status}
            error={state.list.error}
            selectedId={state.current.conversation?.conversationId ?? null}
            nowMs={chat.nowMs}
            onOpen={chat.openConversation}
            onDelete={(id) => void chat.deleteConversation(id)}
            onNew={chat.newConversation}
            onRetry={chat.reloadList}
            deleteError={state.deleteError}
            onDismissDeleteError={chat.clearDeleteError}
          />
        ) : (
          <>
            {state.current.status === 'loading' && messages.length === 0 ? (
              <div className="asst-panel-loading" aria-busy="true">
                <Skeleton active paragraph={{ rows: 4 }} />
              </div>
            ) : state.current.status === 'error' && state.current.error ? (
              <div className="asst-panel-banner">
                <UiErrorBanner
                  error={state.current.error}
                  onRetry={() => {
                    const id = state.current.conversation?.conversationId;
                    if (id) chat.openConversation(id);
                    else chat.openList();
                  }}
                />
              </div>
            ) : (
              <MessageThread
                messages={messages}
                pageContext={pageContext}
                pendingText={state.send.pendingText}
                sending={state.send.status === 'sending'}
                blocked={blocked !== null}
                nowMs={chat.nowMs}
                proposals={state.proposals}
                announce={announce}
                onConfirm={chat.confirm}
                onRefuse={chat.refuse}
                onReload={chat.reloadProposal}
                onChoose={submit}
                endRef={endRef}
              />
            )}

            {state.send.status === 'error' && state.send.error && (
              <div className="asst-panel-banner">
                <UiErrorBanner error={state.send.error} onRetry={chat.retrySend} retryLabel="Renvoyer le message" />
              </div>
            )}
            {blocked && (
              <div className="asst-panel-banner">
                <UiErrorBanner error={blocked} />
              </div>
            )}

            <MessageInput
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              sending={state.send.status === 'sending'}
              blocked={blocked !== null}
              blockedMessage={blocked?.message ?? null}
              onCancel={chat.cancelSend}
              autoFocus={open}
              inputRef={inputRef}
            />
          </>
        )}
        <p className="asst-panel-hint">Raccourci : {ASSISTANT_SHORTCUT_LABEL}. Rien n’est appliqué sans votre confirmation.</p>
      </div>
    </Drawer>
  );
}
