'use client';

import { useCallback, useState } from 'react';
import { App, Button, Popconfirm, Space, Typography } from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import { PageHeader } from '../../components/PageHeader';
import { MailWorklist } from '../../components/mail/MailWorklist';
import { MailViewer } from '../../components/mail/MailViewer';
import { icons } from '../../theme/icons';
import {
  listValidationDirection,
  validationDirection,
  type MailSummary,
} from '../../lib/courriers';

export default function ValidationPage() {
  const { message } = App.useApp();
  const [refresh, setRefresh] = useState(0);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (page: number, pageSize: number) => listValidationDirection({ page, pageSize }),
    [],
  );

  const doBatch = useCallback(async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      const { updated } = await validationDirection(selected);
      message.success(`${updated} courrier(s) marqué(s) comme traité(s).`);
      setSelected([]);
      setRefresh((r) => r + 1);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Validation impossible');
    } finally {
      setBusy(false);
    }
  }, [selected, message]);

  const rowSelection: TableRowSelection<MailSummary> = {
    selectedRowKeys: selected,
    onChange: (keys) => setSelected(keys as number[]),
  };

  const count = selected.length;

  return (
    <div>
      <PageHeader icon="check" title="Validation" />
      <MailWorklist
        load={load}
        refreshSignal={refresh}
        rowSelection={rowSelection}
        onOpen={(m) => setDetailId(m.mailId)}
        emptyTitle="Aucun courrier à traiter"
      />
      {/* Seule file à sélection multiple : l'action de lot reste dans le champ de vision quand on
          coche des lignes en bas de page. Barre toujours rendue (bouton désactivé à vide) pour ne
          pas décaler la mise en page à la première case cochée. */}
      <div className="da-sticky-actions">
        <Typography.Text type="secondary">
          {count > 0
            ? `${count} courrier(s) sélectionné(s)`
            : 'Sélectionnez des courriers à marquer comme traités.'}
        </Typography.Text>
        <Space>
          {count > 0 && <Button onClick={() => setSelected([])}>Tout désélectionner</Button>}
          <Popconfirm
            // Action irréversible : la clôture des imputations est annoncée avant, pas après.
            title={`Marquer ${count} courrier${count > 1 ? 's' : ''} comme traité${count > 1 ? 's' : ''} ?`}
            description="Leurs imputations seront clôturées."
            okText="Marquer comme traité"
            cancelText="Annuler"
            disabled={count === 0}
            onConfirm={() => void doBatch()}
          >
            <Button
              type="primary"
              icon={<icons.check size={16} />}
              disabled={count === 0}
              loading={busy}
            >
              Marquer comme traité
            </Button>
          </Popconfirm>
        </Space>
      </div>
      <MailViewer
        mailId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => setRefresh((r) => r + 1)}
      />
    </div>
  );
}
