'use client';

import { Button, Popconfirm, Typography } from 'antd';
import { GOVERNANCE_STATUS_LABELS, GovernanceKind, type GovernanceProposalView } from '@archivage/types';
import { icons, iconDefaults } from '../../theme/icons';
import { validateWording } from './labels';

/**
 * Boutons Valider / Rejeter d'une proposition. Visibles seulement pour une proposition en attente.
 * Un abaissement de confidentialité n'est jamais confirmé ici : le bouton ouvre la fenêtre de
 * confirmation explicite (`onAskLowering`).
 */
export function ReviewActions({
  view,
  busy,
  onValidate,
  onReject,
  onAskLowering,
  size = 'small',
}: {
  view: GovernanceProposalView;
  busy: boolean;
  onValidate: (view: GovernanceProposalView) => void;
  onReject: (view: GovernanceProposalView) => void;
  onAskLowering: (view: GovernanceProposalView) => void;
  size?: 'small' | 'middle';
}) {
  if (view.status !== 0) {
    return (
      <Typography.Text type="secondary">
        {GOVERNANCE_STATUS_LABELS[view.status]}
      </Typography.Text>
    );
  }
  const Ok = icons.check;
  const No = icons.close;
  const wording = validateWording(view.kind);
  const label = `${wording.button} (${view.documentLabel ?? `document n° ${view.documentId ?? '?'}`})`;
  const validateButton = (
    <Button
      size={size}
      type="primary"
      icon={<Ok size={iconDefaults.size} />}
      loading={busy}
      aria-label={label}
      onClick={view.requiresLoweringConfirmation ? () => onAskLowering(view) : undefined}
    >
      {wording.button}
    </Button>
  );

  const needsPopconfirm = view.kind !== GovernanceKind.DonneesPersonnelles && !view.requiresLoweringConfirmation;

  return (
    <div className="gov-actions">
      {needsPopconfirm ? (
        <Popconfirm
          title={wording.title}
          description={wording.note ?? undefined}
          okText="Confirmer"
          cancelText="Annuler"
          onConfirm={() => onValidate(view)}
        >
          {validateButton}
        </Popconfirm>
      ) : view.requiresLoweringConfirmation ? (
        validateButton
      ) : (
        <Button
          size={size}
          type="primary"
          icon={<Ok size={iconDefaults.size} />}
          loading={busy}
          aria-label={label}
          onClick={() => onValidate(view)}
        >
          {wording.button}
        </Button>
      )}
      <Button
        size={size}
        icon={<No size={iconDefaults.size} />}
        disabled={busy}
        aria-label={`Rejeter la proposition (${view.documentLabel ?? `document n° ${view.documentId ?? '?'}`})`}
        onClick={() => onReject(view)}
      >
        Rejeter
      </Button>
    </div>
  );
}
