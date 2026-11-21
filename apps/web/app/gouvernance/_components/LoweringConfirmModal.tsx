'use client';

import { useEffect, useState } from 'react';
import { Alert, Checkbox, Modal } from 'antd';
import type { GovernanceProposalView } from '@archivage/types';
import { docName } from './labels';

/**
 * Confirmation EXPLICITE d'un abaissement de confidentialité. `onConfirm` (qui enverra
 * `confirmLowering: true`) n'est appelable qu'une fois la case cochée : jamais implicite.
 */
export function LoweringConfirmModal({
  proposal,
  busy,
  onCancel,
  onConfirm,
}: {
  proposal: GovernanceProposalView | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (proposal: GovernanceProposalView) => void;
}) {
  const [checked, setChecked] = useState(false);

  // Case décochée à chaque ouverture : aucune confirmation ne se reporte d'une proposition à l'autre.
  useEffect(() => {
    setChecked(false);
  }, [proposal?.id]);

  return (
    <Modal
      open={proposal !== null}
      title="Confirmer l’abaissement de la confidentialité"
      okText="Appliquer l’abaissement"
      cancelText="Annuler"
      okButtonProps={{ disabled: !checked, danger: true }}
      confirmLoading={busy}
      onCancel={onCancel}
      onOk={() => proposal && checked && onConfirm(proposal)}
      destroyOnHidden
    >
      {proposal && (
        <>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="Abaissement de la confidentialité"
            description={`Le document « ${docName(proposal.documentId, proposal.documentLabel)} » passerait de « ${
              proposal.currentConfidentialiteLabel ?? 'aucun niveau'
            } » à « ${proposal.proposedConfidentialiteLabel ?? 'niveau proposé'} ». Il serait accessible à davantage de personnes.`}
          />
          <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)}>
            Je confirme l’abaissement
          </Checkbox>
        </>
      )}
    </Modal>
  );
}
