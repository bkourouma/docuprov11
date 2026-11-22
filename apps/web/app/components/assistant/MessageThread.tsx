'use client';

// Fil d'une conversation. Présentationnel : aucun effet, aucun minuteur ; le défilement est géré par le parent
// via `endRef`. Tout contenu venant du modèle/serveur est rendu en TEXTE BRUT (jamais de HTML, de Markdown
// interprété ni de lien actif : les URL restent du texte).
import type { Ref } from 'react';
import { AsstMessageRole } from '@archivage/types';
import type { AsstMessageDto, AsstPageContext } from '@archivage/types';
import { ClarificationChoices } from './ClarificationChoices';
import { ConfirmationCard } from './ConfirmationCard';
import { formatTimeFr, readClarification } from './_lib/conversation-logic';
import { describePageContext } from './_lib/page-context';
import type { Busy, CardNotice } from './_lib/proposal-logic';

export interface MessageThreadProps {
  messages: AsstMessageDto[];
  pageContext: AsstPageContext | null;
  pendingText: string | null;
  sending: boolean;
  blocked: boolean;
  nowMs: number;
  proposals: Record<string, { busy: Busy; notice: CardNotice | null }>;
  /** Texte annoncé aux lecteurs d'écran (zone polie) ; vide = rien à annoncer. Fourni par le parent. */
  announce: string;
  onConfirm: (proposalId: string) => void;
  onRefuse: (proposalId: string) => void;
  onReload: (proposalId: string) => void;
  onChoose: (choice: string) => void;
  endRef?: Ref<HTMLDivElement>;
}

const EXAMPLES = [
  'Impute ce courrier à la DAF sous 3 jours',
  'Relance le service concerné pour ce courrier en retard',
  'Prépare un brouillon de réponse à ce courrier',
];

export function MessageThread({
  messages,
  pageContext,
  pendingText,
  sending,
  blocked,
  nowMs,
  proposals,
  announce,
  onConfirm,
  onRefuse,
  onReload,
  onChoose,
  endRef,
}: MessageThreadProps) {
  const ctx = describePageContext(pageContext);
  const empty = messages.length === 0 && pendingText === null;
  const lastIndex = messages.length - 1;
  return (
    <div className="asst-thread" role="group" aria-label="Fil de la conversation" tabIndex={0}>
      {ctx && <p className="asst-thread-context">Contexte : {ctx}</p>}

      {empty && (
        <div className="asst-empty">
          <p className="asst-empty-title">Que souhaitez-vous faire ?</p>
          <p className="asst-empty-text">Posez une question ou demandez une action. Par exemple :</p>
          <ul className="asst-examples">
            {EXAMPLES.map((e) => (
              <li key={e} className="asst-example">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      {messages.map((m, i) => {
        const isUser = m.role === AsstMessageRole.User;
        const clar = i === lastIndex ? readClarification(m) : null;
        return (
          <div key={m.messageId} className="asst-msg-wrap">
            <article
              className={`asst-msg ${isUser ? 'asst-msg--user' : 'asst-msg--assistant'}`}
              aria-label={isUser ? 'Vous' : 'Assistant'}
            >
              <header className="asst-msg-head">
                <span className="asst-msg-who">{isUser ? 'Vous' : 'Assistant'}</span>
                <span className="asst-msg-time">{formatTimeFr(m.createdAt)}</span>
              </header>
              <p className="asst-msg-text">{m.content}</p>
            </article>
            {!isUser &&
              m.proposals.map((p) => (
                <ConfirmationCard
                  key={p.proposalId}
                  proposal={p}
                  nowMs={nowMs}
                  busy={proposals[p.proposalId]?.busy ?? null}
                  notice={proposals[p.proposalId]?.notice ?? null}
                  onConfirm={() => onConfirm(p.proposalId)}
                  onRefuse={() => onRefuse(p.proposalId)}
                  onReload={() => onReload(p.proposalId)}
                />
              ))}
            {clar && (
              <ClarificationChoices
                question={clar.question}
                choices={clar.choices}
                disabled={sending || blocked}
                onChoose={onChoose}
              />
            )}
          </div>
        );
      })}

      {pendingText !== null && sending && (
        <article className="asst-msg asst-msg--user asst-msg--pending" aria-label="Vous" aria-busy="true">
          <header className="asst-msg-head">
            <span className="asst-msg-who">Vous</span>
            <span className="asst-msg-time">Envoi…</span>
          </header>
          <p className="asst-msg-text">{pendingText}</p>
        </article>
      )}

      {sending && (
        <p className="asst-thinking" role="status">
          L’assistant réfléchit…
        </p>
      )}

      <div className="asst-sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      <div ref={endRef} className="asst-thread-end" />
    </div>
  );
}
