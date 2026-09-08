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
 * un effacement des documents qui la citent.
 */
const EFFET_SUPPRESSION =
  'Les sous-éléments partent avec lui. Les documents déjà classés restent lisibles, mais la rubrique ne sera plus proposée au classement.';

interface Plan {
  planId: number;
  parentId: number | null;
  label: string;
  code: string | null;
  depth: number;
  path: string;
}
interface PlanNode extends Plan {
  children?: PlanNode[];
}
interface TreeOpt {
  value: number;
  title: string;
  children?: TreeOpt[];
}

/**
 * Tri d'affichage : par COTE, en comparaison naturelle (`numeric`), puis par libellé pour les
 * éléments non cotés — qui passent en dernier.
 *
 * Le serveur trie par `path`, or un chemin est une CHAÎNE : « /10/ » y précède « /2/ ». Sur un
 * plan à cotation décimale, les rubriques sortaient donc dans le désordre (3, 4, 1, 5, 6, 2).
 * Le tri se fait ici plutôt que côté serveur : `path` reste l'ordre naturel des arborescences
 * non cotées (dossiers, géolocalisation), et c'est bien le plan de classement — seul référentiel
 * dont la cote porte l'ordre — qui a besoin d'être présenté autrement.
 */
function compareParCote(a: Plan, b: Plan): number {
  if (a.code && b.code) return a.code.localeCompare(b.code, 'fr', { numeric: true });
  if (a.code) return -1;
  if (b.code) return 1;
  return a.label.localeCompare(b.label, 'fr');
}

function buildTree(rows: Plan[]): PlanNode[] {
  const byId = new Map<number, PlanNode>();
  rows.forEach((r) => byId.set(r.planId, { ...r }));
  const roots: PlanNode[] = [];
  byId.forEach((node) => {
    const parent = node.parentId != null ? byId.get(node.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  });
  const trier = (nodes: PlanNode[]): void => {
    nodes.sort(compareParCote);
    nodes.forEach((n) => n.children && trier(n.children));
  };
  trier(roots);
  return roots;
}

function toTreeSelect(nodes: PlanNode[]): TreeOpt[] {
  return nodes.map((n) => ({
    value: n.planId,
    title: n.code ? `${n.label} (${n.code})` : n.label,
    children: n.children ? toTreeSelect(n.children) : undefined,
  }));
}

export default function ClassificationPlansPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Plan[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<number[]>([]);
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [parentId, setParentId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<Plan[]>('/referentials/plans');
      setRows(data);
      setExpandedKeys(data.map((r) => r.planId)); // org-chart view: fully expanded
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
      const created = await apiJson<Plan>('/referentials/plans', {
        method: 'POST',
        // `?? undefined` et non `null` : le schéma zod du serveur déclare `parentId` optionnel,
        // ce qui accepte l'absence de clé mais REFUSE un null explicite. Envoyer `null` ferait
        // échouer en 400 toute création d'élément racine.
        body: JSON.stringify({
          label: label.trim(),
          parentId: parentId ?? undefined,
          code: code.trim() || undefined,
        }),
      });
      setLabel('');
      setCode('');
      setParentId(null);
      await load();
      if (created?.planId) flash(created.planId);
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
      await apiJson(`/referentials/plans/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const remove = async (id: number) => {
    try {
      await apiJson(`/referentials/plans/${id}`, { method: 'DELETE' });
      await load();
      message.success('Élément supprimé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Suppression impossible');
    }
  };

  const columns: TableColumnsType<PlanNode> = [
    {
      title: "Nom de l'élément",
      dataIndex: 'label',
      key: 'label',
      render: (_, r) => (
        // Texte primaire sur la ligne retenue comme parent : le fond seul (10 % de primaire) ne se
        // distingue pas d'un survol une fois le pointeur ailleurs.
        <span style={r.planId === parentId ? { color: 'var(--ant-color-primary)' } : undefined}>
          <EditableText value={r.label} required onSave={(v) => save(r.planId, { label: v })} />
        </span>
      ),
    },
    {
      title: 'Code',
      dataIndex: 'code',
      key: 'code',
      width: 200,
      render: (_, r) => (
        <EditableText value={r.code} mono onSave={(v) => save(r.planId, { code: v })} />
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
          onConfirm={() => void remove(r.planId)}
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
      icon="classification"
      title="Plan de classement"
      exportPath="/referentials/plans/export"
      exportFilename="plan-classement"
      tableTitle="Éléments du plan"
      formTitle="Nouvel élément"
      tableSpan={16}
      table={
        <Table<PlanNode>
          rowKey="planId"
          dataSource={tree}
          columns={columns}
          size="middle"
          scroll={{ x: 'max-content' }}
          // `ant-table-row-selected` : la teinte de sélection d'AntD vaut déjà le primaire à ~10 %
          // exigé par la grille — la poser ici évite d'inventer une seconde couleur de surlignage.
          rowClassName={(r) =>
            [
              r.planId === highlightId ? 'da-row-flash' : '',
              r.planId === parentId ? 'ant-table-row-selected' : '',
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
        // Ordre Nom → Code → Parent, identique aux deux autres arbres (dossiers, géolocalisation) :
        // l'identité de l'élément d'abord, son emplacement ensuite.
        <NewItemForm>
          <NewItemField label="Nom de l'élément" required>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={() => label.trim() && void create(close)}
              placeholder="Ex. Ressources humaines"
            />
          </NewItemField>
          <NewItemField label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onPressEnter={() => label.trim() && void create(close)}
              placeholder="Ex. RH"
            />
          </NewItemField>
          {/* Parent FACULTATIF, comme pour les dossiers et la géolocalisation : sans cela,
              un plan vide (ou dont la racine a été désactivée) ne pouvait plus rien accueillir
              — aucun parent proposé, donc aucune création possible. */}
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
