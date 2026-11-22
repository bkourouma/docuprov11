'use client';

import { Tag } from 'antd';
import type { WfEvalRunDto } from '@archivage/types';
import { formatDateTime } from '../../../_lib/format';
import { evalRunVerdict, formatAccuracy, perCaseResults, type VerdictTone } from '../../../_lib/eval-logic';
import { formatCost } from './evaluation-view-logic';

const TONE_COLOR: Record<VerdictTone, string> = { success: 'success', error: 'error', info: 'processing', warning: 'warning' };

export interface RunsListProps {
  runs: readonly WfEvalRunDto[];
  /** Libellés des cas par identifiant. */
  caseLabels: ReadonlyMap<number, string>;
  /** Tableau (grand écran) ou cartes (sous 768 px). */
  layout: 'table' | 'cards';
}

function CaseDetails({ run, caseLabels }: { run: WfEvalRunDto; caseLabels: ReadonlyMap<number, string> }) {
  const results = perCaseResults(run.results);
  if (results.length === 0) return <span className="wf-muted">Pas de détail par cas.</span>;
  return (
    <details className="wfev-details">
      <summary>Détail par cas ({results.length})</summary>
      <ul className="wfev-case-results">
        {results.map((r, i) => {
          const name = (r.caseId !== undefined ? caseLabels.get(r.caseId) : undefined) ?? r.label ?? (r.caseId !== undefined ? `Cas n° ${r.caseId}` : `Cas ${i + 1}`);
          return (
            <li key={`${r.caseId ?? 'x'}-${i}`}>
              <span className="wfev-text">{name}</span> : <strong>{r.passed ? 'Réussi' : 'Échoué'}</strong>
              {r.reason ? <span className="wfev-text"> ({r.reason})</span> : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Verdict({ run }: { run: WfEvalRunDto }) {
  const v = evalRunVerdict(run);
  return (
    <div>
      <Tag color={TONE_COLOR[v.tone]}>{v.label}</Tag>
      <span className="wfev-text wfev-verdict-detail">{v.detail}</span>
    </div>
  );
}

function RunError({ run }: { run: WfEvalRunDto }) {
  if (!run.errorMessage || run.errorMessage.trim() === '') return null;
  // Texte brut : jamais de HTML.
  return <p className="wfev-text wfev-run-error">Message d’erreur : {run.errorMessage}</p>;
}

/** Historique des runs : tableau avec en-têtes, ou cartes. Tout texte venant de l'API est affiché en texte brut. */
export function RunsList({ runs, caseLabels, layout }: RunsListProps) {
  if (runs.length === 0) {
    return <p className="wf-muted">Aucune évaluation lancée pour ce jeu.</p>;
  }

  if (layout === 'cards') {
    return (
      <ul className="wfev-cards" aria-label="Historique des évaluations">
        {runs.map((run) => {
          const cost = formatCost(run.costAmount);
          return (
            <li key={run.wfEvalRunId} className="wf-card wfev-card">
              <Verdict run={run} />
              <dl className="wfev-dl">
                <dt>Début</dt>
                <dd>{formatDateTime(run.startedAt)}</dd>
                <dt>Précision obtenue</dt>
                <dd>{formatAccuracy(run.accuracy)}</dd>
                <dt>Précision requise</dt>
                <dd>{formatAccuracy(run.requiredAccuracy)}</dd>
                {cost && (
                  <>
                    <dt>Coût</dt>
                    <dd>{cost}</dd>
                  </>
                )}
              </dl>
              <RunError run={run} />
              <CaseDetails run={run} caseLabels={caseLabels} />
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="wfev-table-wrap">
      <table className="wfev-table">
        <caption className="wf-sr-only">Historique des évaluations, du plus récent au plus ancien</caption>
        <thead>
          <tr>
            <th scope="col">Début</th>
            <th scope="col">Verdict</th>
            <th scope="col">Précision obtenue</th>
            <th scope="col">Précision requise</th>
            <th scope="col">Coût</th>
            <th scope="col">Détail</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.wfEvalRunId}>
              <td>{formatDateTime(run.startedAt)}</td>
              <td>
                <Verdict run={run} />
                <RunError run={run} />
              </td>
              <td>{formatAccuracy(run.accuracy)}</td>
              <td>{formatAccuracy(run.requiredAccuracy)}</td>
              <td>{formatCost(run.costAmount) ?? '—'}</td>
              <td>
                <CaseDetails run={run} caseLabels={caseLabels} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
