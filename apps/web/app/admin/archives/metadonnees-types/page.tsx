'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { CountBadge } from '../../../components/CountBadge';
import { PageHeader } from '../../../components/PageHeader';
import { NewItemField } from '../../../components/RefLayout';
import { icons } from '../../../theme/icons';
import { fontSize } from '../../../theme/tokens';
import {
  metaDataDocumentTypesApi,
  metaDatasApi,
  lookups,
  MetaDataType,
  METADATA_TYPE_LABELS,
  type DocumentTypeOption,
  type MetaDataDocumentTypeRow,
  type MetaDataRow,
} from '../../../lib/archives';

const typeLabel = (dataType: number) =>
  METADATA_TYPE_LABELS[dataType as MetaDataType] ?? METADATA_TYPE_LABELS[MetaDataType.Aucun];

/**
 * Conséquence énoncée dans les confirmations (« verbe + objet + conséquence ») : délier ne touche
 * qu'au formulaire d'indexation à venir ; le serveur ne supprime que les lignes de liaison.
 */
const EFFET_DELIAISON =
  'Les champs correspondants disparaîtront du formulaire d’indexation de ce type. Les valeurs déjà saisies sur les documents restent en base.';

/**
 * §7 — Association métadonnées ↔ types de documents : ce sont ces liens qui composent le
 * formulaire dynamique d'indexation d'un type.
 *
 * Deux gestes, volontairement distincts (le source les mélangeait sous le même écran) :
 *  - ASSOCIER : ajoute le produit cartésien types × métadonnées, sans rien retirer. C'est le
 *    geste de masse (« ces trois métadonnées sur ces cinq types »).
 *  - REMPLACER : fixe la liste exacte des métadonnées d'UN type. C'est le geste de correction ;
 *    tout ce qui n'est pas coché est délié, d'où un seul type à la fois.
 */
export default function MetaDataDocumentTypesPage() {
  const { message } = App.useApp();
  const [links, setLinks] = useState<MetaDataDocumentTypeRow[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeOption[]>([]);
  const [metaDatas, setMetaDatas] = useState<MetaDataRow[]>([]);

  // Formulaire « associer » (masse)
  const [linkTypeIds, setLinkTypeIds] = useState<number[]>([]);
  const [linkMetaIds, setLinkMetaIds] = useState<number[]>([]);
  // Formulaire « remplacer » (un type)
  const [editTypeId, setEditTypeId] = useState<number | null>(null);
  const [editMetaIds, setEditMetaIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, dt, md] = await Promise.all([
        metaDataDocumentTypesApi.list(),
        lookups.documentTypes(),
        metaDatasApi.list(),
      ]);
      setLinks(l);
      setDocumentTypes(dt);
      setMetaDatas(md);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const typeOptions = useMemo(
    () => documentTypes.map((t) => ({ value: t.documentTypeId, label: t.label })),
    [documentTypes],
  );
  const metaOptions = useMemo(
    () =>
      metaDatas.map((m) => ({
        value: m.metaDataId,
        label: `${m.label} — ${typeLabel(m.dataType)}`,
      })),
    [metaDatas],
  );

  /**
   * Liens REGROUPÉS par type de document — une ligne « en-tête » par type, à plier/déplier
   * (comme un accordéon) pour révéler ses métadonnées. Remplace l'ancien tableau plat à cellule
   * fusionnée : sur 20 types, l'accordéon laisse fermé ce qui n'intéresse pas l'utilisateur du
   * moment, plutôt que d'imposer 87 lignes à l'écran. Remplace aussi l'ancien « Récapitulatif »
   * séparé, qui montrait la même information sans les actions.
   */
  const groupedByType = useMemo(() => {
    const parType = new Map<
      number,
      { documentTypeId: number; documentTypeLabel: string; items: MetaDataDocumentTypeRow[] }
    >();
    for (const link of links) {
      const groupe = parType.get(link.documentTypeId) ?? {
        documentTypeId: link.documentTypeId,
        documentTypeLabel: link.documentType.label,
        items: [],
      };
      groupe.items.push(link);
      parType.set(link.documentTypeId, groupe);
    }
    const groupes = [...parType.values()];
    groupes.forEach((g) =>
      g.items.sort((a, b) => a.metaData.label.localeCompare(b.metaData.label, 'fr')),
    );
    groupes.sort((a, b) => a.documentTypeLabel.localeCompare(b.documentTypeLabel, 'fr'));
    return groupes;
  }, [links]);

  /**
   * Nombre de liaisons que « Enregistrer la liste » RETIRERAIT en l'état : c'est le chiffre que la
   * confirmation annonce, le geste étant un remplacement et non un ajout.
   */
  const deliaisons = useMemo(
    () =>
      editTypeId == null
        ? 0
        : links.filter(
            (l) => l.documentTypeId === editTypeId && !editMetaIds.includes(l.metaDataId),
          ).length,
    [links, editTypeId, editMetaIds],
  );

  /** Charger un type dans le formulaire « remplacer » pré-coche ses métadonnées actuelles. */
  const selectEditType = (documentTypeId: number | null) => {
    setEditTypeId(documentTypeId);
    setEditMetaIds(
      documentTypeId == null
        ? []
        : links.filter((l) => l.documentTypeId === documentTypeId).map((l) => l.metaDataId),
    );
  };

  const associate = async () => {
    if (!linkTypeIds.length || !linkMetaIds.length) return;
    setBusy(true);
    try {
      const r = await metaDataDocumentTypesApi.link(linkTypeIds, linkMetaIds);
      await load();
      message.success(
        r.alreadyLinked > 0
          ? `${r.created} association(s) créée(s) — ${r.alreadyLinked} déjà en place`
          : `${r.created} association(s) créée(s)`,
      );
      setLinkTypeIds([]);
      setLinkMetaIds([]);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Association impossible');
    } finally {
      setBusy(false);
    }
  };

  const replace = async () => {
    if (editTypeId == null) return;
    setBusy(true);
    try {
      await metaDataDocumentTypesApi.setForType(editTypeId, editMetaIds);
      await load();
      message.success('Liste des métadonnées mise à jour');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Mise à jour impossible');
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (ids: number[]) => {
    try {
      await metaDataDocumentTypesApi.unlink(ids);
      await load();
      message.success(
        ids.length > 1 ? `${ids.length} associations supprimées` : 'Association supprimée',
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Suppression impossible');
    }
  };

  /** Un groupe = un type de document et ses associations (voir `groupedByType`). */
  interface TypeGroup {
    documentTypeId: number;
    documentTypeLabel: string;
    items: MetaDataDocumentTypeRow[];
  }

  /** Ligne d'en-tête (accordéon) : le type et le nombre de métadonnées qui lui sont associées. */
  const outerColumns: TableColumnsType<TypeGroup> = [
    {
      title: 'Type de document',
      key: 'documentType',
      render: (_, g) => (
        <Space>
          <Typography.Text strong>{g.documentTypeLabel}</Typography.Text>
          <CountBadge value={g.items.length} label={`métadonnée${g.items.length > 1 ? 's' : ''}`} />
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 180,
      align: 'right',
      render: (_, g) => (
        <Popconfirm
          title={`Retirer les ${g.items.length} métadonnées de ce type ?`}
          description={EFFET_DELIAISON}
          okText="Tout retirer"
          okButtonProps={{ danger: true }}
          cancelText="Annuler"
          onConfirm={() => void unlink(g.items.map((i) => i.metaDataDocumentTypeId))}
        >
          <Button danger size="small" icon={<icons.delete size={14} />}>
            Tout retirer
          </Button>
        </Popconfirm>
      ),
    },
  ];

  /** Contenu déplié : le détail des métadonnées de ce type, retrait individuel possible. */
  const innerColumns: TableColumnsType<MetaDataDocumentTypeRow> = [
    { title: 'Métadonnée', key: 'metaData', render: (_, r) => r.metaData.label },
    {
      title: 'Type de saisie',
      key: 'dataType',
      width: 160,
      render: (_, r) => <Tag>{typeLabel(r.metaData.dataType)}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      width: 56,
      align: 'center',
      render: (_, r) => (
        <Popconfirm
          title="Retirer cette métadonnée de ce type ?"
          description={EFFET_DELIAISON}
          okText="Retirer"
          okButtonProps={{ danger: true }}
          cancelText="Annuler"
          onConfirm={() => void unlink([r.metaDataDocumentTypeId])}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label="Retirer cette métadonnée de ce type"
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <PageHeader icon="classification" title="Métadonnées par type de document" />

      <Row gutter={[16, 16]} align="top">
        <Col xs={24} lg={15}>
          <Card title="Associations">
            {/* Un type = une ligne d'en-tête repliée par défaut ; on déplie ceux qu'on veut
                inspecter, plutôt que d'imposer les 87 associations d'un coup. */}
            <Table<TypeGroup>
              rowKey="documentTypeId"
              dataSource={groupedByType}
              columns={outerColumns}
              size="middle"
              scroll={{ x: 'max-content' }}
              pagination={false}
              locale={{ emptyText: 'Aucune association pour le moment' }}
              // Ligne de GROUPE posée sur le fond de layout : sans elle, l'en-tête d'accordéon et
              // son contenu déplié formaient une nappe uniforme où le regroupement se devinait.
              onRow={() => ({ style: { background: 'var(--ant-color-bg-layout)' } })}
              expandable={{
                expandedRowRender: (g) => (
                  <Table<MetaDataDocumentTypeRow>
                    rowKey="metaDataDocumentTypeId"
                    dataSource={g.items}
                    columns={innerColumns}
                    size="small"
                    pagination={false}
                    showHeader
                  />
                ),
              }}
            />
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card title="Associer (ajout)">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <NewItemField label="Types de documents" required>
                <Select
                  mode="multiple"
                  style={{ width: '100%' }}
                  value={linkTypeIds}
                  onChange={setLinkTypeIds}
                  options={typeOptions}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Un ou plusieurs types"
                />
              </NewItemField>
              <NewItemField label="Métadonnées" required>
                <Select
                  mode="multiple"
                  style={{ width: '100%' }}
                  value={linkMetaIds}
                  onChange={setLinkMetaIds}
                  options={metaOptions}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Une ou plusieurs métadonnées"
                />
              </NewItemField>
              <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                Chaque type sélectionné reçoit chaque métadonnée sélectionnée. Les associations déjà
                en place sont conservées telles quelles.
              </Typography.Text>
              <Button
                type="primary"
                block
                loading={busy}
                disabled={!linkTypeIds.length || !linkMetaIds.length}
                onClick={() => void associate()}
              >
                Associer
              </Button>
            </Space>
          </Card>

          <Card title="Remplacer la liste d'un type" style={{ marginTop: 16 }}>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <NewItemField label="Type de document" required>
                <Select
                  style={{ width: '100%' }}
                  value={editTypeId ?? undefined}
                  onChange={(v) => selectEditType((v as number) ?? null)}
                  options={typeOptions}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Sélectionner un type"
                />
              </NewItemField>
              <NewItemField label="Métadonnées de ce type">
                <Select
                  mode="multiple"
                  style={{ width: '100%' }}
                  value={editMetaIds}
                  onChange={setEditMetaIds}
                  options={metaOptions}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Aucune"
                  disabled={editTypeId == null}
                />
              </NewItemField>
              {/* `type="warning"` retombe sur `colorWarning`, c'est-à-dire le dérivé FORT AA
                    (#dd2a00) — le warning vif ne porte jamais de texte (règle d'or §4.1). */}
              <Typography.Text type="warning" style={{ fontSize: fontSize.xs }}>
                Les métadonnées retirées de cette liste seront déliées de ce type.
              </Typography.Text>
              {/* Geste de REMPLACEMENT : il délie tout ce qui n'est plus coché. Il porte donc le
                    poids visuel d'une action primaire, vire au danger dès qu'il retire quelque
                    chose, et annonce le nombre de déliaisons avant de partir. Pas d'`onClick` sur
                    le bouton : Popconfirm relaie déjà le clic de son enfant, l'action se
                    déclencherait avant la confirmation. */}
              <Popconfirm
                title={
                  deliaisons > 0
                    ? `Retirer ${deliaisons} métadonnée${deliaisons > 1 ? 's' : ''} de ce type ?`
                    : 'Enregistrer la liste de ce type ?'
                }
                description={
                  deliaisons > 0
                    ? EFFET_DELIAISON
                    : 'Les métadonnées cochées composeront le formulaire d’indexation de ce type.'
                }
                okText="Enregistrer"
                okButtonProps={{ danger: deliaisons > 0 }}
                cancelText="Annuler"
                onConfirm={() => void replace()}
              >
                <Button
                  type="primary"
                  danger={deliaisons > 0}
                  block
                  loading={busy}
                  disabled={editTypeId == null}
                >
                  Enregistrer la liste
                </Button>
              </Popconfirm>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
