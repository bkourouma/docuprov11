'use client';

import { Alert, Button, Tag } from 'antd';
import type { WfEvalCaseDto, WfEvalSetDto } from '@archivage/types';
import { EVAL_MAX_ACTIVE_CASES, canAddCase } from '../../../_lib/eval-logic';
import { activeCaseCount } from './evaluation-view-logic';

export interface EvalCasesPanelProps {
  set: WfEvalSetDto;
  /** null = chargement. */
  cases: readonly WfEvalCaseDto[] | null;
  error: string | null;
  actionError: string | null;
  busyCaseId: number | null;
  isDesktop: boolean;
  onAdd: () => void;
  onEdit: (c: WfEvalCaseDto) => void;
  onDeactivate: (c: WfEvalCaseDto) => void;
  onReactivate: (c: WfEvalCaseDto) => void;
  onRetry: () => void;
}

/** Cas du jeu sélectionné : tableau (grand écran) ou cartes (sous 768 px). Libellés affichés en texte brut. */
export function EvalCasesPanel(props: EvalCasesPanelProps) {
  const { set, cases, error, actionError, busyCaseId, isDesktop } = props;
  const active = activeCaseCount(cases);
  const canAdd = canAddCase(active);

  const actions = (c: WfEvalCaseDto) => (
    <div className="wfev-actions">
      <Button size="small" onClick={() => props.onEdit(c)} aria-label={`Modifier le cas ${c.label}`}>
        Modifier
      </Button>
      {c.isActive ? (
        <Button
          size="small"
          danger
          onClick={() => props.onDeactivate(c)}
          loading={busyCaseId === c.wfEvalCaseId}
          aria-label={`Désactiver le cas ${c.label}`}
        >
          Désactiver
        </Button>
      ) : (
        <Button
          size="small"
          onClick={() => props.onReactivate(c)}
          loading={busyCaseId === c.wfEvalCaseId}
          disabled={!canAdd}
          aria-label={`Réactiver le cas ${c.label}`}
        >
          Réactiver
        </Button>
      )}
    </div>
  );

  return (
    <section className="wfev-panel" aria-labelledby="wfev-cases-title">
      <div className="wfev-panel-head">
        <h2 id="wfev-cases-title" className="wfev-h2">
          Cas du jeu « {set.name} »
        </h2>
        <Button type="primary" onClick={props.onAdd} disabled={cases === null || !canAdd}>
          Ajouter un cas
        </Button>
      </div>
      <p className="wf-muted" aria-live="polite">
        {cases === null
          ? 'Chargement des cas…'
          : `${active} cas actif${active > 1 ? 's' : ''} sur ${EVAL_MAX_ACTIVE_CASES}.${canAdd ? '' : ' Limite atteinte : désactivez un cas pour en ajouter un autre.'}`}
      </p>

      {error && (
        <Alert
          type="error"
          showIcon
          role="alert"
          message={error}
          style={{ marginBottom: 12 }}
          action={
            <Button size="small" onClick={props.onRetry}>
              Réessayer
            </Button>
          }
        />
      )}
      {actionError && <Alert type="error" showIcon role="alert" message={actionError} style={{ marginBottom: 12 }} />}

      {cases !== null && cases.length === 0 && !error ? (
        <p className="wf-muted">Ce jeu ne contient aucun cas. Ajoutez un premier cas pour pouvoir lancer une évaluation.</p>
      ) : cases !== null && cases.length > 0 ? (
        isDesktop ? (
          <div className="wfev-table-wrap">
            <table className="wfev-table">
              <caption className="wf-sr-only">Cas d’évaluation du jeu {set.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Nom du cas</th>
                  <th scope="col">Poids</th>
                  <th scope="col">État</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.wfEvalCaseId}>
                    <th scope="row" className="wfev-text wfev-rowhead">
                      {c.label}
                    </th>
                    <td>{c.weight}</td>
                    <td>
                      <Tag>{c.isActive ? 'Actif' : 'Inactif'}</Tag>
                    </td>
                    <td>{actions(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="wfev-cards" aria-label="Cas d’évaluation">
            {cases.map((c) => (
              <li key={c.wfEvalCaseId} className="wf-card wfev-card">
                <div className="wfev-card-head">
                  <h3 className="wfev-h3 wfev-text">{c.label}</h3>
                  <Tag>{c.isActive ? 'Actif' : 'Inactif'}</Tag>
                </div>
                <p className="wf-muted">Poids : {c.weight}</p>
                {actions(c)}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
