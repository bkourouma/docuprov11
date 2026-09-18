'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  App,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Dropdown,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  TreeSelect,
  Typography,
} from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import { AnimatePresence, motion } from 'motion/react';
import dayjs, { type Dayjs } from 'dayjs';
import { API_BASE, apiJson } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { CountBadge } from '../components/CountBadge';
import { EmptyState } from '../components/EmptyState';
import { TableSkeleton } from '../components/skeletons';
import { icons } from '../theme/icons';
import { colors } from '../theme/tokens';
import { chip, fade } from '../theme/motion';

const { Text } = Typography;
const { RangePicker } = DatePicker;

interface Row {
  documentId: number;
  label: string;
  documentType: string | null;
  documentDate: string | null;
  /** Date d'enregistrement système — affichée dans le tableau (§ demande utilisateur), à la place
   *  de la date métier `documentDate` (qui reste filtrable, elle, dans les filtres avancés). */
  createdAt: string;
  dossier: string | null;
  plan: string | null;
}
interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  rows: Row[];
}

interface TypeRow {
  documentTypeId: number;
  label: string;
}
interface PlanRow {
  planId: number;
  parentId: number | null;
  label: string;
  code: string | null;
}
interface DossierRow {
  dossierId: number;
  parentId: number | null;
  label: string;
}
interface FileTypeRow {
  fileTypeId: number;
  friendlyName: string;
  extension: string;
}
interface TreeOpt {
  value: number;
  title: string;
  children?: TreeOpt[];
}

type Sort = { field: string; dir: 'asc' | 'desc' };

/** Criteria actually sent to the API (committed by "Rechercher" / chip removal). */
interface Criteria {
  fullText?: string;
  documentTypeId?: number;
  dossierId?: number;
  planId?: number;
  fileTypeId?: number;
  documentDateFrom?: string;
  documentDateTo?: string;
}

/** Build antd TreeSelect data from a flat, parentId-linked list. */
function buildTree<T extends { parentId: number | null }>(
  rows: T[],
  idOf: (r: T) => number,
  titleOf: (r: T) => string,
): TreeOpt[] {
  const byId = new Map<number, TreeOpt>();
  rows.forEach((r) => byId.set(idOf(r), { value: idOf(r), title: titleOf(r) }));
  const roots: TreeOpt[] = [];
  rows.forEach((r) => {
    const node = byId.get(idOf(r))!;
    const parent = r.parentId != null ? byId.get(r.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  });
  return roots;
}

/** Labelled field wrapper for the advanced filter grid. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
        {label}
      </Text>
      {children}
    </div>
  );
}

export default function SearchPage() {
  const { message } = App.useApp();

  // --- referentials ---
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [dossiers, setDossiers] = useState<DossierRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [fileTypes, setFileTypes] = useState<FileTypeRow[]>([]);

  // --- draft filter form (edited, not yet applied) ---
  const [qDraft, setQDraft] = useState('');
  const [typeDraft, setTypeDraft] = useState<number | null>(null);
  const [dossierDraft, setDossierDraft] = useState<number | null>(null);
  const [planDraft, setPlanDraft] = useState<number | null>(null);
  const [fileTypeDraft, setFileTypeDraft] = useState<number | null>(null);
  const [dateDraft, setDateDraft] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  // --- applied criteria + results ---
  const [applied, setApplied] = useState<Criteria>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort] = useState<Sort[]>([]);
  const [loading, setLoading] = useState(false);
  const [firstLoad, setFirstLoad] = useState(true);

  useEffect(() => {
    void (async () => {
      // Each referential loads independently: a single failing endpoint (e.g. a newly added one
      // not yet served) must not wipe out all the others — so no all-or-nothing Promise.all.
      const [t, d, p, ft] = await Promise.all([
        apiJson<TypeRow[]>('/referentials/document-types').catch(() => [] as TypeRow[]),
        apiJson<DossierRow[]>('/referentials/dossiers').catch(() => [] as DossierRow[]),
        apiJson<PlanRow[]>('/referentials/plans').catch(() => [] as PlanRow[]),
        apiJson<FileTypeRow[]>('/referentials/file-types').catch(() => [] as FileTypeRow[]),
      ]);
      setTypes(t);
      setDossiers(d);
      setPlans(p);
      setFileTypes(ft);
    })();
  }, []);

  const typeOptions = useMemo(
    () => types.map((t) => ({ value: t.documentTypeId, label: t.label })),
    [types],
  );
  const dossierTree = useMemo(
    () =>
      buildTree(
        dossiers,
        (d) => d.dossierId,
        (d) => d.label,
      ),
    [dossiers],
  );
  const planTree = useMemo(
    () =>
      buildTree(
        plans,
        (p) => p.planId,
        (p) => (p.code ? `${p.label} (${p.code})` : p.label),
      ),
    [plans],
  );
  const fileTypeOptions = useMemo(
    () =>
      fileTypes.map((f) => ({ value: f.fileTypeId, label: `${f.friendlyName} (${f.extension})` })),
    [fileTypes],
  );

  const typeLabel = useMemo(() => new Map(types.map((t) => [t.documentTypeId, t.label])), [types]);
  const dossierLabel = useMemo(
    () => new Map(dossiers.map((d) => [d.dossierId, d.label])),
    [dossiers],
  );
  const planLabel = useMemo(
    () => new Map(plans.map((p) => [p.planId, p.code ? `${p.label} (${p.code})` : p.label])),
    [plans],
  );
  const fileTypeLabel = useMemo(
    () => new Map(fileTypes.map((f) => [f.fileTypeId, `${f.friendlyName} (${f.extension})`])),
    [fileTypes],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiJson<SearchResult>('/documents/search', {
        method: 'POST',
        body: JSON.stringify({ ...applied, page, pageSize, sort }),
      });
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

  const buildCriteria = useCallback(
    (): Criteria => ({
      fullText: qDraft.trim() || undefined,
      documentTypeId: typeDraft ?? undefined,
      dossierId: dossierDraft ?? undefined,
      planId: planDraft ?? undefined,
      fileTypeId: fileTypeDraft ?? undefined,
      documentDateFrom: dateDraft?.[0] ? dateDraft[0].format('YYYY-MM-DD') : undefined,
      documentDateTo: dateDraft?.[1] ? dateDraft[1].format('YYYY-MM-DD') : undefined,
    }),
    [qDraft, typeDraft, dossierDraft, planDraft, fileTypeDraft, dateDraft],
  );

  const apply = () => {
    setApplied(buildCriteria());
    setPage(1);
  };

  const resetAll = () => {
    setQDraft('');
    setTypeDraft(null);
    setDossierDraft(null);
    setPlanDraft(null);
    setFileTypeDraft(null);
    setDateDraft(null);
    setApplied({});
    setSort([]);
    setPage(1);
  };

  const clearFilter = (key: keyof Criteria | 'date') => {
    if (key === 'date') {
      setDateDraft(null);
      setApplied((a) => ({ ...a, documentDateFrom: undefined, documentDateTo: undefined }));
    } else {
      if (key === 'fullText') setQDraft('');
      if (key === 'documentTypeId') setTypeDraft(null);
      if (key === 'dossierId') setDossierDraft(null);
      if (key === 'planId') setPlanDraft(null);
      if (key === 'fileTypeId') setFileTypeDraft(null);
      setApplied((a) => ({ ...a, [key]: undefined }));
    }
    setPage(1);
  };

  const fmt = (iso?: string) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '…');

  const chips: { key: string; text: string; onClose: () => void }[] = [];
  if (applied.fullText)
    chips.push({
      key: 'q',
      text: `Texte : « ${applied.fullText} »`,
      onClose: () => clearFilter('fullText'),
    });
  if (applied.documentTypeId)
    chips.push({
      key: 'type',
      text: `Type : ${typeLabel.get(applied.documentTypeId) ?? applied.documentTypeId}`,
      onClose: () => clearFilter('documentTypeId'),
    });
  if (applied.dossierId)
    chips.push({
      key: 'dossier',
      text: `Dossier : ${dossierLabel.get(applied.dossierId) ?? applied.dossierId}`,
      onClose: () => clearFilter('dossierId'),
    });
  if (applied.planId)
    chips.push({
      key: 'plan',
      text: `Plan : ${planLabel.get(applied.planId) ?? applied.planId}`,
      onClose: () => clearFilter('planId'),
    });
  if (applied.fileTypeId)
    chips.push({
      key: 'ftype',
      text: `Type de fichier : ${fileTypeLabel.get(applied.fileTypeId) ?? applied.fileTypeId}`,
      onClose: () => clearFilter('fileTypeId'),
    });
  if (applied.documentDateFrom || applied.documentDateTo)
    chips.push({
      key: 'date',
      text: `Date : ${fmt(applied.documentDateFrom)} → ${fmt(applied.documentDateTo)}`,
      onClose: () => clearFilter('date'),
    });

  // Filtres avancés appliqués = tous les chips sauf le plein-texte (affiché séparément, dans la barre).
  const advancedAppliedCount = chips.filter((c) => c.key !== 'q').length;

  const hasDraft = !!(
    qDraft ||
    typeDraft ||
    dossierDraft ||
    planDraft ||
    fileTypeDraft ||
    (dateDraft && (dateDraft[0] || dateDraft[1]))
  );
  const canReset = hasDraft || chips.length > 0 || sort.length > 0;

  const exportAs = useCallback(
    async (format: string) => {
      const token = window.localStorage.getItem('token');
      const res = await fetch(`${API_BASE}/documents/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ ...applied, sort, format }),
      });
      if (!res.ok) {
        message.error(`Export impossible (HTTP ${res.status})`);
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `documents.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [applied, sort, message],
  );

  const columns: TableColumnsType<Row> = [
    {
      title: 'Libellé',
      dataIndex: 'label',
      key: 'label',
      sorter: true,
      // Libellé sur deux lignes au maximum, puis coupe avec « … ».
      // Pas d'`ellipsis: true` : AntD poserait `white-space: nowrap` sur la cellule, ce qui
      // interdit la seconde ligne. Et pas de `width` de colonne non plus : le tableau est en
      // `scroll={{ x: 'max-content' }}`, donc la colonne se dimensionne sur le libellé le plus
      // long rendu d'une seule traite (mesuré : 690 px) et rien ne revenait jamais à la ligne.
      // C'est le `maxWidth` du contenu qui borne la contribution « max-content » de la colonne
      // (mesuré : 436 px avec les marges internes) et provoque donc le retour à la ligne.
      // `title` restitue le libellé entier au survol, comme le faisait `showTitle`.
      // Redirige vers la page de consultation dédiée (onglets Document/Métadonnées) au lieu
      // d'ouvrir une popup : URL partageable, et assez de place pour les métadonnées du type.
      render: (value: string, record) => (
        <Link
          href={`/documents/${record.documentId}`}
          title={value}
          className="line-clamp-2"
          style={{ maxWidth: 420 }}
        >
          {value}
        </Link>
      ),
    },
    {
      title: 'Type de document',
      dataIndex: 'documentType',
      key: 'documentType',
      sorter: true,
      width: 190,
      ellipsis: true,
      render: (v) => v || '—',
    },
    {
      title: 'Enregistré le',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: true,
      width: 160,
      render: (v: string) => dayjs(v).format('DD/MM/YYYY HH:mm'),
    },
    {
      title: 'Dossier',
      dataIndex: 'dossier',
      key: 'dossier',
      sorter: true,
      width: 180,
      ellipsis: true,
      render: (v) => v || '—',
    },
    {
      title: 'Plan de classement',
      dataIndex: 'plan',
      key: 'plan',
      sorter: true,
      width: 190,
      ellipsis: true,
      render: (v) => v || '—',
    },
  ];

  const onChange = (
    pagination: TablePaginationConfig,
    _filters: unknown,
    sorter: SorterResult<Row> | SorterResult<Row>[],
  ) => {
    setPage(pagination.current ?? 1);
    setPageSize(pagination.pageSize ?? 20);
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    if (s && s.order && s.columnKey) {
      setSort([{ field: String(s.columnKey), dir: s.order === 'ascend' ? 'asc' : 'desc' }]);
    } else {
      setSort([]);
    }
  };

  const exportButtons: { label: string; format: string }[] = [
    { label: 'Excel', format: 'xlsx' },
    { label: 'CSV', format: 'csv' },
    { label: 'PDF', format: 'pdf' },
    { label: 'Word', format: 'docx' },
  ];

  return (
    <div>
      <PageHeader icon="search" title="Recherche" />

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col flex="auto">
            <Input
              allowClear
              prefix={
                <icons.search
                  size={18}
                  strokeWidth={1.75}
                  style={{ color: 'var(--ant-color-text-tertiary)' }}
                />
              }
              placeholder="Rechercher dans le libellé, la référence et le texte OCR…"
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
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
              <Button icon={<icons.reset size={16} />} disabled={!canReset} onClick={resetAll}>
                Réinitialiser
              </Button>
            </Space>
          </Col>
        </Row>

        <Collapse
          ghost
          // Déplié seulement si des filtres AVANCÉS sont déjà posés (la recherche
          // plein texte, elle, a sa propre barre) : à vide, le panneau poussait les
          // résultats sous la ligne de flottaison. Le badge du libellé signale de
          // toute façon combien de filtres sont actifs une fois replié.
          defaultActiveKey={advancedAppliedCount > 0 ? ['adv'] : []}
          style={{ marginTop: 4 }}
          items={[
            {
              key: 'adv',
              label: (
                <Space>
                  <icons.filter size={16} strokeWidth={1.75} />
                  Filtres avancés
                  {advancedAppliedCount > 0 && (
                    <Badge count={advancedAppliedCount} color="var(--ant-color-primary)" />
                  )}
                </Space>
              ),
              children: (
                <Row gutter={[16, 16]}>
                  <Col xs={24} md={12} lg={8}>
                    <Field label="Type de document">
                      <Select
                        style={{ width: '100%' }}
                        value={typeDraft ?? undefined}
                        onChange={(v) => setTypeDraft((v as number) ?? null)}
                        options={typeOptions}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        placeholder="Tous les types"
                      />
                    </Field>
                  </Col>
                  <Col xs={24} md={12} lg={8}>
                    <Field label="Dossier">
                      <TreeSelect
                        style={{ width: '100%' }}
                        value={dossierDraft ?? undefined}
                        onChange={(v) => setDossierDraft((v as number) ?? null)}
                        treeData={dossierTree}
                        treeDefaultExpandAll
                        allowClear
                        showSearch
                        treeNodeFilterProp="title"
                        placeholder="Tous les dossiers"
                      />
                    </Field>
                  </Col>
                  <Col xs={24} md={12} lg={8}>
                    <Field label="Plan de classement">
                      <TreeSelect
                        style={{ width: '100%' }}
                        value={planDraft ?? undefined}
                        onChange={(v) => setPlanDraft((v as number) ?? null)}
                        treeData={planTree}
                        treeDefaultExpandAll
                        allowClear
                        showSearch
                        treeNodeFilterProp="title"
                        placeholder="Tous les plans"
                      />
                    </Field>
                  </Col>
                  <Col xs={24} md={12} lg={8}>
                    <Field label="Type de fichier">
                      <Select
                        style={{ width: '100%' }}
                        value={fileTypeDraft ?? undefined}
                        onChange={(v) => setFileTypeDraft((v as number) ?? null)}
                        options={fileTypeOptions}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        placeholder="Tous les types de fichier"
                      />
                    </Field>
                  </Col>
                  <Col xs={24} md={12} lg={8}>
                    <Field label="Date du document">
                      <RangePicker
                        style={{ width: '100%' }}
                        value={dateDraft}
                        onChange={(v) =>
                          setDateDraft((v ?? null) as [Dayjs | null, Dayjs | null] | null)
                        }
                        format="DD/MM/YYYY"
                        allowEmpty={[true, true]}
                        placeholder={['Du', 'Au']}
                      />
                    </Field>
                  </Col>
                </Row>
              ),
            },
          ]}
        />

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
              <a onClick={resetAll}>Tout effacer</a>
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
        extra={
          <Dropdown
            disabled={total === 0}
            menu={{
              items: exportButtons.map((b) => ({
                key: b.format,
                label: b.label,
                icon: <icons.download size={14} strokeWidth={1.75} />,
                onClick: () => void exportAs(b.format),
              })),
            }}
          >
            <Button size="small" icon={<icons.download size={15} />}>
              Exporter <icons.chevronDown size={13} strokeWidth={2} />
            </Button>
          </Dropdown>
        }
      >
        {firstLoad && loading ? (
          <TableSkeleton rows={8} columns={6} />
        ) : total === 0 && !loading ? (
          <EmptyState
            icon="search"
            title="Aucun document ne correspond à ces critères"
            action={canReset ? <Button onClick={resetAll}>Tout effacer</Button> : undefined}
          />
        ) : (
          <motion.div
            key={`${JSON.stringify(applied)}-${page}-${pageSize}`}
            variants={fade}
            initial="hidden"
            animate="show"
          >
            <Table<Row>
              rowKey="documentId"
              columns={columns}
              dataSource={rows}
              loading={loading && !firstLoad}
              // Densité « production » (PRD relook §6.6) : c'est l'écran où l'on balaie
              // des listes longues — les lignes descendent à ~34 px et on en voit plus.
              size="small"
              scroll={{ x: 'max-content' }}
              pagination={{
                current: page,
                pageSize,
                total,
                showSizeChanger: true,
                pageSizeOptions: [10, 20, 50, 100],
                showTotal: (t) => `${t} document(s)`,
              }}
              onChange={onChange}
            />
          </motion.div>
        )}
      </Card>
    </div>
  );
}
