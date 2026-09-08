'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { App, Alert, Button, Input, Popconfirm, Select, Space, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { NewItemField, NewItemForm, RefLayout } from '../../../components/RefLayout';
import { EditableSelect, EditableText } from '../../../components/editable';
import { icons } from '../../../theme/icons';
import { fontSize, space } from '../../../theme/tokens';
import {
  bulkMessage,
  metaDataListItemsApi,
  metaDatasApi,
  MetaDataType,
  type MetaDataListItemRow,
  type MetaDataRow,
} from '../../../lib/archives';

/**
 * §9 — Valeurs possibles des métadonnées de type « Liste ».
 *
 * Le sélecteur de métadonnée ne propose QUE les métadonnées de type Liste : rattacher une valeur
 * à un champ Texte ou Date n'aurait pas de sens et la valeur ne serait jamais affichée. Un
 * paramètre `?metaDataId=` pré-sélectionne la liste (lien depuis l'écran « Métadonnées »).
 */

/**
 * Conséquences énoncées dans les confirmations (« verbe + objet + conséquence ») : la
 * désactivation retire l'option des listes déroulantes, jamais les valeurs déjà retenues.
 */
const EFFET_UNE =
  'Elle ne sera plus proposée à l’indexation. Les documents qui l’ont déjà retenue restent lisibles.';
const EFFET_PLUSIEURS =
  'Elles ne seront plus proposées à l’indexation. Les documents qui les ont déjà retenues restent lisibles.';

function MetaDataListItemsScreen() {
  const { message } = App.useApp();
  const params = useSearchParams();
  const initialMetaDataId = Number(params.get('metaDataId')) || null;

  const [items, setItems] = useState<MetaDataListItemRow[]>([]);
  const [metaDatas, setMetaDatas] = useState<MetaDataRow[]>([]);
  const [filterId, setFilterId] = useState<number | null>(initialMetaDataId);
  const [formMetaDataId, setFormMetaDataId] = useState<number | null>(initialMetaDataId);
  const [labels, setLabels] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);

  const load = useCallback(async () => {
    try {
      const [i, m] = await Promise.all([metaDataListItemsApi.list(), metaDatasApi.list()]);
      setItems(i);
      setMetaDatas(m);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Seules les métadonnées de type Liste peuvent porter des valeurs. */
  const listMetaDatas = useMemo(
    () => metaDatas.filter((m) => m.dataType === MetaDataType.Liste),
    [metaDatas],
  );
  const options = useMemo(
    () => listMetaDatas.map((m) => ({ value: m.metaDataId, label: m.label })),
    [listMetaDatas],
  );
  const labelById = useMemo(
    () => new Map(metaDatas.map((m) => [m.metaDataId, m.label])),
    [metaDatas],
  );
  const rows = useMemo(
    () => (filterId ? items.filter((i) => i.metaDataId === filterId) : items),
    [items, filterId],
  );

  const create = async (close: () => void) => {
    const value = labels.trim();
    if (!value || formMetaDataId == null) return;
    setBusy(true);
    try {
      const result = await metaDataListItemsApi.create(formMetaDataId, [value]);
      setLabels('');
      await load();
      message.success(bulkMessage(result, 'valeur créée', 'valeurs créées'));
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: number, body: { label?: string; metaDataId?: number }) => {
    try {
      await metaDataListItemsApi.update(id, body);
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (ids: number[]) => {
    try {
      await metaDataListItemsApi.remove(ids);
      setSelected((s) => s.filter((id) => !ids.includes(id)));
      await load();
      message.success(ids.length > 1 ? `${ids.length} valeurs désactivées` : 'Valeur désactivée');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Désactivation impossible');
    }
  };

  const columns: TableColumnsType<MetaDataListItemRow> = [
    {
      title: 'Valeur',
      key: 'label',
      render: (_, r) => (
        <EditableText
          value={r.label}
          required
          onSave={(v) => patch(r.metaDataListItemId, { label: v })}
        />
      ),
    },
    {
      title: 'Métadonnée',
      key: 'metaData',
      width: 240,
      render: (_, r) => (
        <EditableSelect
          currentId={r.metaDataId}
          currentLabel={labelById.get(r.metaDataId) ?? r.metaData.label}
          options={options}
          onSave={async (v) => {
            if (v != null) await patch(r.metaDataListItemId, { metaDataId: v });
          }}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 56,
      align: 'center',
      render: (_, r) => (
        <Popconfirm
          title="Désactiver cette valeur ?"
          description={EFFET_UNE}
          okText="Désactiver"
          okButtonProps={{ danger: true }}
          cancelText="Annuler"
          onConfirm={() => void remove([r.metaDataListItemId])}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label="Désactiver cette valeur"
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <RefLayout
      icon="menu"
      title="Éléments des listes"
      tableTitle="Valeurs de liste"
      formTitle="Nouvelle valeur"
      table={
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {listMetaDatas.length === 0 && (
            <Alert
              type="info"
              showIcon
              message="Aucune métadonnée de type « Liste de valeurs »"
              description="Créez d'abord une métadonnée de ce type dans « Gestion des métadonnées » : une valeur de liste doit appartenir à une liste."
            />
          )}
          {/* Toolbar alignée sur la ligne de base des champs, avec un emplacement RÉSERVÉ à droite :
              la barre de lot n'apparaissait qu'une fois une ligne cochée et repoussait la table. */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: space.lg, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 240 }}>
              <NewItemField label="Filtrer par métadonnée">
                <Select
                  style={{ width: '100%' }}
                  value={filterId ?? undefined}
                  onChange={(v) => setFilterId((v as number) ?? null)}
                  options={options}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="Toutes"
                />
              </NewItemField>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, minHeight: 36 }}>
              {selected.length > 0 ? (
                <Popconfirm
                  title={`Désactiver ces ${selected.length} valeurs ?`}
                  description={EFFET_PLUSIEURS}
                  okText="Désactiver"
                  okButtonProps={{ danger: true }}
                  cancelText="Annuler"
                  onConfirm={() => void remove(selected)}
                >
                  <Button danger size="small" icon={<icons.delete size={14} />}>
                    Désactiver la sélection ({selected.length})
                  </Button>
                </Popconfirm>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                  Cochez des lignes pour les désactiver en lot.
                </Typography.Text>
              )}
            </div>
          </div>
          <Table<MetaDataListItemRow>
            rowKey="metaDataListItemId"
            dataSource={rows}
            columns={columns}
            size="middle"
            scroll={{ x: 'max-content' }}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as number[]),
            }}
            pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `${t} valeur(s)` }}
          />
        </Space>
      }
      renderForm={(close) => (
        <NewItemForm>
          <NewItemField label="Métadonnée (type Liste)" required>
            <Select
              style={{ width: '100%' }}
              value={formMetaDataId ?? undefined}
              onChange={(v) => setFormMetaDataId((v as number) ?? null)}
              options={options}
              showSearch
              optionFilterProp="label"
              placeholder="Sélectionner une métadonnée"
            />
          </NewItemField>
          <NewItemField label="Valeur" required>
            <Input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              onPressEnter={() => labels.trim() && formMetaDataId != null && void create(close)}
              placeholder="Ex. En cours"
            />
          </NewItemField>
          <Button
            type="primary"
            block
            loading={busy}
            disabled={!labels.trim() || formMetaDataId == null}
            onClick={() => void create(close)}
          >
            Ajouter
          </Button>
        </NewItemForm>
      )}
    />
  );
}

export default function MetaDataListItemsPage() {
  return (
    <Suspense fallback={null}>
      <MetaDataListItemsScreen />
    </Suspense>
  );
}
