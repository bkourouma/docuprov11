'use client';

import { Alert, Button, Tag } from 'antd';
import type { WfEvalSetDto } from '@archivage/types';
import { WF_EVAL_ACCURACY_FLOOR } from '@archivage/types';
import { formatAccuracy } from '../../../_lib/eval-logic';

export interface EvalSetsPanelProps {
  /** Jeux de l'étape ou sans étape. */
  sets: readonly WfEvalSetDto[];
  loading: boolean;
  error: string | null;
  stepKey: string;
  selectedSetId: number | null;
  linkedSetId: number | null;
  /** Identifiant du jeu dont le lien est en cours d'écriture (0 = délier). */
  linkBusy: number | null;
  linkError: string | null;
  onSelect: (setId: number) => void;
  onCreate: () => void;
  onEdit: (set: WfEvalSetDto) => void;
  onLink: (set: WfEvalSetDto) => void;
  onUnlink: () => void;
  onRetry: () => void;
}

/** Liste des jeux d'évaluation de l'étape : sélection, création, modification, lien à l'étape. */
export function EvalSetsPanel(props: EvalSetsPanelProps) {
  const { sets, loading, error, stepKey, selectedSetId, linkedSetId, linkBusy, linkError } = props;
  return (
    <section className="wfev-panel" aria-labelledby="wfev-sets-title">
      <div className="wfev-panel-head">
        <h2 id="wfev-sets-title" className="wfev-h2">
          Jeux d’évaluation
        </h2>
        <Button onClick={props.onCreate}>Nouveau jeu d’évaluation</Button>
      </div>
      <p className="wf-muted">
        Un jeu regroupe des cas de test. Le jeu lié à l’étape « {stepKey} » est celui qui compte pour l’éligibilité à l’autonomie.
        Précision minimale : {formatAccuracy(WF_EVAL_ACCURACY_FLOOR)} au moins.
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
      {linkError && <Alert type="error" showIcon role="alert" message={linkError} style={{ marginBottom: 12 }} />}

      {loading ? (
        <p className="wf-muted">Chargement des jeux…</p>
      ) : sets.length === 0 ? (
        <p className="wf-muted">Aucun jeu pour cette étape. Créez-en un, puis ajoutez des cas.</p>
      ) : (
        <ul className="wfev-cards" aria-label="Jeux d’évaluation de l’étape">
          {sets.map((s) => {
            const linked = s.wfEvalSetId === linkedSetId;
            const selected = s.wfEvalSetId === selectedSetId;
            const busy = linkBusy !== null;
            return (
              <li key={s.wfEvalSetId} className={`wf-card wfev-card${selected ? ' wfev-card--selected' : ''}`}>
                <div className="wfev-card-head">
                  <h3 className="wfev-h3 wfev-set-name">{s.name}</h3>
                  <span className="wfev-tags">
                    {selected && <Tag color="blue">Sélectionné</Tag>}
                    {linked && <Tag color="green">Lié à l’étape {stepKey}</Tag>}
                    <Tag>{s.isActive ? 'Actif' : 'Désactivé'}</Tag>
                    <Tag>{s.stepKey ? `Étape ${s.stepKey}` : 'Jeu général du workflow'}</Tag>
                  </span>
                </div>
                {s.description ? <p className="wfev-text">{s.description}</p> : null}
                <p className="wf-muted">Précision minimale requise : {formatAccuracy(s.minAccuracy)}</p>
                <div className="wfev-actions">
                  <Button
                    onClick={() => props.onSelect(s.wfEvalSetId)}
                    aria-pressed={selected}
                    aria-label={`Afficher les cas et les évaluations du jeu ${s.name}`}
                    disabled={selected}
                  >
                    {selected ? 'Jeu affiché' : 'Afficher ce jeu'}
                  </Button>
                  <Button onClick={() => props.onEdit(s)} aria-label={`Modifier le jeu ${s.name}`}>
                    Modifier
                  </Button>
                  {linked ? (
                    <Button
                      onClick={props.onUnlink}
                      loading={busy}
                      disabled={busy}
                      aria-label={`Délier le jeu ${s.name} de l’étape ${stepKey}`}
                    >
                      Délier de l’étape
                    </Button>
                  ) : (
                    <Button
                      type={linkedSetId === null ? 'primary' : 'default'}
                      onClick={() => props.onLink(s)}
                      loading={linkBusy === s.wfEvalSetId}
                      disabled={busy}
                      aria-label={`Lier le jeu ${s.name} à l’étape ${stepKey}`}
                    >
                      Lier à cette étape
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
