'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PageHeader } from '../../../components/PageHeader';
import { FormAbovePanel } from '../../../components/archives/FormAbovePanel';
import { NewItemField } from '../../../components/RefLayout';
import { icons } from '../../../theme/icons';
import { fontSize, space } from '../../../theme/tokens';
import {
  destructionModesApi,
  finalFatesApi,
  lifeCyclesApi,
  lookups,
  type DestructionModeRow,
  type DocumentTypeLifeCycleRow,
  type DocumentTypeOption,
  type FinalFateRow,
} from '../../../lib/archives';

/**
 * Le serveur stocke et calcule les échéances en MOIS (`domain/dua.ts`, SQL `make_interval`,
 * inchangés) : cet écran est le seul point du système à travailler en ANNÉES, converties à sa
 * frontière. `Math.round` protège l'affichage si jamais une valeur non multiple de 12 arrivait
 * (écriture directe par l'API) ; en écriture, l'écran n'envoie toujours que des multiples de 12.
 */
const monthsToYears = (months: number): number => Math.round(months / 12);
const yearsToMonths = (years: number): number => years * 12;

/** « 0 » → immédiat, sinon accord singulier/pluriel — plus de mélange mois/ans à formatter. */
function humanYears(years: number): string {
  if (years === 0) return 'immédiat';
  return `${years} an${years > 1 ? 's' : ''}`;
}

interface FormState {
  documentTypeId: number | null;
  usefulnessLifespanYears: number;
  complianceLifespanYears: number;
  finalFateId: number | null;
  destructionModeId: number | null;
}

/**
 * Conséquences énoncées dans les confirmations (« verbe + objet + conséquence ») : sans règle, un
 * type de document n'a plus d'échéance calculable — il sort de l'écran « DUA expirés ».
 */
const EFFET_UNE =
  'Les documents de ce type n’auront plus d’échéance de conservation et cesseront de remonter dans « DUA expirés ».';
const EFFET_PLUSIEURS =
  'Les documents de ces types n’auront plus d’échéance de conservation et cesseront de remonter dans « DUA expirés ».';

const EMPTY: FormState = {
  documentTypeId: null,
  usefulnessLifespanYears: 5,
  complianceLifespanYears: 10,
  finalFateId: null,
  destructionModeId: null,
};

/**
 * §3 — Règles de conservation par type de document : durée d'utilité administrative (DUA), durée
 * de conformité, sort final et mode de destruction. Saisies et affichées en ANNÉES ; c'est de ces
 * règles que l'écran « DUA expirés » tire sa liste.
 *
 * Layout aligné sur « Paramétrage des types de documents » : bouton sous le titre (aligné à
 * droite), formulaire ouvert AU-DESSUS du tableau, champs deux par ligne.
 */
export default function LifeCyclesPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<DocumentTypeLifeCycleRow[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeOption[]>([]);
  const [finalFates, setFinalFates] = useState<FinalFateRow[]>([]);
  const [destructionModes, setDestructionModes] = useState<DestructionModeRow[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  /** Ancre de recentrage : le formulaire s'ouvre en haut de page, loin de la ligne cliquée. */
  const [focusSignal, setFocusSignal] = useState(0);

  const load = useCallback(async () => {
    try {
      const [lc, dt, ff, dm] = await Promise.all([
        lifeCyclesApi.list(),
        lookups.documentTypes(),
        finalFatesApi.list(),
        destructionModesApi.list(),
      ]);
      setRows(lc);
      setDocumentTypes(dt);
      setFinalFates(ff);
      setDestructionModes(dm);
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
  const fateOptions = useMemo(
    () => finalFates.map((f) => ({ value: f.finalFateId, label: f.label })),
    [finalFates],
  );
  const modeOptions = useMemo(
    () => destructionModes.map((m) => ({ value: m.destructionModeId, label: m.label })),
    [destructionModes],
  );

  /** Charge la règle existante d'un type (mois → années), ou repart sur les valeurs par défaut. */
  const selectType = (documentTypeId: number | null) => {
    const existing = rows.find((r) => r.documentTypeId === documentTypeId);
    setForm(
      existing
        ? {
            documentTypeId,
            usefulnessLifespanYears: monthsToYears(existing.usefulnessLifespan),
            complianceLifespanYears: monthsToYears(existing.complianceLifespan),
            finalFateId: existing.finalFateId,
            destructionModeId: existing.destructionModeId,
          }
        : { ...EMPTY, documentTypeId },
    );
  };

  /** Ouvre le formulaire chargé de la règle de cette ligne (bouton crayon du tableau). */
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
      await lifeCyclesApi.save({
        documentTypeId: form.documentTypeId,
        usefulnessLifespan: yearsToMonths(form.usefulnessLifespanYears),
        complianceLifespan: yearsToMonths(form.complianceLifespanYears),
        finalFateId: form.finalFateId,
        destructionModeId: form.destructionModeId,
      });
      await load();
      message.success('Cycle de vie enregistré');
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
      await lifeCyclesApi.remove(ids);
      setSelected((s) => s.filter((id) => !ids.includes(id)));
      await load();
      message.success(ids.length > 1 ? `${ids.length} règles supprimées` : 'Règle supprimée');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Suppression impossible');
    }
  };

  const dash = <Typography.Text type="secondary">—</Typography.Text>;

  const columns: TableColumnsType<DocumentTypeLifeCycleRow> = [
    {
      title: 'Type de document',
      key: 'documentType',
      render: (_, r) => <Typography.Text strong>{r.documentType.label}</Typography.Text>,
      sorter: (a, b) => a.documentType.label.localeCompare(b.documentType.label, 'fr'),
    },
    {
      title: 'Conformité',
      key: 'complianceLifespan',
      width: 130,
      sorter: (a, b) => a.complianceLifespan - b.complianceLifespan,
      render: (_, r) => humanYears(monthsToYears(r.complianceLifespan)),
    },
    {
      title: 'DUA',
      key: 'usefulnessLifespan',
      width: 130,
      sorter: (a, b) => a.usefulnessLifespan - b.usefulnessLifespan,
      render: (_, r) => (
        <Tooltip title="Durée d'utilité administrative — au-delà, le document apparaît dans « DUA expirés ».">
          <span>{humanYears(monthsToYears(r.usefulnessLifespan))}</span>
        </Tooltip>
      ),
    },
    { title: 'Sort final', key: 'finalFate', render: (_, r) => r.finalFate?.label ?? dash },
    {
      title: 'Mode de destruction',
      key: 'destructionMode',
      render: (_, r) => r.destructionMode?.label ?? dash,
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
              aria-label="Charger cette règle dans le formulaire"
              icon={<icons.edit size={16} />}
              onClick={() => editRow(r.documentTypeId)}
            />
          </Tooltip>
          <Popconfirm
            title="Supprimer cette règle ?"
            description={EFFET_UNE}
            okText="Supprimer"
            okButtonProps={{ danger: true }}
            cancelText="Annuler"
            onConfirm={() => void remove([r.documentTypeLifeCycleId])}
          >
            <Button
              type="text"
              danger
              size="small"
              aria-label="Supprimer cette règle"
              icon={<icons.delete size={16} />}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader icon="refresh" title="Cycles de vie des documents" />

      <FormAbovePanel
        open={formOpen}
        onToggle={() => {
          if (formOpen) setForm(EMPTY);
          setFormOpen((v) => !v);
        }}
        triggerLabel="Nouvelle règle"
        title="Définir un cycle de vie"
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
                  Ce type a déjà une règle : l&apos;enregistrement la remplacera.
                </Typography.Text>
              )}
          </Col>
          <Col xs={24} md={12}>
            <NewItemField label="Durée de conformité (années)" required>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                value={form.complianceLifespanYears}
                onChange={(v) => setForm((f) => ({ ...f, complianceLifespanYears: v ?? 0 }))}
              />
            </NewItemField>
          </Col>
          <Col xs={24} md={12}>
            <NewItemField label="Durée d'utilité administrative (années)" required>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                value={form.usefulnessLifespanYears}
                onChange={(v) => setForm((f) => ({ ...f, usefulnessLifespanYears: v ?? 0 }))}
              />
            </NewItemField>
          </Col>
          <Col xs={24} md={12}>
            <NewItemField label="Sort final">
              <Select
                style={{ width: '100%' }}
                value={form.finalFateId ?? undefined}
                onChange={(v) => setForm((f) => ({ ...f, finalFateId: (v as number) ?? null }))}
                options={fateOptions}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Sélectionner un sort final"
              />
            </NewItemField>
          </Col>
          <Col xs={24} md={12}>
            <NewItemField label="Mode de destruction">
              <Select
                style={{ width: '100%' }}
                value={form.destructionModeId ?? undefined}
                onChange={(v) =>
                  setForm((f) => ({ ...f, destructionModeId: (v as number) ?? null }))
                }
                options={modeOptions}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="Sélectionner un mode de destruction"
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

      <Card title="Règles de cycle de vie">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Emplacement RÉSERVÉ (même parti pris que BulkRefPage) : la barre de lot poussait la
              table vers le bas à chaque coche. Le conteneur garde la hauteur d'un bouton `small`
              (controlHeightSM = 28) et se contente d'échanger son contenu. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, minHeight: 28 }}>
            {selected.length > 0 ? (
              <Popconfirm
                title={`Supprimer ces ${selected.length} règles ?`}
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
                Cochez des lignes pour supprimer plusieurs règles.
              </Typography.Text>
            )}
          </div>
          <Table<DocumentTypeLifeCycleRow>
            rowKey="documentTypeLifeCycleId"
            dataSource={rows}
            columns={columns}
            size="middle"
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as number[]),
            }}
            pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `${t} règle(s)` }}
          />
        </Space>
      </Card>
    </div>
  );
}
