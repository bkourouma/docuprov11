import type { ReactNode } from 'react';
import type { WfBudgetDto } from '@archivage/types';
import { icons, iconDefaults } from '../../../../theme/icons';
import {
  consumptionLevel,
  formatAmount,
  formatTokens,
  periodKindLabel,
  type ConsumptionLevelKey,
} from '../../../_lib/budget-logic';
import { formatDateTime } from '../../../_lib/format';
import { progressPercent, progressText, stopAuthorText, thresholdToPercentText } from './budget-view-logic';

const LEVEL_WORD: Record<ConsumptionLevelKey, string> = { ok: 'ok', attention: 'attention', depasse: 'dépassé' };

/**
 * Carte de consommation d'une ligne de budget (globale ou d'un workflow).
 * Sans état ni effet (rendu statique testable). Tout texte venant de l'API (motif d'arrêt) est du texte brut.
 * Le niveau n'est jamais porté par la couleur seule : mot + icône + pourcentage écrit.
 */
export function ConsumptionCard({
  budget,
  title,
  headingId,
  actions,
}: {
  budget: WfBudgetDto;
  title: string;
  headingId: string;
  actions?: ReactNode;
}) {
  const lvl = consumptionLevel(budget);
  const hasCap = budget.capAmount !== null;
  const bar = progressPercent(lvl.ratio);
  const text = progressText(lvl.ratio);
  const Glyph = lvl.level === 'ok' ? icons.check : icons.alert;
  const thresholdPct = thresholdToPercentText(budget.alertThreshold);

  return (
    <article className={`wfp-card wfp-level-${lvl.level}`} aria-labelledby={headingId} data-level={lvl.level}>
      <header className="wfp-card-head">
        <h3 id={headingId} className="wfp-card-title">
          {title}
        </h3>
        <span className={`wfp-badge wfp-badge-${lvl.level}`}>
          <Glyph size={14} strokeWidth={iconDefaults.strokeWidth} aria-hidden="true" />
          <span>
            {hasCap ? `Niveau ${LEVEL_WORD[lvl.level]} : ` : ''}
            {lvl.label}
          </span>
        </span>
      </header>

      {budget.emergencyStop && (
        <p className="wfp-stop-flag" role="status">
          <strong>Arrêt d’urgence actif.</strong> Par {stopAuthorText(budget.emergencyStopBy)}, le{' '}
          {formatDateTime(budget.emergencyStopAt)}.
          {budget.emergencyStopReason ? <> Motif : {budget.emergencyStopReason}</> : <> Aucun motif indiqué.</>}
        </p>
      )}

      {hasCap ? (
        <div className="wfp-progress-block">
          <div
            className="wfp-progress"
            role="progressbar"
            aria-label={`Consommation du plafond : ${title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={bar}
            aria-valuetext={text}
          >
            <div className={`wfp-progress-fill wfp-fill-${lvl.level}`} style={{ width: `${bar}%` }} />
          </div>
          <p className="wfp-progress-text">{text}</p>
        </div>
      ) : (
        <p className="wfp-progress-text">Aucun plafond défini : la consommation n’est pas limitée.</p>
      )}

      <dl className="wfp-facts">
        <div>
          <dt>Plafond</dt>
          <dd>{hasCap ? formatAmount(budget.capAmount, budget.currency) : 'Aucun plafond'}</dd>
        </div>
        <div>
          <dt>Consommé</dt>
          <dd>{formatAmount(budget.consumedAmount, budget.currency)}</dd>
        </div>
        <div>
          <dt>Jetons consommés</dt>
          <dd>{formatTokens(budget.consumedTokens)}</dd>
        </div>
        <div>
          <dt>Période</dt>
          <dd>{periodKindLabel(budget.periodKind)}</dd>
        </div>
        <div>
          <dt>Seuil d’alerte (indicatif)</dt>
          <dd>{thresholdPct === '' ? '—' : `${thresholdPct} %`}</dd>
        </div>
        <div>
          <dt>Devise</dt>
          <dd>{budget.currency}</dd>
        </div>
      </dl>

      {actions && <div className="wfp-actions">{actions}</div>}
    </article>
  );
}
