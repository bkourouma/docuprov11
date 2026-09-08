'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { App, Button, Input, Popconfirm, Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { NewItemForm, RefLayout } from '../RefLayout';
import { EditableText } from '../editable';
import { EmptyState } from '../EmptyState';
import { TableSkeleton } from '../skeletons';
import { icons, type IconName } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';

export interface RefApi<T> {
  list: () => Promise<T[]>;
  create: (body: Record<string, unknown>) => Promise<T>;
  update: (id: number, body: Record<string, unknown>) => Promise<T>;
  remove: (id: number) => Promise<unknown>;
}

/**
 * Le crayon d'édition est rendu par `editable.tsx` (composant partagé, hors de ce lot) et
 * hérite de `currentColor` : le passer au primaire sans toucher au composant impose une règle
 * descendante portée par le tableau.
 */
const REF_TABLE_CLASS = '[&_.da-editable-pen]:text-[color:var(--ant-color-primary)]';

/**
 * Page de référentiel courrier « libellé seul » (natures, types de départ, types d'entité externe,
 * confidentialités). Reprend le patron V6 : RefLayout + édition inline + désactivation
 * (is_active=false ; aucune suppression physique). `canEdit=false` pour les référentiels sans PATCH.
 *
 * Table de CONSULTATION (`size="middle"`, volumes faibles) ; formulaire de création en
 * la densité standard (champs 36 px), avec un vrai libellé associé au champ.
 */
export function MailRefPage<T extends { label: string }>({
  icon,
  title,
  formTitle,
  placeholder,
  confirmLabel,
  api,
  idOf,
  canEdit = true,
}: {
  icon: IconName;
  title: string;
  formTitle: string;
  placeholder: string;
  /** Ex. « cette nature » — utilisé dans la confirmation de désactivation. */
  confirmLabel: string;
  api: RefApi<T>;
  idOf: (row: T) => number;
  canEdit?: boolean;
}) {
  const { message } = App.useApp();
  const fieldId = useId();
  const [rows, setRows] = useState<T[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.list());
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
      setFirstLoad(false);
    }
  }, [api, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (close: () => void) => {
    setBusy(true);
    try {
      const created = await api.create({ label: label.trim() });
      setLabel('');
      await load();
      // Repère visuel après création (motif /admin/users) : la ligne neuve clignote le temps
      // de l'animation `da-row-flash`, sinon elle se perd dans une liste triée par le serveur.
      const createdId = created ? idOf(created) : null;
      if (typeof createdId === 'number' && Number.isFinite(createdId)) {
        setHighlightId(createdId);
        setTimeout(() => setHighlightId(null), 1400);
      }
      message.success('Élément créé');
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const save = async (id: number, next: string) => {
    try {
      await api.update(id, { label: next });
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (id: number) => {
    try {
      await api.remove(id);
      await load();
      message.success('Élément désactivé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Désactivation impossible');
    }
  };

  const columns: TableColumnsType<T> = [
    {
      title: 'Libellé',
      dataIndex: 'label',
      key: 'label',
      render: (_, r) =>
        canEdit ? (
          <EditableText value={r.label} required onSave={(v) => save(idOf(r), v)} />
        ) : (
          r.label
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
          title={`Désactiver ${confirmLabel} ?`}
          description="L'élément ne sera plus proposé ; les courriers existants le conservent."
          okText="Désactiver"
          cancelText="Annuler"
          okButtonProps={{ danger: true }}
          onConfirm={() => void remove(idOf(r))}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label={`Désactiver ${confirmLabel}`}
            // Cible portée par la boîte du bouton, pas par la taille de l'icône.
            style={{ height: 40, minWidth: 40 }}
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <RefLayout
      icon={icon}
      title={title}
      tableTitle={title}
      formTitle={formTitle}
      table={
        // Sans état de chargement, la table affichait « Aucune donnée » le temps du premier
        // appel : squelette au premier chargement, voile de la table aux suivants.
        firstLoad && loading ? (
          <TableSkeleton rows={6} columns={2} />
        ) : rows.length === 0 ? (
          <EmptyState icon={icon} title="Aucun élément" />
        ) : (
          <Table<T>
            rowKey={(r) => idOf(r)}
            className={REF_TABLE_CLASS}
            dataSource={rows}
            columns={columns}
            loading={loading}
            size="middle"
            scroll={{ x: 'max-content' }}
            rowClassName={(r) => (idOf(r) === highlightId ? 'da-row-flash' : '')}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              pageSizeOptions: ['10', '20', '50', '100'],
              showTotal: (total) => `${total} élément(s)`,
            }}
          />
        )
      }
      renderForm={(close) => (
        <NewItemForm>
          <div>
            <label
              htmlFor={fieldId}
              style={{
                display: 'block',
                marginBottom: space.sm,
                fontSize: fontSize.base,
                fontWeight: 600,
                color: 'var(--ant-color-text)',
              }}
            >
              Libellé{' '}
              <span aria-hidden style={{ color: 'var(--ant-color-error)' }}>
                *
              </span>
            </label>
            <Input
              id={fieldId}
              aria-required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={() => label.trim() && void create(close)}
              placeholder={placeholder}
            />
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
