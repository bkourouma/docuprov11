'use client';

import { Popconfirm, Switch, Tag } from 'antd';

export interface LowRiskToggleProps {
  isLowRisk: boolean;
  /** L'utilisateur est administrateur : seul à pouvoir marquer un workflow à faible risque. */
  canMark: boolean;
  /** Appel serveur en cours. */
  busy: boolean;
  /** Une étape agent autonome existe : le serveur refuse de retirer le faible risque. */
  hasAutonomousStep: boolean;
  onChange(next: boolean): void;
}

export function LowRiskToggle({ isLowRisk, canMark, busy, hasAutonomousStep, onChange }: LowRiskToggleProps) {
  if (!canMark) {
    return (
      <div className="wfp-lowrisk">
        <Tag>{`Faible risque : ${isLowRisk ? 'oui' : 'non'}`}</Tag>
        <span className="wfp-hint">Réservé aux administrateurs.</span>
      </div>
    );
  }

  const blocked = isLowRisk && hasAutonomousStep;
  const next = !isLowRisk;

  return (
    <div className="wfp-lowrisk">
      <div className="wfp-switch-row">
        <Popconfirm
          title={next ? 'Marquer ce workflow à faible risque ?' : 'Retirer le faible risque ?'}
          description={
            next
              ? 'Les étapes agent pourront alors être autonomes, sous réserve d’une évaluation réussie.'
              : 'Les étapes agent ne pourront plus être autonomes.'
          }
          okText="Confirmer"
          cancelText="Annuler"
          disabled={busy || blocked}
          onConfirm={() => onChange(next)}
        >
          <Switch
            id="wfp-lowrisk-switch"
            checked={isLowRisk}
            loading={busy}
            disabled={busy || blocked}
            aria-describedby="wfp-lowrisk-help"
          />
        </Popconfirm>
        <label htmlFor="wfp-lowrisk-switch">Workflow à faible risque</label>
      </div>
      <div id="wfp-lowrisk-help" className="wfp-hint">
        {blocked
          ? "Impossible à retirer tant qu'une étape agent est autonome : changez d'abord son niveau d'autonomie."
          : 'Un workflow à faible risque peut contenir des étapes agent autonomes. Seul un administrateur peut le décider.'}
      </div>
    </div>
  );
}
