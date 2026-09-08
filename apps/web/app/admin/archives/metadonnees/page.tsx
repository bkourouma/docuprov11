'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { App, Button, Input, Popconfirm, Select, Space, Table, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { NewItemField, NewItemForm, RefLayout } from '../../../components/RefLayout';
import { EditableSelect, EditableText } from '../../../components/editable';
import { icons } from '../../../theme/icons';
import { fontSize, space } from '../../../theme/tokens';
import {
  bulkMessage,
  metaDatasApi,
  MetaDataType,
  METADATA_TYPE_LABELS,
  METADATA_TYPE_OPTIONS,
  type MetaDataRow,
} from '../../../lib/archives';

const typeLabel = (dataType: number) =>
  METADATA_TYPE_LABELS[dataType as MetaDataType] ?? METADATA_TYPE_LABELS[MetaDataType.Aucun];

/**
 * Conséquences énoncées dans les confirmations (« verbe + objet + conséquence ») : la
 * désactivation retire le champ des formulaires à venir, jamais les valeurs déjà saisies.
 */
const EFFET_UNE =
  'Elle disparaîtra des formulaires d’indexation. Les valeurs déjà saisies sur les documents restent en base.';
const EFFET_PLUSIEURS =
  'Elles disparaîtront des formulaires d’indexation. Les valeurs déjà saisies sur les documents restent en base.';

/**
 * §8 — Champs de métadonnées réutilisables. Chaque métadonnée porte un libellé et un TYPE DE
 * SAISIE, qui détermine le contrôle affiché dans le formulaire dynamique d'indexation. Le type
 * « Liste de valeurs » renvoie vers l'écran « Éléments des listes », où l'on saisit ses options —
 * une liste sans valeur ne proposerait rien, l'écran le signale plutôt que de le laisser deviner.
 */
export default function MetaDatasPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<MetaDataRow[]>([]);
  const [labels, setLabels] = useState('');
  const [dataType, setDataType] = useState<number>(MetaDataType.Texte);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);

  const load = useCallback(async () => {
    try {
      setRows(await metaDatasApi.list());
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (close: () => void) => {
    const label = labels.trim();
    if (!label) return;
    setBusy(true);
    try {
      const result = await metaDatasApi.create([{ label, dataType }]);
      setLabels('');
      await load();
      message.success(bulkMessage(result, 'métadonnée créée', 'métadonnées créées'));
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: number, body: { label?: string; dataType?: number }) => {
    try {
      await metaDatasApi.update(id, body);
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (ids: number[]) => {
    try {
      await metaDatasApi.remove(ids);
      setSelected((s) => s.filter((id) => !ids.includes(id)));
      await load();
      message.success(
        ids.length > 1 ? `${ids.length} métadonnées désactivées` : 'Métadonnée désactivée',
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Désactivation impossible');
    }
  };

  const columns: TableColumnsType<MetaDataRow> = [
    {
      title: 'Libellé',
      key: 'label',
      render: (_, r) => (
        <EditableText value={r.label} required onSave={(v) => patch(r.metaDataId, { label: v })} />
      ),
    },
    {
      title: 'Type de saisie',
      key: 'dataType',
      width: 200,
      render: (_, r) => (
        <EditableSelect
          currentId={r.dataType}
          currentLabel={typeLabel(r.dataType)}
          options={METADATA_TYPE_OPTIONS}
          onSave={async (v) => {
            if (v != null) await patch(r.metaDataId, { dataType: v });
          }}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 92,
      align: 'center',
      render: (_, r) => (
        <Space size={0}>
          {/* Une métadonnée « Liste » ne vaut rien sans ses valeurs : l'écran cible
              accepte déjà ?metaDataId=, mais rien ne l'annonçait — il fallait connaître
              l'autre écran de tête. */}
          {r.dataType === MetaDataType.Liste && (
            <Tooltip title="Gérer les valeurs de cette liste">
              <Link href={`/admin/archives/elements-listes?metaDataId=${r.metaDataId}`}>
                <Button
                  type="text"
                  size="small"
                  aria-label="Gérer les valeurs de cette liste"
                  icon={<icons.folderTree size={16} />}
                />
              </Link>
            </Tooltip>
          )}
          <Popconfirm
            title="Désactiver cette métadonnée ?"
            description={EFFET_UNE}
            okText="Désactiver"
            okButtonProps={{ danger: true }}
            cancelText="Annuler"
            onConfirm={() => void remove([r.metaDataId])}
          >
            <Button
              type="text"
              danger
              size="small"
              aria-label="Désactiver cette métadonnée"
              icon={<icons.delete size={16} />}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <RefLayout
      icon="document"
      title="Gestion des métadonnées"
      tableTitle="Métadonnées"
      formTitle="Nouvelle métadonnée"
      table={
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* Emplacement RÉSERVÉ (même parti pris que BulkRefPage) : la barre de lot poussait la
              table vers le bas à chaque coche. Le conteneur garde la hauteur d'un bouton `small`
              (controlHeightSM = 28) et se contente d'échanger son contenu. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, minHeight: 28 }}>
            {selected.length > 0 ? (
              <>
                <Typography.Text type="secondary">
                  {selected.length} sélectionnée(s)
                </Typography.Text>
                <Popconfirm
                  title={`Désactiver ces ${selected.length} métadonnées ?`}
                  description={EFFET_PLUSIEURS}
                  okText="Désactiver"
                  okButtonProps={{ danger: true }}
                  cancelText="Annuler"
                  onConfirm={() => void remove(selected)}
                >
                  <Button danger size="small" icon={<icons.delete size={14} />}>
                    Désactiver la sélection
                  </Button>
                </Popconfirm>
              </>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                Cochez des lignes pour les désactiver en lot.
              </Typography.Text>
            )}
          </div>
          <Table<MetaDataRow>
            rowKey="metaDataId"
            dataSource={rows}
            columns={columns}
            size="middle"
            scroll={{ x: 'max-content' }}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as number[]),
            }}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              showTotal: (t) => `${t} élément(s)`,
            }}
          />
        </Space>
      }
      renderForm={(close) => (
        <NewItemForm>
          <NewItemField label="Libellé" required>
            <Input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              onPressEnter={() => labels.trim() && void create(close)}
              placeholder="Ex. Montant"
            />
          </NewItemField>
          <NewItemField label="Type de saisie" required>
            <Select
              style={{ width: '100%' }}
              value={dataType}
              onChange={setDataType}
              options={METADATA_TYPE_OPTIONS}
            />
          </NewItemField>
          <Button
            type="primary"
            block
            loading={busy}
            disabled={!labels.trim()}
            onClick={() => void create(close)}
          >
            Ajouter
          </Button>
        </NewItemForm>
      )}
    />
  );
}
