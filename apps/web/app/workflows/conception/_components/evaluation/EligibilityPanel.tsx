'use client';

import { Alert, Button, Tag } from 'antd';
import type { WfEvalStatusStep } from '../../../../lib/workflows-api';
import { eligibilityLabel, evalChecklist, type EvalChecklist } from '../../../_lib/eval-logic';

export interface EligibilityPanelProps {
  /** `null` : la route d'éligibilité est indisponible (accès refusé ou absente). `undefined` : chargement. */
  available: boolean | undefined;
  /** Ligne d'éligibilité de l'étape choisie (dernière version) ; null si l'étape n'y figure pas. */
  step: WfEvalStatusStep | null;
  stepKey: string | null;
  versionNumber: number | null;
  checklist: EvalChecklist;
  /** Précision affichée sous la liste (par ex. « sélectionnez le jeu lié pour voir… »). */
  checklistNote?: string | null;
  loading: boolean;
  /** Message d'erreur de la dernière actualisation (l'ancien état reste affiché). */
  error?: string | null;
  onRefresh: () => void;
}

/** Calcule la checklist à partir des faits connus ; exposé pour que l'écran et les tests partagent la règle. */
export function buildChecklist(input: {
  isLowRisk: boolean;
  evalSetLinked: boolean;
  activeCases: number;
  hasPassedRun: boolean;
}): EvalChecklist {
  return evalChecklist(input);
}

/** Éligibilité de l'étape à « autonome » : état, raison, action suivante et checklist, toujours en texte. */
export function EligibilityPanel(props: EligibilityPanelProps) {
  const { available, step, stepKey, versionNumber, checklist, checklistNote, loading, error, onRefresh } = props;
  const label = step ? eligibilityLabel(step) : null;

  return (
    <section className="wfev-panel" aria-labelledby="wfev-elig-title">
      <div className="wfev-panel-head">
        <h2 id="wfev-elig-title" className="wfev-h2">
          Éligibilité à l’autonomie
        </h2>
        <Button onClick={onRefresh} loading={loading} aria-label="Actualiser l’éligibilité à l’autonomie">
          Actualiser
        </Button>
      </div>

      {error && <Alert type="warning" showIcon message={error} style={{ marginBottom: 12 }} />}

      {available === undefined ? (
        <p className="wf-muted">Chargement de l’éligibilité…</p>
      ) : available === false ? (
        <Alert
          type="info"
          showIcon
          message="Le suivi d’éligibilité n’est pas disponible pour le moment."
          description="Vous pouvez tout de même gérer les jeux d’évaluation, les cas et lancer des évaluations ci-dessous."
        />
      ) : stepKey === null ? (
        <p className="wf-muted">Choisissez une étape agent pour voir son éligibilité.</p>
      ) : step === null || label === null ? (
        <Alert
          type="info"
          showIcon
          message="Cette étape ne figure pas dans la dernière version enregistrée."
          description="Enregistrez le workflow depuis l’éditeur, puis actualisez."
        />
      ) : (
        <>
          <p className="wfev-elig-state">
            <Tag color={label.tone === 'success' ? 'success' : 'warning'}>
              {step.eligible ? 'Éligible' : 'Non éligible'}
            </Tag>
            <span className="wfev-text">{label.label}</span>
          </p>
          {label.actionLabel && (
            <p className="wfev-text">
              <strong>Action suivante :</strong> {label.actionLabel}.
            </p>
          )}
          {versionNumber !== null && (
            <p className="wf-muted">Calculé sur la dernière version enregistrée (version {versionNumber}).</p>
          )}
        </>
      )}

      <h3 className="wfev-h3">Conditions à remplir</h3>
      <ul className="wfev-checklist">
        {checklist.items.map((it) => (
          <li key={it.key}>
            <span className={it.done ? 'wfev-check wfev-check--done' : 'wfev-check'}>{it.done ? 'Fait' : 'À faire'}</span>
            <span className="wfev-text">{it.label}</span>
          </li>
        ))}
      </ul>
      {checklistNote && <p className="wf-muted">{checklistNote}</p>}
    </section>
  );
}
