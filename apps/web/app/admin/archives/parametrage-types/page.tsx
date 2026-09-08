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
  Tooltip,
  TreeSelect,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PageHeader } from '../../../components/PageHeader';
import { FormAbovePanel } from '../../../components/archives/FormAbovePanel';
import { NewItemField } from '../../../components/RefLayout';
import { type TreeOption } from '../../../components/editable';
import { icons } from '../../../theme/icons';
import { fontSize, space } from '../../../theme/tokens';
import { apiJson } from '../../../lib/api';
import { filterByLabel } from '../../../lib/filters';
import {
  documentTypeSettingsApi,
  lookups,
  type ConfidentialiteOption,
  type DocumentTypeOption,
  type DocumentTypeSettingRow,
  type DossierOption,
  type PlanOption,
} from '../../../lib/archives';

interface TreeNode {
  id: number;
  parentId: number | null;
  label: string;
  /** Sert UNIQUEMENT au tri (ordre naturel des cotes) ; jamais affiché. */
  code?: string | null;
  children?: TreeNode[];
}

/** Reconstruit une arborescence à partir d'une liste plate (dossiers, plan de classement). */
function buildTree(rows: TreeNode[]): TreeNode[] {
  const byId = new Map<number, TreeNode>();
  rows.forEach((r) => byId.set(r.id, { ...r }));
  const roots: TreeNode[] = [];
  byId.forEach((node) => {
    const parent = node.parentId != null ? byId.get(node.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  });
  return roots;
}

/**
 * Tri par COTE en comparaison naturelle, comme l'écran « Plan de classement » : le serveur trie
 * par `path`, une chaîne où « /10/ » précède « /2/ ». Sans cela, les rubriques cotées
 * apparaîtraient dans le désordre dans le sélecteur — la cote pilote l'ordre mais ne s'affiche pas.
 */
function sortTree(nodes: TreeNode[]): TreeNode[] {
  const cmp = (a: TreeNode, b: TreeNode): number => {
    if (a.code && b.code) return a.code.localeCompare(b.code, 'fr', { numeric: true });
    if (a.code) return -1;
    if (b.code) return 1;
    return a.label.localeCompare(b.label, 'fr');
  };
  nodes.sort(cmp);
  nodes.forEach((n) => n.children && sortTree(n.children));
  return nodes;
}

/** Options de sélection : LIBELLÉ SEUL, sans la cote — l'indentation de l'arbre suffit à lire la hiérarchie. */
function toOptions(nodes: TreeNode[]): TreeOption[] {
  return nodes.map((n) => ({
    value: n.id,
    title: n.label,
    children: n.children ? toOptions(n.children) : undefined,
  }));
}

/** Valeurs du formulaire — un paramétrage entièrement vide est légitime (« aucun défaut »). */
interface FormState {
  documentTypeId: number | null;
  dossierId: number | null;
  planId: number | null;
  confidentialiteId: number | null;
  ocr: boolean;
  cryptage: boolean;
  tauxCompression: number | null;
  profilScanner: string;
  routines: string;
}

/**
 * Conséquences énoncées dans les confirmations (« verbe + objet + conséquence ») : supprimer un
 * paramétrage ne touche ni au type de document ni aux pièces déjà classées — il retire seulement
 * le pré-remplissage appliqué aux prochaines.
 */
const EFFET_UN =
  'Le type de document n’aura plus de dossier, de plan de classement ni de confidentialité par défaut : les prochains documents de ce type arriveront sans pré-remplissage.';
const EFFET_PLUSIEURS =
  'Ces types de documents n’auront plus de dossier, de plan de classement ni de confidentialité par défaut : leurs prochains documents arriveront sans pré-remplissage.';

const EMPTY: FormState = {
  documentTypeId: null,
  dossierId: null,
  planId: null,
  confidentialiteId: null,
  ocr: false,
  cryptage: false,
  tauxCompression: null,
  profilScanner: '',
  routines: '',
};

/**
 * §1 — Rangement de chaque type de document : le DOSSIER où la pièce est classée, le PLAN DE
 * CLASSEMENT dont elle relève, et sa CONFIDENTIALITÉ par défaut. Ces valeurs pré-remplissent le
 * formulaire d'indexation dès qu'un type est choisi (et, pour la confidentialité, sont posées sur
 * le document dès sa création par le worker).
 *
 * La consigne de numérisation (OCR, cryptage, compression, profil de scanner) existe toujours en
 * base (`document_type_setting`) mais n'est plus éditable depuis cet écran ni affichée nulle part
 * — retirée de l'interface, pas du modèle : le formulaire continue de renvoyer ses valeurs telles
 * que chargées, sans les modifier.
 *
 * Un paramétrage par type (la clé métier est le type lui-même) : sélectionner un type déjà
 * paramétré charge ses valeurs, et l'enregistrement les remplace. Le module source autorisait
 * plusieurs lignes par type sans dire laquelle l'emportait, ce qui rendait le pré-remplissage
 * imprévisible.
 *
 * Layout : bouton en tête de page, le formulaire s'ouvre AU-DESSUS du tableau (pas de panneau
 * latéral) avec ses champs disposés deux par ligne.
 */
export default function DocumentTypeSettingsPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<DocumentTypeSettingRow[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeOption[]>([]);
  const [dossiers, setDossiers] = useState<DossierOption[]>([]);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [confidentialites, setConfidentialites] = useState<ConfidentialiteOption[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  /** Ancre de recentrage : le formulaire s'ouvre en haut de page, loin de la ligne cliquée. */
  const [focusSignal, setFocusSignal] = useState(0);

  const load = useCallback(async () => {
    try {
      const [s, dt, dos, pl, conf] = await Promise.all([
        documentTypeSettingsApi.list(),
        lookups.documentTypes(),
        lookups.dossiers(),
        lookups.plans(),
        apiJson<ConfidentialiteOption[]>('/referentials/confidentialites'),
      ]);
      setRows(s);
      setDocumentTypes(dt);
      setDossiers(dos);
      setPlans(pl);
      setConfidentialites(conf);
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
  const dossierOptions = useMemo(
    () =>
      toOptions(
        sortTree(
          buildTree(
            dossiers.map((d) => ({
              id: d.dossierId,
              parentId: d.parentId,
              label: d.label,
              code: d.code,
            })),
          ),
        ),
      ),
    [dossiers],
  );
  const planOptions = useMemo(
    () =>
      toOptions(
        sortTree(
          buildTree(
            plans.map((p) => ({
              id: p.planId,
              parentId: p.parentId,
              label: p.label,
              code: p.code,
            })),
          ),
        ),
      ),
    [plans],
  );

  /** Charge le paramétrage existant d'un type, ou repart à vide s'il n'en a pas encore. */
  const selectType = (documentTypeId: number | null) => {
    const existing = rows.find((r) => r.documentTypeId === documentTypeId);
    setForm(
      existing
        ? {
            documentTypeId,
            dossierId: existing.dossierId,
            planId: existing.planId,
            confidentialiteId: existing.confidentialiteId,
            ocr: existing.ocr,
            cryptage: existing.cryptage,
            tauxCompression: existing.tauxCompression,
            profilScanner: existing.profilScanner ?? '',
            routines: existing.routines ?? '',
          }
        : { ...EMPTY, documentTypeId },
    );
  };

  /** Ouvre le formulaire chargé du paramétrage de cette ligne (bouton crayon du tableau). */
  const editRow = (documentTypeId: number) => {
    selectType(documentTypeId);
    setFormOpen(true);
    // Réclame le défilement même si le panneau était déjà ouvert (clic sur une 2e ligne).
    setFocusSignal((n) => n + 1);
  };

  const save = async () => {
    if (form.documentTypeId == null) return;
    setBusy(true);
    try {
      await documentTypeSettingsApi.save({
        documentTypeId: form.documentTypeId,
        dossierId: form.dossierId,
        planId: form.planId,
        confidentialiteId: form.confidentialiteId,
        ocr: form.ocr,
        cryptage: form.cryptage,
        tauxCompression: form.tauxCompression,
        // Chaîne vide = champ vidé : le serveur la ramène à `null`.
        profilScanner: form.profilScanner.trim() || null,
        routines: form.routines.trim() || null,
      });
      await load();
      message.success('Paramétrage enregistré');
      setForm(EMPTY);
      setFormOpen(false);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ids: number[]) => {
    try {
      await documentTypeSettingsApi.remove(ids);
      setSelected((s) => s.filter((id) => !ids.includes(id)));
      await load();
      message.success(
        ids.length > 1 ? `${ids.length} paramétrages supprimés` : 'Paramétrage supprimé',
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Suppression impossible');
    }
  };

  const dash = <Typography.Text type="secondary">—</Typography.Text>;
  /** Libellé seul, sans la cote — demandé pour rester lisible dans le tableau. */
  const cellLabel = (ref: { label: string } | null) => (ref ? ref.label : dash);

  const columns: TableColumnsType<DocumentTypeSettingRow> = [
    {
      title: 'Type de document',
      key: 'documentType',
      render: (_, r) => <Typography.Text strong>{r.documentType.label}</Typography.Text>,
      sorter: (a, b) => a.documentType.label.localeCompare(b.documentType.label, 'fr'),
    },
    { title: 'Dossier', key: 'dossier', render: (_, r) => cellLabel(r.dossier) },
    { title: 'Plan de classement', key: 'plan', render: (_, r) => cellLabel(r.plan) },
    {
      title: 'Confidentialité',
      key: 'confidentialite',
      render: (_, r) => cellLabel(r.confidentialite),
    },
    {
      title: '',
      key: 'actions',
      width: 96,
      align: 'center',
      render: (_, r) => (
        <Space size={0}>
          <Tooltip title="Charger dans le formulaire pour modifier">
            <Button
              type="text"
              size="small"
              aria-label="Charger ce paramétrage dans le formulaire"
              icon={<icons.edit size={16} />}
              onClick={() => editRow(r.documentTypeId)}
            />
          </Tooltip>
          <Popconfirm
            title="Supprimer ce paramétrage ?"
            description={EFFET_UN}
            okText="Supprimer"
            okButtonProps={{ danger: true }}
            cancelText="Annuler"
            onConfirm={() => void remove([r.documentTypeSettingId])}
          >
            <Button
              type="text"
              danger
              size="small"
              aria-label="Supprimer ce paramétrage"
              icon={<icons.delete size={16} />}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader icon="settings" title="Paramétrage des types de documents" />

      <FormAbovePanel
        open={formOpen}
        onToggle={() => {
          if (formOpen) setForm(EMPTY);
          setFormOpen((v) => !v);
        }}
        triggerLabel="Nouveau paramétrage"
        title="Paramétrer un type"
        focusSignal={focusSignal}
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <NewItemField label="Type de document" required>
              <Select
                style={{ width: '100%' }}
                value={form.documentTypeId ?? undefined}
                onChange={(v) => selectType((v as number) ?? null)}
                options={typeOptions}
                showSearch
                optionFilterProp="label"
                placeholder="Sélectionner un type"
              />
            </NewItemField>
            {form.documentTypeId != null &&
              rows.some((r) => r.documentTypeId === form.documentTypeId) && (
                // `type="warning"` retombe sur `colorWarning`, c'est-à-dire le dérivé FORT AA
                // (#dd2a00) — le warning vif ne porte jamais de texte (règle d'or §4.1).
                <Typography.Text
                  type="warning"
                  style={{ display: 'block', marginTop: space.xs, fontSize: fontSize.xs }}
                >
                  Ce type est déjà paramétré : l&apos;enregistrement remplacera ses valeurs.
                </Typography.Text>
              )}
          </Col>
          <Col xs={24} md={12}>
            <NewItemField label="Dossier">
              <TreeSelect
                style={{ width: '100%' }}
                value={form.dossierId ?? undefined}
                onChange={(v) => setForm((f) => ({ ...f, dossierId: (v as number) ?? null }))}
                treeData={dossierOptions}
                treeDefaultExpandAll
                allowClear
                showSearch
                treeNodeFilterProp="title"
                placeholder="Aucun"
              />
            </NewItemField>
          </Col>
          <Col xs={24} md={12}>
            <NewItemField label="Plan de classement">
              <TreeSelect
                style={{ width: '100%' }}
                value={form.planId ?? undefined}
                onChange={(v) => setForm((f) => ({ ...f, planId: (v as number) ?? null }))}
                treeData={planOptions}
                treeDefaultExpandAll
                allowClear
                showSearch
                treeNodeFilterProp="title"
                placeholder="Aucun"
              />
            </NewItemField>
          </Col>
          <Col xs={24} md={12}>
            <NewItemField label="Confidentialité">
              <Select
                style={{ width: '100%' }}
                value={form.confidentialiteId ?? undefined}
                onChange={(v) =>
                  setForm((f) => ({ ...f, confidentialiteId: (v as number) ?? null }))
                }
                options={confidentialites.map((c) => ({
                  value: c.confidentialiteId,
                  label: c.label,
                }))}
                allowClear
                showSearch
                filterOption={filterByLabel}
                placeholder="Aucune"
              />
            </NewItemField>
          </Col>
        </Row>

        <Button
          type="primary"
          style={{ marginTop: 16 }}
          loading={busy}
          disabled={form.documentTypeId == null}
          onClick={() => void save()}
        >
          Enregistrer
        </Button>
      </FormAbovePanel>

      <Card title="Paramétrages">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Emplacement RÉSERVÉ (même parti pris que BulkRefPage) : la barre de lot poussait la
              table vers le bas à chaque coche. Le conteneur garde la hauteur d'un bouton `small`
              (controlHeightSM = 28) et se contente d'échanger son contenu. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, minHeight: 28 }}>
            {selected.length > 0 ? (
              <Popconfirm
                title={`Supprimer ces ${selected.length} paramétrages ?`}
                description={EFFET_PLUSIEURS}
                okText="Supprimer"
                okButtonProps={{ danger: true }}
                cancelText="Annuler"
                onConfirm={() => void remove(selected)}
              >
                <Button danger size="small" icon={<icons.delete size={14} />}>
                  Supprimer la sélection ({selected.length})
                </Button>
              </Popconfirm>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                Cochez des lignes pour supprimer plusieurs paramétrages.
              </Typography.Text>
            )}
          </div>
          {/*
            Le `<Table>` reste sans `scroll={{ x: 'max-content' }}` : comme l'explique le
            commentaire d'origine, ce mode fige chaque colonne à sa largeur de contenu et rejetait
            « Plan de classement » hors du cadre sur un écran courant. Sans lui, les colonnes se
            partagent 100 % de la largeur et leur texte s'enroule — le comportement voulu.
            Sur un très petit écran, ce texte enroulé + les deux boutons d'action de la dernière
            colonne peuvent quand même dépasser 100 % : ce wrapper capture alors CE débordement
            avec son propre défilement horizontal, au lieu de le laisser gagner toute la page
            (ce qui décalait jusqu'à l'en-tête, hors de tout rapport avec ce tableau).
          */}
          <div style={{ overflowX: 'auto' }}>
            <Table<DocumentTypeSettingRow>
              rowKey="documentTypeSettingId"
              dataSource={rows}
              columns={columns}
              size="middle"
              rowSelection={{
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys as number[]),
              }}
              pagination={{
                pageSize: 10,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50'],
                showTotal: (t) => `${t} paramétrage(s)`,
              }}
            />
          </div>
        </Space>
      </Card>
    </div>
  );
}
