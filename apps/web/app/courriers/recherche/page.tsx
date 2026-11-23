'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import { AnimatePresence, motion } from 'motion/react';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader } from '../../components/PageHeader';
import { CountBadge } from '../../components/CountBadge';
import { EmptyState } from '../../components/EmptyState';
import { MailTypeTag } from '../../components/mail/tags';
import { icons } from '../../theme/icons';
import { colors, fontSize } from '../../theme/tokens';
import { chip } from '../../theme/motion';
import {
  listExternalEntities,
  listMailNatures,
  MAIL_STATUS_LABELS,
  MAIL_TYPE_LABELS,
  searchMails,
  type MailSearchParams,
  type MailSearchRow,
} from '../../lib/courriers';

const { Text } = Typography;
const { RangePicker } = DatePicker;

/** Libellé de filtre : même taille et même espace label→champ qu'un label de Form (14 px / 8 px),
 *  pour que les filtres ne composent pas une seconde échelle typographique. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: fontSize.base }}>
        {label}
      </Text>
      {children}
    </div>
  );
}

type Sort = { field: string; dir: 'asc' | 'desc' };

export default function RechercheCourrierPage() {
  const { message } = App.useApp();
  const router = useRouter();

  const [entities, setEntities] = useState<Array<{ externalEntityId: number; label: string }>>([]);
  const [natures, setNatures] = useState<Array<{ mailNatureId: number; label: string }>>([]);

  // Draft filters
  const [q, setQ] = useState('');
  const [mailType, setMailType] = useState<number | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [entityId, setEntityId] = useState<number | null>(null);
  const [natureId, setNatureId] = useState<number | null>(null);
  const [dates, setDates] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  // Applied criteria + results
  const [applied, setApplied] = useState<MailSearchParams>({});
  const [rows, setRows] = useState<MailSearchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<Sort[]>([]);
  const [loading, setLoading] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);

  useEffect(() => {
    void (async () => {
      const [e, n] = await Promise.all([
        listExternalEntities().catch(() => []),
        listMailNatures().catch(() => []),
      ]);
      setEntities(e);
      setNatures(n);
    })();
  }, []);

  const entityOptions = useMemo(
    () => entities.map((e) => ({ value: e.externalEntityId, label: e.label })),
    [entities],
  );
  const natureOptions = useMemo(
    () => natures.map((n) => ({ value: n.mailNatureId, label: n.label })),
    [natures],
  );
  const entityLabelById = useMemo(
    () => new Map(entities.map((e) => [e.externalEntityId, e.label])),
    [entities],
  );
  const natureLabelById = useMemo(
    () => new Map(natures.map((n) => [n.mailNatureId, n.label])),
    [natures],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await searchMails({ ...applied, page, pageSize, sort });
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de recherche');
    } finally {
      setLoading(false);
      setFirstLoad(false);
    }
  }, [applied, page, pageSize, sort, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = () => {
    setApplied({
      fullText: q.trim() || undefined,
      mailType: mailType ?? undefined,
      status: status ?? undefined,
      externalEntityId: entityId ?? undefined,
      mailNatureId: natureId ?? undefined,
      dateFrom: dates?.[0] ? dates[0].format('YYYY-MM-DD') : undefined,
      dateTo: dates?.[1] ? dates[1].format('YYYY-MM-DD') : undefined,
    });
    setPage(1);
  };

  const reset = () => {
    setQ('');
    setMailType(null);
    setStatus(null);
    setEntityId(null);
    setNatureId(null);
    setDates(null);
    setApplied({});
    setSort([]);
    setPage(1);
  };

  /** Efface un seul critère (brouillon + appliqué) et relance la recherche — même convention que
   * les puces de filtres de `/search`, pour une expérience cohérente entre les deux écrans. */
  const clearFilter = (key: keyof MailSearchParams | 'dateRange') => {
    if (key === 'dateRange') {
      setDates(null);
      setApplied((a) => ({ ...a, dateFrom: undefined, dateTo: undefined }));
    } else {
      if (key === 'fullText') setQ('');
      if (key === 'mailType') setMailType(null);
      if (key === 'status') setStatus(null);
      if (key === 'externalEntityId') setEntityId(null);
      if (key === 'mailNatureId') setNatureId(null);
      setApplied((a) => ({ ...a, [key]: undefined }));
    }
    setPage(1);
  };

  const fmtDate = (iso?: string) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '…');

  const chips: { key: string; text: string; onClose: () => void }[] = [];
  if (applied.fullText)
    chips.push({
      key: 'q',
      text: `Texte : « ${applied.fullText} »`,
      onClose: () => clearFilter('fullText'),
    });
  if (applied.mailType != null)
    chips.push({
      key: 'type',
      text: `Sens : ${MAIL_TYPE_LABELS[applied.mailType as keyof typeof MAIL_TYPE_LABELS] ?? applied.mailType}`,
      onClose: () => clearFilter('mailType'),
    });
  if (applied.status != null)
    chips.push({
      key: 'status',
      text: `Statut : ${MAIL_STATUS_LABELS[applied.status as keyof typeof MAIL_STATUS_LABELS] ?? applied.status}`,
      onClose: () => clearFilter('status'),
    });
  if (applied.externalEntityId != null)
    chips.push({
      key: 'entity',
      text: `Correspondant : ${entityLabelById.get(applied.externalEntityId) ?? applied.externalEntityId}`,
      onClose: () => clearFilter('externalEntityId'),
    });
  if (applied.mailNatureId != null)
    chips.push({
      key: 'nature',
      text: `Nature : ${natureLabelById.get(applied.mailNatureId) ?? applied.mailNatureId}`,
      onClose: () => clearFilter('mailNatureId'),
    });
  if (applied.dateFrom || applied.dateTo)
    chips.push({
      key: 'date',
      text: `Date : ${fmtDate(applied.dateFrom)} → ${fmtDate(applied.dateTo)}`,
      onClose: () => clearFilter('dateRange'),
    });

  const columns: TableColumnsType<MailSearchRow> = [
    {
      title: 'N° enregistrement',
      dataIndex: 'nReference',
      key: 'nReference',
      // Assez large pour le libellé + la flèche de tri : sans cela l'en-tête passe sur deux lignes.
      width: 190,
      onHeaderCell: () => ({ style: { whiteSpace: 'nowrap' } }),
      sorter: true,
      render: (v: string | null) => (v ? <span className="da-mono">{v}</span> : '—'),
    },
    {
      title: 'Objet',
      dataIndex: 'title',
      key: 'title',
      sorter: true,
      ellipsis: true,
      render: (v: string, r) => (
        <a onClick={() => router.push(`/courriers/recherche/${r.mailId}`)}>{v}</a>
      ),
    },
    {
      title: 'Sens',
      dataIndex: 'mailType',
      key: 'mailType',
      width: 100,
      sorter: true,
      render: (v: number) => <MailTypeTag mailType={v} />,
    },
    {
      title: 'Correspondant',
      dataIndex: 'externalEntity',
      key: 'externalEntity',
      width: 190,
      ellipsis: true,
      render: (v) => v || '—',
    },
    {
      title: 'Destinataire',
      dataIndex: 'destinataire',
      key: 'destinataire',
      width: 190,
      ellipsis: true,
      render: (v) => v || '—',
    },
    {
      title: 'Date',
      dataIndex: 'date',
      key: 'date',
      width: 130,
      sorter: true,
      render: (v: string | null) => (v ? dayjs(v).format('DD/MM/YYYY') : '—'),
    },
  ];

  const onChange = (
    pagination: TablePaginationConfig,
    _filters: unknown,
    sorter: SorterResult<MailSearchRow> | SorterResult<MailSearchRow>[],
  ) => {
    setPage(pagination.current ?? 1);
    setPageSize(pagination.pageSize ?? 25);
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    setSort(
      s && s.order && s.columnKey
        ? [{ field: String(s.columnKey), dir: s.order === 'ascend' ? 'asc' : 'desc' }]
        : [],
    );
  };

  return (
    <div>
      <PageHeader icon="search" title="Recherche courrier" />

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col flex="auto">
            <Input
              allowClear
              aria-label="Texte recherché"
              prefix={
                <icons.search
                  size={18}
                  strokeWidth={1.75}
                  style={{ color: 'var(--ant-color-text-tertiary)' }}
                />
              }
              placeholder="Objet, description, référence, n° d'enregistrement…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onPressEnter={apply}
            />
          </Col>
          <Col>
            <Space>
              <Button
                type="primary"
                icon={<icons.search size={16} />}
                loading={loading}
                onClick={apply}
              >
                Rechercher
              </Button>
              <Button icon={<icons.reset size={16} />} onClick={reset}>
                Réinitialiser
              </Button>
            </Space>
          </Col>
        </Row>

        <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
          <Col xs={24} md={12} lg={8}>
            <Field label="Sens">
              <Select
                aria-label="Sens"
                style={{ width: '100%' }}
                allowClear
                placeholder="Tous"
                value={mailType ?? undefined}
                onChange={(v) => setMailType((v as number) ?? null)}
                options={Object.entries(MAIL_TYPE_LABELS).map(([k, label]) => ({
                  value: Number(k),
                  label,
                }))}
              />
            </Field>
          </Col>
          <Col xs={24} md={12} lg={8}>
            <Field label="Statut">
              <Select
                aria-label="Statut"
                style={{ width: '100%' }}
                allowClear
                placeholder="Tous"
                value={status ?? undefined}
                onChange={(v) => setStatus((v as number) ?? null)}
                options={Object.entries(MAIL_STATUS_LABELS).map(([k, label]) => ({
                  value: Number(k),
                  label,
                }))}
              />
            </Field>
          </Col>
          <Col xs={24} md={12} lg={8}>
            <Field label="Correspondant">
              <Select
                aria-label="Correspondant"
                style={{ width: '100%' }}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Tous"
                value={entityId ?? undefined}
                onChange={(v) => setEntityId((v as number) ?? null)}
                options={entityOptions}
              />
            </Field>
          </Col>
          <Col xs={24} md={12} lg={8}>
            <Field label="Nature">
              <Select
                aria-label="Nature"
                style={{ width: '100%' }}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Toutes"
                value={natureId ?? undefined}
                onChange={(v) => setNatureId((v as number) ?? null)}
                options={natureOptions}
              />
            </Field>
          </Col>
          <Col xs={24} md={12} lg={8}>
            <Field label="Date du courrier">
              <RangePicker
                style={{ width: '100%' }}
                value={dates}
                onChange={(v) => setDates((v ?? null) as [Dayjs | null, Dayjs | null] | null)}
                format="DD/MM/YYYY"
                allowEmpty={[true, true]}
                placeholder={['Du', 'Au']}
              />
            </Field>
          </Col>
        </Row>

        {chips.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Space size={[8, 8]} wrap>
              <Text type="secondary">Filtres actifs :</Text>
              <AnimatePresence initial={false}>
                {chips.map((c) => (
                  <motion.span
                    key={c.key}
                    layout
                    variants={chip}
                    initial="hidden"
                    animate="show"
                    exit="exit"
                  >
                    <Tag
                      className="da-pill"
                      color={colors.primary}
                      closable
                      style={{ margin: 0, paddingInline: 10 }}
                      onClose={(e) => {
                        e.preventDefault();
                        c.onClose();
                      }}
                    >
                      {c.text}
                    </Tag>
                  </motion.span>
                ))}
              </AnimatePresence>
              <a onClick={reset}>Tout effacer</a>
            </Space>
          </div>
        )}
      </Card>

      <Card
        title={
          loading && firstLoad ? (
            'Recherche…'
          ) : (
            <CountBadge value={total} label={`résultat${total > 1 ? 's' : ''}`} />
          )
        }
      >
        {total === 0 && !loading ? (
          <EmptyState icon="search" title="Aucun courrier archivé ne correspond" />
        ) : (
          <Table<MailSearchRow>
            rowKey="mailId"
            columns={columns}
            dataSource={rows}
            loading={loading}
            // Écran de production : densité resserrée pour balayer un volume de résultats.
            size="small"
            scroll={{ x: 'max-content' }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              pageSizeOptions: [10, 25, 50, 100],
              showTotal: (t) => `${t} courrier(s)`,
            }}
            onChange={onChange}
          />
        )}
      </Card>
    </div>
  );
}
