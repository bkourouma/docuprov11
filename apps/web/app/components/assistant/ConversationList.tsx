'use client';

// Liste des échanges avec l'assistant. Présentationnel : l'état et les actions viennent du parent.
// Les titres viennent du serveur/modèle : rendus en TEXTE uniquement (aucun lien, aucun HTML).
import { Button, Popconfirm, Skeleton } from 'antd';
import type { AsstConversationDto } from '@archivage/types';
import { conversationTitle, formatDateTimeFr, relativePurgeLabel } from './_lib/conversation-logic';
import type { UiError } from './_lib/ui-error';
import { UiErrorBanner } from './UiErrorBanner';

export interface ConversationListProps {
  items: AsstConversationDto[];
  total: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: UiError | null;
  selectedId: string | null;
  nowMs: number;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onRetry: () => void;
  /** Échec de la dernière suppression (affiché au-dessus de la liste). */
  deleteError?: UiError | null;
  onDismissDeleteError?: () => void;
}

function countLabel(n: number): string {
  return n > 1 ? `${n} messages` : `${n} message`;
}

export function ConversationList({
  items,
  total,
  status,
  error,
  selectedId,
  nowMs,
  onOpen,
  onDelete,
  onNew,
  onRetry,
  deleteError = null,
  onDismissDeleteError,
}: ConversationListProps) {
  const loading = status === 'loading' || status === 'idle';
  const hasItems = items.length > 0;
  return (
    <section className="asst-list" aria-label="Vos échanges" aria-busy={loading || undefined}>
      <header className="asst-list-head">
        <h2 className="asst-list-title">Vos échanges</h2>
        <Button type="primary" className="asst-btn" htmlType="button" onClick={() => onNew()}>
          Nouvel échange
        </Button>
      </header>

      {deleteError && (
        <div className="asst-list-delete-error">
          <UiErrorBanner error={{ ...deleteError, message: `Suppression impossible. ${deleteError.message}` }} />
          {onDismissDeleteError && (
            <Button type="text" className="asst-btn" htmlType="button" onClick={() => onDismissDeleteError()}>
              Masquer ce message
            </Button>
          )}
        </div>
      )}

      {status === 'error' && error && <UiErrorBanner error={error} onRetry={onRetry} />}

      {loading && !hasItems && (
        <div className="asst-list-loading">
          <Skeleton active paragraph={{ rows: 3 }} />
        </div>
      )}

      {status === 'ready' && !hasItems && (
        <div className="asst-empty">
          <p className="asst-empty-text">
            Aucun échange pour l’instant. Posez une question ou demandez une action, par exemple « impute ce courrier
            à la DAF sous 3 jours ».
          </p>
          <Button type="primary" className="asst-btn" htmlType="button" onClick={() => onNew()}>
            Nouvel échange
          </Button>
        </div>
      )}

      {hasItems && (
        <ul className="asst-list-items">
          {items.map((c) => {
            const title = conversationTitle(c);
            const selected = c.conversationId === selectedId;
            return (
              <li key={c.conversationId} className={`asst-item${selected ? ' asst-item--selected' : ''}`}>
                <button
                  type="button"
                  className="asst-item-open"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onOpen(c.conversationId)}
                >
                  <span className="asst-item-title">{title}</span>
                  <span className="asst-item-meta">
                    {formatDateTimeFr(c.lastMessageAt)} · {countLabel(c.messageCount)}
                  </span>
                  <span className="asst-item-purge">{relativePurgeLabel(c.purgeAt, nowMs)}</span>
                </button>
                <Popconfirm
                  title="Supprimer cet échange ?"
                  description="Il disparaîtra de votre liste. Les actions déjà appliquées ne sont pas annulées."
                  okText="Supprimer"
                  cancelText="Annuler"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => onDelete(c.conversationId)}
                >
                  <button type="button" className="asst-item-delete" aria-label={`Supprimer l’échange ${title}`}>
                    Supprimer
                  </button>
                </Popconfirm>
              </li>
            );
          })}
        </ul>
      )}

      {hasItems && total > items.length && <p className="asst-list-total">{total} échanges au total</p>}
    </section>
  );
}
