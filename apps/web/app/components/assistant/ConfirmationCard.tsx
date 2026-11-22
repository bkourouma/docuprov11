'use client';

// Carte de confirmation d'une proposition de l'assistant (docs/assistant-api.md, section 3).
// CSS : ./assistant-card.css (importé par le drawer, pas ici).
//
// Composant SANS état : l'horloge (`nowMs`) et le verrou d'envoi (`busy`) viennent du parent. Il n'a ni minuteur ni
// Date.now. Tout texte venant du serveur ou du modèle est rendu comme TEXTE (React l'échappe) : aucun
// innerHTML, aucun lien. Il ne confirme jamais seul : `onConfirm` n'est appelé que par le clic sur « Confirmer ».
import { useEffect, useId, useRef } from 'react';
import { Button } from 'antd';
import { ASST_PROPOSAL_STATUS_LABELS, type AsstProposalDto, type AsstProposalStatus } from '@archivage/types';
import {
  canConfirm,
  canRefuse,
  cardPhase,
  cardWarnings,
  describeAction,
  describeEffect,
  formatCountdown,
  formatExpiryClock,
  remainingSeconds,
  type ActionView,
  type CardNotice,
  type CardPhase,
  type Row,
} from './_lib/proposal-logic';

export interface ConfirmationCardProps {
  proposal: AsstProposalDto;
  /** Horloge fournie par le parent (tick 1 s). */
  nowMs: number;
  /** Appel en cours (verrou d'envoi côté parent). */
  busy: null | 'confirm' | 'refuse';
  notice?: CardNotice | null;
  onConfirm: () => void;
  onRefuse: (reason?: string) => void;
  onReload?: () => void;
  headingLevel?: 3 | 4;
}

const LIVE_TEXT: Record<CardPhase, string> = {
  proposed: '',
  confirming: 'Application en cours.',
  applied: 'Proposition appliquée.',
  refused: 'Proposition refusée.',
  expired: 'Proposition expirée.',
  failed: 'Échec de l’application.',
};

/** Badge d'état dérivé de la PHASE (et non du statut brut) : pendant un envoi, jamais « Expirée ». */
const PHASE_STATUS: Record<CardPhase, AsstProposalStatus> = {
  proposed: 0,
  confirming: 1,
  applied: 2,
  refused: 3,
  expired: 4,
  failed: 5,
};

function failureMessage(p: AsstProposalDto): string {
  if (typeof p.errorMessage === 'string' && p.errorMessage.trim() !== '') return p.errorMessage;
  if (p.errorCode === 'effect_forbidden') return 'Vous n’avez pas les droits nécessaires pour appliquer cette action.';
  return 'L’application n’a pas pu appliquer cette action. Aucune nouvelle tentative automatique ne sera faite.';
}

function Rows({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="asst-card-rows">
      {rows.map((r, i) => (
        <div className="asst-card-row" key={`${i}-${r.label}`}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActionItem({ view }: { view: ActionView }) {
  return (
    <li className="asst-card-action">
      <p className="asst-card-action-title">{view.title}</p>
      <Rows rows={view.rows} />
      {view.items && view.items.length > 0 && (
        <ul className="asst-card-recipients">
          {view.items.map((it, i) => (
            <li key={`${i}-${it.title}`} className="asst-card-recipient">
              <p className="asst-card-recipient-title">{it.title}</p>
              <Rows rows={it.rows} />
            </li>
          ))}
        </ul>
      )}
      {view.note && <p className="asst-card-action-note">{view.note}</p>}
    </li>
  );
}

export function ConfirmationCard({
  proposal,
  nowMs,
  busy,
  notice,
  onConfirm,
  onRefuse,
  onReload,
  headingLevel = 4,
}: ConfirmationCardProps) {
  const titleId = `asst-card-title-${useId()}`;
  const phase = cardPhase(proposal, nowMs, busy);
  const remaining = remainingSeconds(proposal.expiresAt, nowMs);
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const actions = Array.isArray(proposal.actions) ? proposal.actions : [];
  const pending = phase === 'proposed' || phase === 'confirming';
  // Carte expirée (ou terminée) : aucun bouton (contrat §3.2 et §3.3).
  const showButtons = pending;
  const warnings = pending ? cardWarnings(actions, { remainingSec: remaining }) : [];
  const effects = proposal.result && Array.isArray(proposal.result.effects) ? proposal.result.effects : [];
  // Après un échec de relecture, le contenu affiché est peut-être périmé : pas de confirmation avant rechargement.
  const stale = notice?.kind === 'reload-needed';
  const confirmable = canConfirm(proposal, nowMs, busy) && !stale;
  const refusable = canRefuse(proposal, nowMs, busy);

  // Focus : quand la phase change après une action, les boutons se désactivent ou disparaissent et le focus
  // tomberait sur <body>. On le replace sur la carte, sans jamais le voler à un autre champ (changement d'horloge).
  const cardRef = useRef<HTMLElement | null>(null);
  const prevPhase = useRef<CardPhase>(phase);
  useEffect(() => {
    if (prevPhase.current === phase) return;
    prevPhase.current = phase;
    const card = cardRef.current;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (card && (active === null || active === document.body || card.contains(active))) card.focus();
  }, [phase]);

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      className={`asst-card asst-card--${phase}`}
      role="region"
      aria-labelledby={titleId}
    >
      <header className="asst-card-head">
        <Heading id={titleId} className="asst-card-title">
          Action proposée
        </Heading>
        <span className={`asst-card-pill asst-card-pill--${phase}`}>
          {ASST_PROPOSAL_STATUS_LABELS[PHASE_STATUS[phase]]}
        </span>
      </header>

      <div className="asst-card-live" aria-live="polite" aria-atomic="true">
        {LIVE_TEXT[phase]}
      </div>

      {pending && (
        <p className="asst-card-info">Cette proposition n’a aucun effet tant que vous ne l’avez pas confirmée.</p>
      )}

      {typeof proposal.summary === 'string' && proposal.summary.trim() !== '' && (
        <p className="asst-card-summary">{proposal.summary}</p>
      )}

      {actions.length > 0 && (
        <ol className="asst-card-actions">
          {actions.map((a, i) => (
            <ActionItem key={i} view={describeAction(a)} />
          ))}
        </ol>
      )}

      {warnings.length > 0 && (
        <div className="asst-card-warnings" role="note">
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {phase === 'proposed' && (
        <p className="asst-card-deadline">
          Valable jusqu’à {formatExpiryClock(proposal.expiresAt)}
          {' · '}
          <span role="timer" className="asst-card-countdown">
            {formatCountdown(remaining)}
          </span>
        </p>
      )}

      {phase === 'confirming' && <p className="asst-card-state">Application en cours…</p>}

      {phase === 'applied' && (
        <div className="asst-card-state">
          <p className="asst-card-state-title">Appliquée</p>
          {effects.length > 0 && (
            <ul className="asst-card-effects">
              {effects.map((e, i) => {
                const d = describeEffect(e);
                return (
                  <li key={i} className="asst-card-effect">
                    <p className="asst-card-effect-title">{d.title}</p>
                    <Rows rows={d.rows} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {phase === 'refused' && (
        <p className="asst-card-state">Refusée — aucune action n’a été appliquée.</p>
      )}

      {phase === 'expired' && (
        <div className="asst-card-state">
          <p className="asst-card-state-title">Expirée — reformulez votre demande.</p>
          <p>Reformulez votre demande pour obtenir une nouvelle proposition.</p>
        </div>
      )}

      {phase === 'failed' && (
        <div className="asst-card-state">
          <p className="asst-card-state-title">Échec</p>
          <p className="asst-card-error-text">{failureMessage(proposal)}</p>
        </div>
      )}

      {notice && (
        <div className={`asst-card-notice asst-card-notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <p>{notice.message}</p>
          {onReload && notice.kind === 'reload-needed' && (
            <Button className="asst-card-btn" onClick={() => onReload()}>
              Recharger la proposition
            </Button>
          )}
        </div>
      )}

      {showButtons && (
        <div className="asst-card-buttons">
          <Button
            type="primary"
            className="asst-card-btn"
            htmlType="button"
            disabled={!confirmable}
            aria-disabled={!confirmable || undefined}
            loading={busy === 'confirm'}
            onClick={() => {
              if (canConfirm(proposal, nowMs, busy)) onConfirm();
            }}
          >
            Confirmer
          </Button>
          <Button
            className="asst-card-btn"
            htmlType="button"
            disabled={!refusable}
            aria-disabled={!refusable || undefined}
            loading={busy === 'refuse'}
            onClick={() => {
              if (canRefuse(proposal, nowMs, busy)) onRefuse();
            }}
          >
            Refuser
          </Button>
        </div>
      )}
    </section>
  );
}
