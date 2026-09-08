'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Input, Popconfirm, Table, TreeSelect } from 'antd';
import type { TableColumnsType } from 'antd';
import { apiJson } from '../../lib/api';
import { RefLayout, NewItemField, NewItemForm } from '../../components/RefLayout';
import { EditableText, type TreeOption } from '../../components/editable';
import { icons } from '../../theme/icons';

/**
 * Conséquence énoncée dans la confirmation (« verbe + objet + conséquence ») : la suppression est
 * une DÉSACTIVATION en cascade côté serveur (la branche entière passe à `isActive = false`), jamais
 * un effacement des documents qui y sont rangés.
 */
const EFFET_SUPPRESSION =
  'Les sous-dossiers partent avec lui. Les documents déjà rangés restent lisibles, mais le dossier ne sera plus proposé au classement.';

// Un dossier ne porte plus ni localisation ni catégorie : les deux champs ont été retirés de
// l'écran ET de la base (migration 20260731160000_drop_dossier_location_category). La
// localisation reste une propriété du DOCUMENT, pas du dossier.
interface Dossier {
  dossierId: number;
  parentId: number | null;
  label: string;
  code: string | null;
  depth: number;
  path: string;
}
interface DossierNode extends Dossier {
  children?: DossierNode[];
}

function buildTree<T extends { children?: T[]; parentId: number | null }>(
  rows: T[],
  idOf: (r: T) => number,
): T[] {
  const byId = new Map<number, T>();
  rows.forEach((r) => byId.set(idOf(r), { ...r }));
  const roots: T[] = [];
  byId.forEach((node) => {
    const parent = node.parentId != null ? byId.get(node.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  });
  return roots;
}

function toTreeOptions<T extends { children?: T[]; label: string }>(
  nodes: T[],
  idOf: (r: T) => number,
): TreeOption[] {
  return nodes.map((n) => ({
    value: idOf(n),
    title: n.label,
    children: n.children ? toTreeOptions(n.children, idOf) : undefined,
  }));
}

export default function DossiersPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Dossier[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<number[]>([]);
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [parentId, setParentId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<Dossier[]>('/referentials/dossiers');
      setRows(d);
      setExpandedKeys(d.map((r) => r.dossierId)); // org-chart view: fully expanded
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const tree = useMemo(() => buildTree(rows as DossierNode[], (r) => r.dossierId), [rows]);
  const parentOptions = useMemo(() => toTreeOptions(tree, (r) => r.dossierId), [tree]);

  const flash = (id: number) => {
    setHighlightId(id);
    setTimeout(() => setHighlightId(null), 1400);
  };

  const create = async (close: () => void) => {
    setBusy(true);
    try {
      const created = await apiJson<Dossier>('/referentials/dossiers', {
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
      if (created?.dossierId) flash(created.dossierId);
      message.success('Dossier créé');
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const save = async (id: number, patch: { label?: string; code?: string }) => {
    try {
      await apiJson(`/referentials/dossiers/${id}`, {
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
      await apiJson(`/referentials/dossiers/${id}`, { method: 'DELETE' });
      await load();
      message.success('Dossier supprimé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Suppression impossible');
    }
  };

  const columns: TableColumnsType<DossierNode> = [
    {
      title: "Nom de l'élément",
      dataIndex: 'label',
      key: 'label',
      render: (_, r) => (
        // Texte primaire sur la ligne retenue comme parent : le fond seul (10 % de primaire) ne se
        // distingue pas d'un survol une fois le pointeur ailleurs.
        <span style={r.dossierId === parentId ? { color: 'var(--ant-color-primary)' } : undefined}>
          <EditableText value={r.label} required onSave={(v) => save(r.dossierId, { label: v })} />
        </span>
      ),
    },
    {
      title: 'Code',
      dataIndex: 'code',
      key: 'code',
      width: 200,
      render: (_, r) => (
        <EditableText value={r.code} required mono onSave={(v) => save(r.dossierId, { code: v })} />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 56,
      align: 'center',
      render: (_, r) => (
        <Popconfirm
          title="Supprimer ce dossier et ses sous-dossiers ?"
          description={EFFET_SUPPRESSION}
          okText="Supprimer"
          okButtonProps={{ danger: true }}
          cancelText="Annuler"
          onConfirm={() => void remove(r.dossierId)}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label="Supprimer ce dossier"
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <RefLayout
      icon="dossier"
      title="Gestion des dossiers"
      exportPath="/referentials/dossiers/export"
      exportFilename="dossiers"
      tableTitle="Dossiers"
      formTitle="Nouveau dossier"
      tableSpan={16}
      table={
        <Table<DossierNode>
          rowKey="dossierId"
          dataSource={tree}
          columns={columns}
          size="middle"
          scroll={{ x: 'max-content' }}
          // `ant-table-row-selected` : la teinte de sélection d'AntD vaut déjà le primaire à ~10 %
          // exigé par la grille — la poser ici évite d'inventer une seconde couleur de surlignage.
          rowClassName={(r) =>
            [
              r.dossierId === highlightId ? 'da-row-flash' : '',
              r.dossierId === parentId ? 'ant-table-row-selected' : '',
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
        // géolocalisation) : l'identité de l'élément d'abord, son emplacement ensuite.
        <NewItemForm>
          <NewItemField label="Nom de l'élément" required>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={() => label.trim() && code.trim() && void create(close)}
              placeholder="Ex. Comptabilité 2026"
            />
          </NewItemField>
          <NewItemField label="Code" required>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onPressEnter={() => label.trim() && code.trim() && void create(close)}
              placeholder="Ex. CPTA-2026"
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
              placeholder="Aucun (dossier racine)"
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
