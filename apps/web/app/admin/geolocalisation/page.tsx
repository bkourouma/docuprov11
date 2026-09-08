'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Input, Popconfirm, Table, TreeSelect } from 'antd';
import type { TableColumnsType } from 'antd';
import { apiJson } from '../../lib/api';
import { RefLayout, NewItemField, NewItemForm } from '../../components/RefLayout';
import { EditableText } from '../../components/editable';
import { icons } from '../../theme/icons';

/**
 * Conséquence énoncée dans la confirmation (« verbe + objet + conséquence ») : la suppression est
 * une DÉSACTIVATION en cascade côté serveur (la branche entière passe à `isActive = false`), jamais
 * un effacement des documents qui y sont localisés.
 */
const EFFET_SUPPRESSION =
  'Les sous-éléments partent avec lui. Les documents déjà localisés restent lisibles, mais l’emplacement ne sera plus proposé.';

interface Loc {
  locationId: number;
  parentId: number | null;
  label: string;
  code: string | null;
  depth: number;
  path: string;
}
interface LocNode extends Loc {
  children?: LocNode[];
}
interface TreeOpt {
  value: number;
  title: string;
  children?: TreeOpt[];
}

function buildTree(rows: Loc[]): LocNode[] {
  const byId = new Map<number, LocNode>();
  rows.forEach((r) => byId.set(r.locationId, { ...r }));
  const roots: LocNode[] = [];
  byId.forEach((node) => {
    const parent = node.parentId != null ? byId.get(node.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  });
  return roots;
}

function toTreeSelect(nodes: LocNode[]): TreeOpt[] {
  return nodes.map((n) => ({
    value: n.locationId,
    title: n.code ? `${n.label} (${n.code})` : n.label,
    children: n.children ? toTreeSelect(n.children) : undefined,
  }));
}

export default function GeolocalisationPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Loc[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<number[]>([]);
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [parentId, setParentId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<Loc[]>('/referentials/locations');
      setRows(data);
      setExpandedKeys(data.map((r) => r.locationId)); // org-chart view: fully expanded
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const tree = useMemo(() => buildTree(rows), [rows]);
  const parentOptions = useMemo(() => toTreeSelect(tree), [tree]);

  const flash = (id: number) => {
    setHighlightId(id);
    setTimeout(() => setHighlightId(null), 1400);
  };

  const create = async (close: () => void) => {
    setBusy(true);
    try {
      const created = await apiJson<Loc>('/referentials/locations', {
        method: 'POST',
        body: JSON.stringify({
          label: label.trim(),
          code: code.trim(),
          parentId: parentId ?? undefined,
        }),
      });
      setLabel('');
      setCode('');
      setParentId(null);
      await load();
      if (created?.locationId) flash(created.locationId);
      message.success('Élément créé');
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const save = async (id: number, patch: { label?: string; code?: string }) => {
    try {
      await apiJson(`/referentials/locations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (id: number) => {
    try {
      await apiJson(`/referentials/locations/${id}`, { method: 'DELETE' });
      await load();
      message.success('Élément supprimé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Suppression impossible');
    }
  };

  const columns: TableColumnsType<LocNode> = [
    {
      title: "Nom de l'élément",
      dataIndex: 'label',
      key: 'label',
      render: (_, r) => (
        // Texte primaire sur la ligne retenue comme parent : le fond seul (10 % de primaire) ne se
        // distingue pas d'un survol une fois le pointeur ailleurs.
        <span style={r.locationId === parentId ? { color: 'var(--ant-color-primary)' } : undefined}>
          <EditableText value={r.label} required onSave={(v) => save(r.locationId, { label: v })} />
        </span>
      ),
    },
    {
      title: 'Code',
      dataIndex: 'code',
      key: 'code',
      width: 200,
      render: (_, r) => (
        <EditableText
          value={r.code}
          required
          mono
          onSave={(v) => save(r.locationId, { code: v })}
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
          title="Supprimer cet élément et ses sous-éléments ?"
          description={EFFET_SUPPRESSION}
          okText="Supprimer"
          okButtonProps={{ danger: true }}
          cancelText="Annuler"
          onConfirm={() => void remove(r.locationId)}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label="Supprimer cet élément"
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <RefLayout
      icon="geolocalisation"
      title="Gestion de la géolocalisation"
      // Écran hors menu : rien d'autre ne signale à l'utilisateur arrivé par lien direct où il se
      // trouve (le fil d'Ariane demandé par l'audit suppose une prop de RefLayout qui n'existe pas).
      exportPath="/referentials/locations/export"
      exportFilename="geolocalisation"
      tableTitle="Éléments de géolocalisation"
      formTitle="Nouvel élément"
      tableSpan={16}
      table={
        <Table<LocNode>
          rowKey="locationId"
          dataSource={tree}
          columns={columns}
          size="middle"
          scroll={{ x: 'max-content' }}
          // `ant-table-row-selected` : la teinte de sélection d'AntD vaut déjà le primaire à ~10 %
          // exigé par la grille — la poser ici évite d'inventer une seconde couleur de surlignage.
          rowClassName={(r) =>
            [
              r.locationId === highlightId ? 'da-row-flash' : '',
              r.locationId === parentId ? 'ant-table-row-selected' : '',
            ]
              .filter(Boolean)
              .join(' ')
          }
          pagination={{
            pageSize: 10,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            // La pagination porte sur les RACINES : l'arbre étant déplié, « 10 » peut couvrir
            // beaucoup plus de lignes à l'écran — le compteur le dit plutôt que de le masquer.
            showTotal: (total) => `${total} racine(s)`,
          }}
          expandable={{
            expandedRowKeys: expandedKeys,
            onExpandedRowsChange: (keys) => setExpandedKeys(keys as number[]),
          }}
        />
      }
      renderForm={(close) => (
        // Ordre Nom → Code → Parent, identique aux deux autres arbres (plan de classement,
        // dossiers) : l'identité de l'élément d'abord, son emplacement ensuite.
        <NewItemForm>
          <NewItemField label="Nom de l'élément" required>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={() => label.trim() && code.trim() && void create(close)}
              placeholder="Ex. Direction des Archives"
            />
          </NewItemField>
          <NewItemField label="Code" required>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onPressEnter={() => label.trim() && code.trim() && void create(close)}
              placeholder="Ex. DA"
            />
          </NewItemField>
          <NewItemField label="Élément parent">
            <TreeSelect
              style={{ width: '100%' }}
              value={parentId ?? undefined}
              onChange={(v) => setParentId((v as number) ?? null)}
              treeData={parentOptions}
              treeDefaultExpandAll
              allowClear
              showSearch
              treeNodeFilterProp="title"
              placeholder="Aucun (élément racine)"
            />
          </NewItemField>
          <Button
            type="primary"
            block
            loading={busy}
            disabled={!label.trim() || !code.trim()}
            onClick={() => void create(close)}
          >
            Ajouter
          </Button>
        </NewItemForm>
      )}
    />
  );
}
