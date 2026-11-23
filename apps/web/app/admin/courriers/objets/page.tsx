'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Breadcrumb, Button, Input, InputNumber, Popconfirm, Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { NewItemField, NewItemForm, RefLayout } from '../../../components/RefLayout';
import { EditableText } from '../../../components/editable';
import { TableSkeleton } from '../../../components/skeletons';
import { icons } from '../../../theme/icons';
import { colors, fontSize, radii } from '../../../theme/tokens';
import { mailObjetsApi, type MailObjetRow } from '../../../lib/courriers';

/**
 * Cellule de durée (jours) : enregistre au blur si la valeur a changé.
 *
 * L'écran mêle deux gestes d'édition en place — clic-pour-éditer sur le libellé, champ
 * toujours ouvert ici. À défaut de les fondre en un seul (le crayon partagé n'expose pas
 * de variante numérique), la sauvegarde silencieuse au blur reçoit le MÊME flash de
 * confirmation que le libellé : le geste reste distinct, le retour visuel est commun.
 */
function DurationCell({
  value,
  label,
  onSave,
}: {
  value: number;
  label: string;
  onSave: (v: number) => Promise<void>;
}) {
  const [v, setV] = useState(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => setV(value), [value]);

  const commit = async () => {
    if (v === value) return;
    await onSave(v);
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
  };

  return (
    <span
      style={
        flash
          ? {
              display: 'inline-block',
              borderRadius: radii.xs,
              transition: 'background 1.2s',
              background: `var(--ant-color-primary-bg, ${colors.primarySoft})`,
            }
          : undefined
      }
    >
      <InputNumber
        size="small"
        min={0}
        value={v}
        aria-label={label}
        style={{ width: 90 }}
        onChange={(n) => setV(Number(n ?? 0))}
        onBlur={() => void commit()}
        onPressEnter={() => void commit()}
      />
    </span>
  );
}

export default function MailObjetsPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<MailObjetRow[]>([]);
  const [label, setLabel] = useState('');
  const [ext, setExt] = useState<number>(0);
  const [int, setInt] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  // Échec du chargement : le référentiel ne doit pas s'annoncer vide (cf. RefLayout).
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await mailObjetsApi.list());
      setLoadFailed(false);
    } catch (e) {
      setLoadFailed(true);
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
      const created = await mailObjetsApi.create({
        label: label.trim(),
        dureeSuiviExterne: ext,
        dureeSuiviInterne: int,
      });
      setLabel('');
      setExt(0);
      setInt(0);
      await load();
      const createdId = created?.mailObjetId;
      if (typeof createdId === 'number') {
        setHighlightId(createdId);
        setTimeout(() => setHighlightId(null), 1400);
      }
      message.success('Objet créé');
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: number, body: Record<string, unknown>) => {
    try {
      await mailObjetsApi.update(id, body);
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (id: number) => {
    try {
      await mailObjetsApi.remove(id);
      await load();
      message.success('Objet désactivé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Désactivation impossible');
    }
  };

  const columns: TableColumnsType<MailObjetRow> = [
    {
      title: 'Libellé',
      dataIndex: 'label',
      key: 'label',
      render: (_, r) => (
        <EditableText value={r.label} required onSave={(v) => patch(r.mailObjetId, { label: v })} />
      ),
    },
    {
      title: 'Suivi externe (j)',
      dataIndex: 'dureeSuiviExterne',
      key: 'dureeSuiviExterne',
      width: 150,
      render: (_, r) => (
        <DurationCell
          value={r.dureeSuiviExterne}
          label={`Durée de suivi externe en jours pour « ${r.label} »`}
          onSave={(v) => patch(r.mailObjetId, { dureeSuiviExterne: v })}
        />
      ),
    },
    {
      title: 'Suivi interne (j)',
      dataIndex: 'dureeSuiviInterne',
      key: 'dureeSuiviInterne',
      width: 150,
      render: (_, r) => (
        <DurationCell
          value={r.dureeSuiviInterne}
          label={`Durée de suivi interne en jours pour « ${r.label} »`}
          onSave={(v) => patch(r.mailObjetId, { dureeSuiviInterne: v })}
        />
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
      render: (_, r) => (
        <Popconfirm
          title="Désactiver cet objet ?"
          description="Il ne sera plus proposé à l'enregistrement ; les courriers existants le conservent, avec leur date de suivi déjà calculée."
          okText="Désactiver"
          cancelText="Annuler"
          okButtonProps={{ danger: true }}
          onConfirm={() => void remove(r.mailObjetId)}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label={`Désactiver l'objet ${r.label}`}
            style={{ height: 40, minWidth: 40 }}
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <>
      {/* Écran hors menu : la barre latérale n'a aucun item sélectionné et la TopBar retombe
          sur la section par défaut. Le fil d'Ariane est donc le seul repère de localisation
          pour qui arrive par URL directe. Il est posé ici — au gabarit de celui de PageHeader —
          parce que RefLayout n'expose pas la prop `breadcrumb`. */}
      <Breadcrumb
        style={{ marginBottom: 10, fontSize: fontSize.sm }}
        items={[{ title: 'Paramétrage Courrier' }, { title: 'Objets de courrier' }]}
      />
      <RefLayout
        loadFailed={loadFailed && rows.length === 0}
        onRetry={load}
        icon="document"
        title="Objets de courrier"
        tableTitle="Objets de courrier"
        formTitle="Nouvel objet"
        table={
          // Sans état de chargement, la table affichait « Aucune donnée » le temps du premier appel.
          firstLoad && loading ? (
            <TableSkeleton rows={6} columns={4} />
          ) : (
            <Table<MailObjetRow>
              rowKey="mailObjetId"
              dataSource={rows}
              columns={columns}
              loading={loading}
              size="middle"
              scroll={{ x: 'max-content' }}
              rowClassName={(r) => (r.mailObjetId === highlightId ? 'da-row-flash' : '')}
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
                placeholder="Ex. Demande de subvention"
              />
            </NewItemField>
            <NewItemField label="Durée de suivi externe (jours)">
              <InputNumber
                min={0}
                value={ext}
                onChange={(v) => setExt(Number(v ?? 0))}
                style={{ width: '100%' }}
              />
            </NewItemField>
            <NewItemField label="Durée de suivi interne (jours)">
              <InputNumber
                min={0}
                value={int}
                onChange={(v) => setInt(Number(v ?? 0))}
                style={{ width: '100%' }}
              />
            </NewItemField>
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
    </>
  );
}
