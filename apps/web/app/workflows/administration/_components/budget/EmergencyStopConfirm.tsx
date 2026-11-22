import { Button, Input } from 'antd';
import {
  EMERGENCY_STOP_CONFIRM_WORD,
  STOP_REASON_MAX,
  canConfirmEmergencyStop,
  emergencyStopScopeLabel,
  emergencyStopWarning,
  validateStopReason,
} from '../../../_lib/budget-logic';

export interface EmergencyStopConfirmProps {
  /** true = activer l'arrêt (mot et motif demandés) ; false = le lever (confirmation simple). */
  active: boolean;
  definitionId: number | null;
  workflowName?: string | null;
  typed: string;
  reason: string;
  busy?: boolean;
  error?: string | null;
  onTypedChange: (v: string) => void;
  onReasonChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Contenu de la confirmation d'arrêt d'urgence (et de sa levée). Composant contrôlé, sans état :
 * se rend côté serveur et se teste avec `renderToStaticMarkup`. Le bouton par défaut (focus) est « Annuler ».
 */
export function EmergencyStopConfirm(p: EmergencyStopConfirmProps) {
  const reason = validateStopReason(p.reason, p.active);
  const wordOk = canConfirmEmergencyStop({ typed: p.typed });
  const canConfirm = p.active ? wordOk && reason.ok : true;
  const scope = emergencyStopScopeLabel(p.definitionId, p.workflowName);

  return (
    <div className="wfp-confirm">
      <p className="wfp-confirm-scope">
        <strong>Portée :</strong> {scope}
      </p>
      <p className="wfp-confirm-warning">{emergencyStopWarning(p.definitionId, p.active)}</p>

      {p.active && (
        <>
          <div className="wfp-field">
            <label htmlFor="wfp-stop-reason">Motif (recommandé, {STOP_REASON_MAX} caractères au plus)</label>
            <Input.TextArea
              id="wfp-stop-reason"
              value={p.reason}
              rows={3}
              onChange={(e) => p.onReasonChange(e.target.value)}
              aria-describedby="wfp-stop-reason-msg"
              status={reason.error ? 'error' : undefined}
            />
            <p id="wfp-stop-reason-msg" className={reason.error ? 'wfp-error' : 'wf-muted'}>
              {reason.error ?? reason.warning ?? `${p.reason.trim().length} / ${STOP_REASON_MAX}`}
            </p>
          </div>
          <div className="wfp-field">
            <label htmlFor="wfp-stop-word">
              Pour confirmer, saisissez le mot « {EMERGENCY_STOP_CONFIRM_WORD} »
            </label>
            <Input
              id="wfp-stop-word"
              value={p.typed}
              autoComplete="off"
              onChange={(e) => p.onTypedChange(e.target.value)}
              onPressEnter={() => {
                if (canConfirm && !p.busy) p.onConfirm();
              }}
            />
          </div>
        </>
      )}

      {p.error && (
        <p className="wfp-error" role="alert">
          {p.error}
        </p>
      )}

      <div className="wfp-confirm-buttons">
        <Button autoFocus onClick={p.onCancel} disabled={p.busy}>
          Annuler
        </Button>
        <Button
          type="primary"
          danger={p.active}
          onClick={p.onConfirm}
          disabled={!canConfirm || p.busy}
          loading={p.busy}
        >
          {p.active ? 'Activer l’arrêt d’urgence' : 'Lever l’arrêt d’urgence'}
        </Button>
      </div>
    </div>
  );
}
