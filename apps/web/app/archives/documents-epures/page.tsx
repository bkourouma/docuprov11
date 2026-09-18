'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { App, Button, Card, Input, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { icons } from '../../theme/icons';
import { complianceApi, type ComplianceResult, type ComplianceRow } from '../../lib/archives';

const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');

/**
 * Docu-Archives §2 — Documents épurés.
 *
 * Documents déjà passés à l'état « Épuré » depuis l'écran « DUA expirés ». Consultation seule :
 * l'épuration est une décision de conservation, la défaire depuis une simple liste en ferait un
 * geste anodin. Le sort final et le mode de destruction restent affichés — ce sont eux qui disent
 * ce qu'il reste à faire de chaque document.
 */
export default function DocumentsEpuresPage() {
  const { message } = App.useApp();
  const router = useRouter();
  const [data, setData] = useState<ComplianceResult>({
    total: 0,
    page: 1,
    pageSize: 25,
    cutoff: '',
    rows: [],
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState({
    page: 1,
    pageSize: 25,
    sorting: 'label',
    sortDirection: 'asc' as 'asc' | 'desc',
    search: undefined as string | undefined,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await complianceApi.purged(query));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, [query, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const onTableChange = (
    pagination: TablePaginationConfig,
    _filters: unknown,
    sorter: SorterResult<ComplianceRow> | SorterResult<ComplianceRow>[],
  ) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setQuery((q) => ({
      ...q,
      page: pagination.current ?? 1,
      pageSize: pagination.pageSize ?? 25,
      ...(s?.columnKey
        ? {
            sorting: String(s.columnKey),
            sortDirection: (s.order === 'descend' ? 'desc' : 'asc') as 'asc' | 'desc',
          }
        : {}),
    }));
  };

  const dash = <Typography.Text type="secondary">—</Typography.Text>;

  const columns: TableColumnsType<ComplianceRow> = [
    {
      title: 'Document',
      key: 'label',
      sorter: true,
      defaultSortOrder: 'ascend',
      // Deux lignes par défaut, comme « DUA expirés » : les libellés portent le type, le lot et
      // l'opération, et tiennent rarement sur une seule.
      render: (_, r) => (
        <span title={r.label} className="line-clamp-2" style={{ maxWidth: 420 }}>
          {r.label}
        </span>
      ),
    },
    {
      title: 'Type',
      key: 'documentType',
      width: 160,
      sorter: true,
      render: (_, r) => (r.documentTypeName ? <Tag>{r.documentTypeName}</Tag> : dash),
    },
    { title: 'Dossier', key: 'dossier', width: 170, render: (_, r) => r.dossierName ?? dash },
    {
      title: 'Date du document',
      key: 'documentDate',
      width: 160,
      sorter: true,
      render: (_, r) => fmt(r.documentDate),
    },
    {
      title: 'Échéance DUA',
      key: 'usefulnessLifespan',
      width: 150,
      render: (_, r) => fmt(r.usefulnessLifespan),
    },
    { title: 'Sort final', key: 'finalFate', render: (_, r) => r.finalFateName ?? dash },
    {
      title: 'Mode de destruction',
      key: 'destructionMode',
      render: (_, r) => r.destructionModeName ?? dash,
    },
  ];

  return (
    <div>
      <PageHeader
        icon="delete"
        title="Documents épurés"
        actions={
          <Button icon={<icons.refresh size={16} />} onClick={() => void load()}>
            Actualiser
          </Button>
        }
      />

      <Card>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Input.Search
            allowClear
            style={{ maxWidth: 420 }}
            placeholder="Rechercher un document, un n° de pièce, un type…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onSearch={(v) => setQuery((q) => ({ ...q, search: v.trim() || undefined, page: 1 }))}
          />
          <Table<ComplianceRow>
            rowKey="documentId"
            dataSource={data.rows}
            columns={columns}
            loading={loading}
            // Registre de consultation, faible volumétrie : densité aérée (cf. plan §5.3).
            size="middle"
            scroll={{ x: 'max-content' }}
            onChange={onTableChange}
            locale={{
              emptyText: (
                <EmptyState
                  compact
                  icon="delete"
                  title="Aucun document épuré à ce jour"
                  action={
                    <Button
                      icon={<icons.arrowRight size={16} />}
                      onClick={() => router.push('/archives/dua-expirees')}
                    >
                      Voir les DUA expirés
                    </Button>
                  }
                />
              ),
            }}
            pagination={{
              current: data.page,
              pageSize: data.pageSize,
              total: data.total,
              showSizeChanger: true,
              pageSizeOptions: ['10', '25', '50', '100'],
              showTotal: (t) => `${t} document(s)`,
            }}
          />
        </Space>
      </Card>
    </div>
  );
}
