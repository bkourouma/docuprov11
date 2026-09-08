'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  TreeSelect,
} from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { NewItemField } from '../../components/RefLayout';
import type { TreeOption } from '../../components/editable';
import { icons } from '../../theme/icons';
import { fontSize } from '../../theme/tokens';
import {
  lendingMotivesApi,
  lendingsApi,
  lookups,
  type ActorOption,
  type DossierOption,
  type LendableDocument,
  type LendingMotiveRow,
} from '../../lib/archives';

/** Reconstruit l'arborescence des dossiers à partir de la liste plate. */
function dossierTree(rows: DossierOption[]): TreeOption[] {
  const nodes = new Map<number, TreeOption & { parentId: number | null }>();
  rows.forEach((r) =>
    nodes.set(r.dossierId, { value: r.dossierId, title: r.label, parentId: r.parentId }),
  );
  const roots: TreeOption[] = [];
  nodes.forEach((node) => {
    const parent = node.parentId != null ? nodes.get(node.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  });
  return roots;
}

/**
 * Docu-Archives §3 — Communiquer un document.
 *
 * Enchaînement : on choisit un DOSSIER, la liste de ses documents communicables se charge, on
 * coche ceux qui sortent, on désigne le bénéficiaire, le motif et les dates.
 *
 * Ne sont proposés que les documents réellement communicables : ceux déjà sortis et non rendus,
 * les documents épurés et les documents gelés sont écartés par le serveur. Le module source
 * proposait tout le dossier, ce qui laissait créer deux prêts concurrents sur la même pièce.
 */
export default function CommuniquerPage() {
  const { message } = App.useApp();
  const router = useRouter();

  const [dossiers, setDossiers] = useState<DossierOption[]>([]);
  const [motives, setMotives] = useState<LendingMotiveRow[]>([]);
  const [actors, setActors] = useState<ActorOption[]>([]);
  const [documents, setDocuments] = useState<LendableDocument[]>([]);

  const [dossierId, setDossierId] = useState<number | null>(null);
  const [documentIds, setDocumentIds] = useState<number[]>([]);
  const [userGroupId, setUserGroupId] = useState<number | null>(null);
  const [lendingMotiveId, setLendingMotiveId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState<Dayjs>(dayjs());
  const [projectedReturnDate, setProjectedReturnDate] = useState<Dayjs>(dayjs().add(15, 'day'));

  const [loadingDocs, setLoadingDocs] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [d, m, a] = await Promise.all([
          lookups.dossiers(),
          lendingMotivesApi.list(),
          lookups.actors(),
        ]);
        setDossiers(d);
        setMotives(m);
        setActors(a);
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Erreur de chargement');
      }
    })();
  }, [message]);

  /** Changer de dossier recharge la liste et remet la sélection à zéro (§3 du source). */
  const loadDocuments = useCallback(
    async (id: number) => {
      setLoadingDocs(true);
      setDocumentIds([]);
      try {
        setDocuments(await lendingsApi.lendableDocuments(id));
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Chargement des documents impossible');
        setDocuments([]);
      } finally {
        setLoadingDocs(false);
      }
    },
    [message],
  );

  const onDossierChange = (v: number | null) => {
    setDossierId(v);
    setDocuments([]);
    setDocumentIds([]);
    if (v != null) void loadDocuments(v);
  };

  const dossierOptions = useMemo(() => dossierTree(dossiers), [dossiers]);
  const motiveOptions = useMemo(
    () => motives.map((m) => ({ value: m.lendingMotiveId, label: m.label })),
    [motives],
  );
  const actorOptions = useMemo(
    () => actors.map((a) => ({ value: a.userGroupId, label: a.label })),
    [actors],
  );

  /** Toutes les conditions du formulaire, énoncées une fois — le bouton et le message les partagent. */
  const problems = useMemo(() => {
    const list: string[] = [];
    if (dossierId == null) list.push('Choisissez un dossier');
    if (documentIds.length === 0) list.push('Sélectionnez au moins un document');
    if (userGroupId == null) list.push('Désignez le bénéficiaire');
    if (lendingMotiveId == null) list.push('Choisissez un motif');
    if (startDate.isAfter(dayjs(), 'day')) list.push('La date de début ne peut pas être future');
    if (projectedReturnDate.isBefore(startDate, 'day')) {
      list.push('La date de retour prévue doit suivre la date de début');
    }
    return list;
  }, [dossierId, documentIds, userGroupId, lendingMotiveId, startDate, projectedReturnDate]);

  const submit = async () => {
    if (problems.length || userGroupId == null || lendingMotiveId == null) return;
    setSaving(true);
    try {
      await lendingsApi.create({
        documentIds,
        userGroupId,
        lendingMotiveId,
        startDate: startDate.format('YYYY-MM-DD'),
        projectedReturnDate: projectedReturnDate.format('YYYY-MM-DD'),
      });
      message.success(
        documentIds.length > 1
          ? `${documentIds.length} documents communiqués`
          : 'Document communiqué',
      );
      router.push('/archives/documents-communiques');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Communication impossible');
      // Le serveur refuse notamment les documents entre-temps prêtés par quelqu'un d'autre :
      // on rafraîchit la liste pour que l'écran cesse de proposer ce qui n'est plus disponible.
      if (dossierId != null) void loadDocuments(dossierId);
    } finally {
      setSaving(false);
    }
  };

  const dash = <Typography.Text type="secondary">—</Typography.Text>;

  const columns: TableColumnsType<LendableDocument> = [
    {
      title: 'Document',
      key: 'label',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.label}</span>
          {r.cote && (
            <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
              N° pièce {r.cote}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Type',
      key: 'documentTypeName',
      width: 180,
      render: (_, r) => (r.documentTypeName ? <Tag>{r.documentTypeName}</Tag> : dash),
    },
    {
      title: 'Date',
      key: 'documentDate',
      width: 120,
      render: (_, r) => (r.documentDate ? dayjs(r.documentDate).format('DD/MM/YYYY') : dash),
    },
  ];

  return (
    <div>
      <PageHeader icon="send" title="Communiquer un document" />

      <Row gutter={[16, 16]} align="top">
        <Col xs={24} lg={15}>
          <Card title="Documents du dossier">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <NewItemField label="Dossier" required>
                <TreeSelect
                  style={{ width: '100%' }}
                  value={dossierId ?? undefined}
                  onChange={(v) => onDossierChange((v as number) ?? null)}
                  treeData={dossierOptions}
                  treeDefaultExpandAll
                  showSearch
                  allowClear
                  treeNodeFilterProp="title"
                  placeholder="Sélectionner un dossier"
                />
              </NewItemField>
              {dossierId == null ? (
                <EmptyState icon="dossier" title="Choisissez un dossier" />
              ) : (
                <Table<LendableDocument>
                  rowKey="documentId"
                  dataSource={documents}
                  columns={columns}
                  loading={loadingDocs}
                  size="small"
                  scroll={{ x: 'max-content' }}
                  rowSelection={{
                    selectedRowKeys: documentIds,
                    onChange: (keys) => setDocumentIds(keys as number[]),
                  }}
                  // L'information « rien à sortir ici » tient dans l'état vide de la table :
                  // une Alerte au-dessus d'une table vide disait deux fois la même chose.
                  locale={{
                    emptyText: (
                      <EmptyState
                        compact
                        icon="dossier"
                        title="Aucun document communicable dans ce dossier"
                      />
                    ),
                  }}
                  pagination={{
                    pageSize: 10,
                    showSizeChanger: true,
                    showTotal: (t) => `${t} document(s) communicable(s)`,
                  }}
                />
              )}
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card title="Communication">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <NewItemField label="Bénéficiaire" required>
                <Select
                  style={{ width: '100%' }}
                  value={userGroupId ?? undefined}
                  onChange={(v) => setUserGroupId((v as number) ?? null)}
                  options={actorOptions}
                  showSearch
                  optionFilterProp="label"
                  placeholder="À qui le document est-il remis ?"
                />
              </NewItemField>
              <NewItemField label="Motif" required>
                <Select
                  style={{ width: '100%' }}
                  value={lendingMotiveId ?? undefined}
                  onChange={(v) => setLendingMotiveId((v as number) ?? null)}
                  options={motiveOptions}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Pourquoi ce document sort-il ?"
                  notFoundContent="Aucun motif — paramétrez-en dans « Motifs de prêt »"
                />
              </NewItemField>
              <NewItemField label="Date de début" required>
                <DatePicker
                  // Une date tient en 10 caractères : l'étirer sur toute la colonne
                  // désignait une saisie plus longue qu'elle ne l'est.
                  style={{ width: '100%', maxWidth: 320 }}
                  value={startDate}
                  onChange={(v) => v && setStartDate(v)}
                  format="DD/MM/YYYY"
                  allowClear={false}
                  // La sortie est constatée, pas planifiée : une date future n'aurait pas de sens.
                  disabledDate={(d) => d.isAfter(dayjs(), 'day')}
                />
              </NewItemField>
              <NewItemField label="Retour prévu" required>
                <DatePicker
                  style={{ width: '100%', maxWidth: 320 }}
                  value={projectedReturnDate}
                  onChange={(v) => v && setProjectedReturnDate(v)}
                  format="DD/MM/YYYY"
                  allowClear={false}
                  disabledDate={(d) => d.isBefore(startDate, 'day')}
                />
              </NewItemField>

              {/* Un SEUL encart d'état : les deux Alertes empilées se répondaient à
                    moitié (« N sélectionnés » sous « À compléter »). */}
              {problems.length > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  message="À compléter"
                  description={
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  }
                />
              ) : (
                <Alert
                  type="success"
                  showIcon
                  message={`Prêt à communiquer — ${documentIds.length} document(s) sélectionné(s)`}
                />
              )}

              <Button
                type="primary"
                block
                loading={saving}
                disabled={problems.length > 0}
                icon={<icons.send size={16} />}
                onClick={() => void submit()}
              >
                Communiquer
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
