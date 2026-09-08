'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { App, Button, Input, Popconfirm, Switch, Table, Tag, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import { MailInputationTypeId } from '@archivage/types';
import { NewItemField, NewItemForm, RefLayout } from '../../../components/RefLayout';
import { EditableText } from '../../../components/editable';
import { TableSkeleton } from '../../../components/skeletons';
import { icons } from '../../../theme/icons';
import { colors, fontSize, space } from '../../../theme/tokens';
import { inputationTypesApi, type MailInputationTypeRow } from '../../../lib/courriers';

/** Types « système » référencés en dur par le domaine : ne pas désactiver. */
const SYSTEM_IDS: number[] = Object.values(MailInputationTypeId);

export default function MailInputationTypesPage() {
  const { message } = App.useApp();
  const suiviFieldId = useId();
  const [rows, setRows] = useState<MailInputationTypeRow[]>([]);
  const [label, setLabel] = useState('');
  const [suivi, setSuivi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  /** Ligne dont le PATCH « Suivi » est en vol : le Switch bascule sans retour visuel sinon. */
  const [savingId, setSavingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await inputationTypesApi.list());
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
      setFirstLoad(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (close: () => void) => {
    setBusy(true);
    try {
      const created = await inputationTypesApi.create({ label: label.trim(), suivi });
      setLabel('');
      setSuivi(false);
      await load();
      const createdId = created?.mailInputationTypeId;
      if (typeof createdId === 'number') {
        setHighlightId(createdId);
        setTimeout(() => setHighlightId(null), 1400);
      }
      message.success("Type d'imputation créé");
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: number, body: Record<string, unknown>) => {
    try {
      await inputationTypesApi.update(id, body);
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const toggleSuivi = async (id: number, next: boolean) => {
    setSavingId(id);
    try {
      await patch(id, { suivi: next });
    } finally {
      setSavingId(null);
    }
  };

  const remove = async (id: number) => {
    try {
      await inputationTypesApi.remove(id);
      await load();
      message.success('Type désactivé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Désactivation impossible');
    }
  };

  const columns: TableColumnsType<MailInputationTypeRow> = [
    {
      title: 'Libellé',
      dataIndex: 'label',
      key: 'label',
      render: (_, r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <EditableText
            value={r.label}
            required
            onSave={(v) => patch(r.mailInputationTypeId, { label: v })}
          />
          {SYSTEM_IDS.includes(r.mailInputationTypeId) && (
            <Tooltip title="Type référencé par le workflow (validation DG/Direction, pour suivi, en copie). À ne pas désactiver.">
              {/* Marqueur neutre : le gold vif du preset AntD posait un texte sous AA. Fond
                  gris fort (blanc dessus : 4,74:1), identique dans les deux thèmes. */}
              <Tag color={colors.secondaryStrong} style={{ margin: 0, fontWeight: 600 }}>
                système
              </Tag>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      title: 'Suivi',
      dataIndex: 'suivi',
      key: 'suivi',
      width: 150,
      render: (_, r) => (
        <Tooltip title="Si actif, l'imputation est traitée automatiquement à la lecture du courrier.">
          <Switch
            size="small"
            checked={r.suivi}
            loading={savingId === r.mailInputationTypeId}
            aria-label={`Traitement automatique à la lecture pour « ${r.label} »`}
            onChange={(v) => void toggleSuivi(r.mailInputationTypeId, v)}
          />
        </Tooltip>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 56,
      align: 'center',
      // La cible tactile de 40 px porterait la ligne à 70 px avec le padding de la densité
      // consultation : la cellule d'action rend son padding vertical au bouton.
      onCell: () => ({ style: { paddingBlock: 0, verticalAlign: 'middle' } }),
      render: (_, r) =>
        SYSTEM_IDS.includes(r.mailInputationTypeId) ? null : (
          <Popconfirm
            title="Désactiver ce type d'imputation ?"
            description="Il ne sera plus proposé à l'imputation ; les courriers déjà imputés le conservent."
            okText="Désactiver"
            cancelText="Annuler"
            okButtonProps={{ danger: true }}
            onConfirm={() => void remove(r.mailInputationTypeId)}
          >
            <Button
              type="text"
              danger
              size="small"
              aria-label={`Désactiver le type ${r.label}`}
              style={{ height: 40, minWidth: 40 }}
              icon={<icons.delete size={16} />}
            />
          </Popconfirm>
        ),
    },
  ];

  return (
    <RefLayout
      icon="documentType"
      title="Types d'imputation"
      tableTitle="Types d'imputation"
      formTitle="Nouveau type d'imputation"
      table={
        // Sans état de chargement, la table affichait « Aucune donnée » le temps du premier appel.
        firstLoad && loading ? (
          <TableSkeleton rows={6} columns={3} />
        ) : (
          <Table<MailInputationTypeRow>
            rowKey="mailInputationTypeId"
            dataSource={rows}
            columns={columns}
            loading={loading}
            size="middle"
            scroll={{ x: 'max-content' }}
            rowClassName={(r) => (r.mailInputationTypeId === highlightId ? 'da-row-flash' : '')}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              showTotal: (t) => `${t} élément(s)`,
            }}
          />
        )
      }
      renderForm={(close) => (
        <NewItemForm>
          <NewItemField label="Libellé" required>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={() => label.trim() && void create(close)}
              placeholder="Ex. Pour attribution"
            />
          </NewItemField>
          <div style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
            {/* Le libellé était un simple texte à côté de l'interrupteur : ni annoncé au
                lecteur d'écran, ni cliquable. Le Switch rend un <button>, étiquetable. */}
            <Switch id={suiviFieldId} size="small" checked={suivi} onChange={setSuivi} />
            <label
              htmlFor={suiviFieldId}
              style={{ fontSize: fontSize.base, color: 'var(--ant-color-text)', cursor: 'pointer' }}
            >
              Traitement automatique à la lecture
            </label>
          </div>
          <Button
            type="primary"
            block
            loading={busy}
            disabled={!label.trim()}
            onClick={() => void create(close)}
          >
            Ajouter
          </Button>
        </NewItemForm>
      )}
    />
  );
}
