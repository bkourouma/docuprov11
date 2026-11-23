'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  Card,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { LoadFailure } from '../../components/LoadFailure';
import { icons } from '../../theme/icons';
import { colors } from '../../theme/tokens';
import { complianceApi, type ComplianceResult, type ComplianceRow } from '../../lib/archives';
import { InfoTooltip } from '../../components/InfoTooltip';

const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');

/**
 * Badge plein AA : le fond porte le dérivé FORT de la sémantique (la teinte vive ne passe pas
 * le contraste sous du texte) et AntD pose le blanc via `ant-tag-has-color`. La taille 11 px
 * vient du thème (`Tag.fontSizeSM`) : seule la graisse est à forcer ici.
 */
const badgeStyle = { fontWeight: 600 } as const;

/** Fenêtres d'anticipation proposées — au-delà de l'échu strict, on prépare une campagne. */
const HORIZONS = [
  { value: 0, label: 'Échu aujourd’hui' },
  { value: 3, label: 'Échu dans les 3 mois' },
  { value: 6, label: 'Échu dans les 6 mois' },
  { value: 12, label: 'Échu dans les 12 mois' },
];

/**
 * Docu-Archives §1 — DUA expirés.
 *
 * Liste les documents dont la durée d'utilité administrative est atteinte, d'après le cycle de vie
 * propre au document s'il en a un, sinon d'après la règle de son type. C'est depuis cet écran que
 * l'on déclare des documents « épurés ».
 *
 * L'épuration est un changement d'ÉTAT, pas une suppression : le binaire reste sur le coffre
 * disque et le document reste consultable dans « Documents épurés ». La destruction physique
 * relève du mode de destruction et demeure une opération distincte.
 */
export default function DuaExpireesPage() {
  const { message } = App.useApp();
  const [data, setData] = useState<ComplianceResult>({
    total: 0,
    page: 1,
    pageSize: 25,
    cutoff: '',
    rows: [],
  });
  const [loading, setLoading] = useState(true);
  const [purging, setPurging] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState({
    page: 1,
    pageSize: 25,
    sorting: 'usefulnessLifespan',
    sortDirection: 'asc' as 'asc' | 'desc',
    monthsAhead: 0,
    search: undefined as string | undefined,
  });

  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await complianceApi.expired(query));
      setLoadFailed(false);
    } catch (e) {
      setLoadFailed(true);
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, [query, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const purge = async () => {
    if (!selected.length) return;
    setPurging(true);
    try {
      const r = await complianceApi.purge(selected);
      setSelected([]);
      await load();
      if (r.blocked.length > 0) {
        message.warning(
          `${r.purged} document(s) épuré(s). Non épuré(s), encore communiqué(s) : ${r.blocked
            .map((b) => b.label)
            .join(', ')}`,
          8,
        );
      } else {
        message.success(`${r.purged} document(s) épuré(s)`);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Épuration impossible');
    } finally {
      setPurging(false);
    }
  };

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
      // Deux lignes par défaut : les libellés portent le type, le lot et l'opération, et tiennent
      // rarement sur une seule. Même traitement que la colonne « Libellé » de la recherche.
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
      title: 'Départ',
      key: 'startDate',
      width: 120,
      sorter: true,
      render: (_, r) => (
        <InfoTooltip title="Date du document, à défaut sa date de création — point de départ du décompte.">
          <span>{fmt(r.startDate)}</span>
        </InfoTooltip>
      ),
    },
    {
      title: 'Échéance DUA',
      key: 'usefulnessLifespan',
      width: 150,
      sorter: true,
      defaultSortOrder: 'ascend',
      // Échu = danger, à venir dans la fenêtre d'anticipation = warning : deux badges pleins
      // sur les dérivés AA, la teinte vive ne pouvant pas porter de texte.
      render: (_, r) => {
        const overdue =
          r.usefulnessLifespan != null && !dayjs(r.usefulnessLifespan).isAfter(dayjs(), 'day');
        return r.usefulnessLifespan ? (
          <Tag color={overdue ? colors.danger : colors.warning} style={badgeStyle}>
            {fmt(r.usefulnessLifespan)}
          </Tag>
        ) : (
          dash
        );
      },
    },
    {
      title: 'Échéance conformité',
      key: 'complianceLifespan',
      width: 170,
      sorter: true,
      render: (_, r) => fmt(r.complianceLifespan),
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
        icon="alert"
        title="DUA expirés"
        actions={
          <Button icon={<icons.refresh size={16} />} onClick={() => void load()}>
            Actualiser
          </Button>
        }
      />

      <Card className="da-ref-card" styles={{ body: { padding: 0 } }}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Select
              style={{ minWidth: 220 }}
              value={query.monthsAhead}
              onChange={(v) => setQuery((q) => ({ ...q, monthsAhead: v, page: 1 }))}
              options={HORIZONS}
            />
            <Input.Search
              allowClear
              style={{ width: 420, maxWidth: '100%' }}
              placeholder="Rechercher un document, un n° de pièce, un type…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onSearch={(v) => setQuery((q) => ({ ...q, search: v.trim() || undefined, page: 1 }))}
            />
            {data.cutoff && (
              <Typography.Text type="secondary">
                Échéance au plus tard le {fmt(data.cutoff)}
              </Typography.Text>
            )}
          </Space>

          <Table<ComplianceRow>
            rowKey="documentId"
            dataSource={data.rows}
            columns={columns}
            loading={loading}
            size="small"
            scroll={{ x: 'max-content' }}
            onChange={onTableChange}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as number[]),
            }}
            locale={{
              emptyText: loadFailed ? (
                <LoadFailure title="La liste n’a pas pu être chargée" onRetry={load} compact />
              ) : (
                <EmptyState compact icon="archive" title="Aucun document échu sur cette période" />
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

      {/* Barre de sélection COLLANTE : posée en flux, elle décalait la mise en page à chaque
          coche et sortait du viewport en bas d'une longue campagne. Le débord latéral suit la
          gouttière de .da-page (--da-page-pad-x), sinon il se désynchronise du padding. */}
      {selected.length > 0 && (
        <div className="da-sticky-actions">
          <Typography.Text strong>{selected.length} document(s) sélectionné(s)</Typography.Text>
          <Space>
            <Button onClick={() => setSelected([])}>Tout désélectionner</Button>
            <Popconfirm
              title={`Déclarer épurés ces ${selected.length} document(s) ?`}
              description="Ils quitteront cette liste et rejoindront « Documents épurés »."
              okText="Épurer"
              cancelText="Annuler"
              onConfirm={() => void purge()}
            >
              <Button type="primary" danger loading={purging} icon={<icons.archive size={16} />}>
                Épurer la sélection
              </Button>
            </Popconfirm>
          </Space>
        </div>
      )}
    </div>
  );
}
