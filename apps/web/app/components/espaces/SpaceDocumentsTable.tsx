'use client';

import { Button, Popconfirm, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import Link from 'next/link';
import { icons } from '../../theme/icons';
import { fontSize, space as spacing } from '../../theme/tokens';
import type { GedSpaceDocumentRow } from '../../lib/espaces';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : null);
const dash = <Typography.Text type="secondary">—</Typography.Text>;

/** Tableau des documents d'un espace ; `onDetach` absent = lecture seule (pas de colonne d'action). */
export function SpaceDocumentsTable({
  rows,
  loading,
  onDetach,
}: {
  rows: GedSpaceDocumentRow[];
  loading?: boolean;
  onDetach?: (documentId: number) => void | Promise<void>;
}) {
  const Unlink = icons.close;
  const columns: TableColumnsType<GedSpaceDocumentRow> = [
    {
      title: 'Document',
      dataIndex: 'label',
      render: (v: string, r) => <Link href={`/documents/${r.documentId}`}>{v}</Link>,
    },
    { title: 'Type', dataIndex: 'documentTypeLabel', render: (v: string | null) => v ?? dash },
    { title: 'Date', dataIndex: 'documentDate', render: (v: string | null) => fmt(v) ?? dash },
    { title: 'Rattaché le', dataIndex: 'addedAt', render: (v: string) => fmt(v) ?? dash },
  ];
  if (onDetach) {
    columns.push({
      title: 'Actions',
      key: 'actions',
      width: spacing.xxxl * 3,
      render: (_, r) => (
        <Popconfirm
          title="Détacher ce document ?"
          description="Le document n'est pas supprimé, il quitte seulement cet espace."
          okText="Détacher"
          cancelText="Annuler"
          onConfirm={() => onDetach(r.documentId)}
        >
          <Button size="small" icon={<Unlink size={fontSize.base} />} aria-label={`Détacher ${r.label}`}>
            Détacher
          </Button>
        </Popconfirm>
      ),
    });
  }
  return (
    <Table<GedSpaceDocumentRow>
      rowKey="documentId"
      size="middle"
      loading={loading}
      columns={columns}
      dataSource={rows}
      pagination={rows.length > 20 ? { pageSize: 20, hideOnSinglePage: true } : false}
      scroll={{ x: 'max-content' }}
    />
  );
}
