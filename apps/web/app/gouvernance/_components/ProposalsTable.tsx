'use client';

import type { KeyboardEvent, MouseEvent } from 'react';
import Link from 'next/link';
import { Button, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { GovernanceKind, type GovernanceProposalPage, type GovernanceProposalView } from '@archivage/types';
import { icons } from '../../theme/icons';
import { ReviewActions } from './ReviewActions';
import { KindTag, ProposalSummary, StatusTag, docName, formatDateTime, percent } from './labels';

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

/**
 * Table serveur-paginée. Une ligne s'ouvre au clic ou à Entrée (le détail se met alors au
 * premier plan) ; les liens et boutons internes n'ouvrent pas le détail. Les doublons d'un même
 * groupe portent un bouton « Voir le groupe » qui filtre la liste sur ce groupe.
 */
export function ProposalsTable({
  data,
  loading,
  busyId,
  onPage,
  onOpen,
  onValidate,
  onReject,
  onAskLowering,
  onGroup,
}: {
  data: GovernanceProposalPage;
  loading: boolean;
  busyId: string | null;
  onPage: (page: number, pageSize: number) => void;
  onOpen: (view: GovernanceProposalView) => void;
  onValidate: (view: GovernanceProposalView) => void;
  onReject: (view: GovernanceProposalView) => void;
  onAskLowering: (view: GovernanceProposalView) => void;
  onGroup: (groupKey: string) => void;
}) {
  const Group = icons.filter;

  const columns: TableColumnsType<GovernanceProposalView> = [
    {
      title: 'Nature',
      dataIndex: 'kind',
      render: (k: GovernanceKind) => <KindTag kind={k} />,
    },
    {
      title: 'Document',
      key: 'document',
      render: (_, r) => (
        <div style={{ minWidth: 160, overflowWrap: 'anywhere' }}>
          {r.documentId != null ? (
            <Link href={`/documents/${r.documentId}`} onClick={stop} onKeyDown={stop}>
              {docName(r.documentId, r.documentLabel)}
            </Link>
          ) : (
            <Typography.Text type="secondary">Document inconnu</Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: 'Détail',
      key: 'summary',
      render: (_, r) => (
        <div>
          <ProposalSummary view={r} />
          {r.groupKey && (r.kind === GovernanceKind.DoublonExact || r.kind === GovernanceKind.QuasiDoublon) && (
            <Button
              type="link"
              size="small"
              style={{ paddingInline: 0 }}
              icon={<Group size={14} />}
              onClick={(e) => {
                stop(e);
                onGroup(r.groupKey as string);
              }}
              onKeyDown={stop}
            >
              Voir le groupe
            </Button>
          )}
        </div>
      ),
    },
    {
      title: 'Confiance',
      dataIndex: 'confidence',
      align: 'right',
      render: (v: number | null) => percent(v),
    },
    {
      title: 'Statut',
      dataIndex: 'status',
      render: (_, r) => <StatusTag status={r.status} />,
    },
    {
      title: 'Date',
      dataIndex: 'createdAt',
      render: (v: string) => formatDateTime(v),
    },
    {
      title: 'Actions',
      key: 'actions',
      fixed: 'right',
      render: (_, r) => (
        <div onClick={stop} onKeyDown={stop}>
          <ReviewActions
            view={r}
            busy={busyId === r.id}
            onValidate={onValidate}
            onReject={onReject}
            onAskLowering={onAskLowering}
          />
        </div>
      ),
    },
  ];

  return (
    <Table<GovernanceProposalView>
      rowKey="id"
      loading={loading}
      columns={columns}
      dataSource={data.items}
      scroll={{ x: 'max-content' }}
      pagination={{
        current: data.page,
        pageSize: data.pageSize,
        total: data.total,
        showSizeChanger: true,
        pageSizeOptions: [10, 25, 50],
        showTotal: (total) => `${total} proposition(s)`,
        onChange: onPage,
      }}
      onRow={(r) => ({
        className: 'gov-row',
        tabIndex: 0,
        onClick: () => onOpen(r),
        onKeyDown: (e) => {
          // Entrée sur la ligne elle-même (pas sur un bouton ou un lien qu'elle contient).
          if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(r);
        },
      })}
    />
  );
}
