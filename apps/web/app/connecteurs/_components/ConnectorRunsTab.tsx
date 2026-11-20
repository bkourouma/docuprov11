'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Table, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { EmptyState } from '../../components/EmptyState';
import { TableSkeleton } from '../../components/skeletons';
import {
  connecteursApi,
  formatDateTime,
  truncate,
  type GedSourceSyncRunView,
} from '../../lib/connecteurs';
import { RunStatusTag } from './ConnectorBadges';

const dash = <Typography.Text type="secondary">—</Typography.Text>;
const ERROR_PREVIEW = 80;

const count = (title: string, key: keyof GedSourceSyncRunView) => ({
  title,
  dataIndex: key,
  align: 'right' as const,
});

/** Historique des passes de synchronisation (les plus récentes d'abord). */
export function ConnectorRunsTab({
  connectorId,
  refreshKey,
}: {
  connectorId: number;
  refreshKey: number;
}) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<GedSourceSyncRunView[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await connecteursApi.runs(connectorId));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Chargement des synchronisations impossible');
    } finally {
      setLoading(false);
    }
  }, [connectorId, message]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const columns: TableColumnsType<GedSourceSyncRunView> = [
    { title: 'Début', dataIndex: 'startedAt', render: (v: string) => formatDateTime(v) },
    {
      title: 'Fin',
      dataIndex: 'finishedAt',
      render: (v: string | null) => (v ? formatDateTime(v) : dash),
    },
    { title: 'Statut', dataIndex: 'status', render: (s) => <RunStatusTag status={s} /> },
    count('Vus', 'itemsSeen'),
    count('Créés', 'itemsCreated'),
    count('Mis à jour', 'itemsUpdated'),
    count('Supprimés', 'itemsDeleted'),
    count('Doublons', 'itemsDuplicate'),
    count('Erreurs', 'itemsFailed'),
    {
      title: 'Message',
      dataIndex: 'errorMessage',
      render: (v: string | null) =>
        v ? (
          <Tooltip title={v}>
            <Typography.Text type="danger">{truncate(v, ERROR_PREVIEW)}</Typography.Text>
          </Tooltip>
        ) : (
          dash
        ),
    },
  ];

  if (loading && rows.length === 0) return <TableSkeleton rows={4} columns={8} />;

  return (
    <Table<GedSourceSyncRunView>
      rowKey="gedSourceSyncRunId"
      loading={loading}
      columns={columns}
      dataSource={rows}
      scroll={{ x: 'max-content' }}
      pagination={{ pageSize: 10, hideOnSinglePage: true }}
      locale={{
        emptyText: (
          <EmptyState
            compact
            icon="refresh"
            title="Aucune synchronisation pour l'instant : lancez-en une avec « Synchroniser maintenant »."
          />
        ),
      }}
    />
  );
}
