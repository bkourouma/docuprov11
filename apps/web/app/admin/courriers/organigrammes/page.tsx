'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Input, Popconfirm, Table, TreeSelect } from 'antd';
import type { TableColumnsType } from 'antd';
import { NewItemField, NewItemForm, RefLayout } from '../../../components/RefLayout';
import { EditableLocation, EditableText, type TreeOption } from '../../../components/editable';
import { TableSkeleton } from '../../../components/skeletons';
import { icons } from '../../../theme/icons';
import { colors } from '../../../theme/tokens';
import {
  createOrganigramme,
  deleteOrganigramme,
  listOrganigramme,
  reparentOrganigramme,
  updateOrganigramme,
  type OrganigrammeNode,
} from '../../../lib/courriers';

/** Construit les options TreeSelect depuis la liste plate (parentId). */
function buildTree(rows: OrganigrammeNode[]): TreeOption[] {
  const byId = new Map<number, TreeOption>();
  rows.forEach((r) => byId.set(r.organigrammeId, { value: r.organigrammeId, title: r.label }));
  const roots: TreeOption[] = [];
  rows.forEach((r) => {
    const node = byId.get(r.organigrammeId)!;
    const parent = r.parentId != null ? byId.get(r.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  });
  return roots;
}

/**
 * Gouttières de profondeur. L'arbre est rendu à plat dans une Table : sans trait vertical,
 * seul un retrait séparait un enfant de son parent — illisible dès le troisième niveau.
 * Un trait par niveau traversé, sur la couleur de séparateur du thème (donc lisible en clair
 * comme en sombre).
 */
function DepthGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          style={{
            width: 20,
            flex: 'none',
            // `alignSelf: stretch` : le trait prend toute la hauteur de la ligne, sinon il
            // se réduit à la hauteur du libellé et les niveaux ne se rejoignent plus.
            alignSelf: 'stretch',
            borderLeft: `1px solid var(--ant-color-split, ${colors.borderSecondary})`,
          }}
        />
      ))}
    </>
  );
}

export default function OrganigrammesPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<OrganigrammeNode[]>([]);
  const [label, setLabel] = useState('');
  const [parentId, setParentId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  // Échec du chargement : le référentiel ne doit pas s'annoncer vide (cf. RefLayout).
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listOrganigramme());
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

  const tree = useMemo(() => buildTree(rows), [rows]);
  const labelById = useMemo(() => new Map(rows.map((r) => [r.organigrammeId, r.label])), [rows]);

  const create = async (close: () => void) => {
    setBusy(true);
    try {
      const created = await createOrganigramme({
        label: label.trim(),
        parentId: parentId ?? undefined,
      });
      setLabel('');
      setParentId(null);
      await load();
      // Repère visuel : dans un arbre à plat trié par le serveur, un nœud neuf se perd.
      const createdId = created?.organigrammeId;
      if (typeof createdId === 'number') {
        setHighlightId(createdId);
        setTimeout(() => setHighlightId(null), 1400);
      }
      message.success('Nœud créé');
      close();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: number, next: string) => {
    try {
      await updateOrganigramme(id, next);
      await load();
      message.success('Modifié');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
      await load();
    }
  };

  const move = async (id: number, next: number | null) => {
    try {
      await reparentOrganigramme(id, next);
      await load();
      message.success('Nœud déplacé');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Déplacement impossible');
      await load();
    }
  };

  const remove = async (id: number) => {
    try {
      await deleteOrganigramme(id);
      await load();
      message.success('Nœud et son sous-arbre désactivés');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Désactivation impossible');
    }
  };

  const columns: TableColumnsType<OrganigrammeNode> = [
    {
      title: 'Nœud (service / direction)',
      dataIndex: 'label',
      key: 'label',
      render: (_, r) => (
        <span style={{ display: 'inline-flex', alignItems: 'stretch', minHeight: 26 }}>
          <DepthGuides depth={r.depth} />
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              paddingLeft: r.depth > 0 ? 8 : 0,
              // Les racines portent le poids de la hiérarchie sans dépendre du seul retrait.
              fontWeight: r.depth === 0 ? 600 : 400,
            }}
          >
            <EditableText value={r.label} required onSave={(v) => rename(r.organigrammeId, v)} />
          </span>
        </span>
      ),
    },
    {
      title: 'Parent',
      key: 'parent',
      width: 260,
      render: (_, r) => (
        <EditableLocation
          currentId={r.parentId}
          currentLabel={r.parentId != null ? (labelById.get(r.parentId) ?? '') : '— Racine —'}
          options={tree}
          onSave={(v) => move(r.organigrammeId, v)}
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
          title="Désactiver ce nœud ?"
          description="Le nœud et tout son sous-arbre seront désactivés ; les courriers existants conservent leur rattachement."
          okText="Désactiver"
          cancelText="Annuler"
          okButtonProps={{ danger: true }}
          onConfirm={() => void remove(r.organigrammeId)}
        >
          <Button
            type="text"
            danger
            size="small"
            aria-label={`Désactiver le nœud ${r.label}`}
            style={{ height: 40, minWidth: 40 }}
            icon={<icons.delete size={16} />}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <RefLayout
      loadFailed={loadFailed && rows.length === 0}
      onRetry={load}
      icon="organigramme"
      title="Organigrammes"
      tableTitle="Organigramme"
      formTitle="Nouveau nœud"
      tableSpan={16}
      table={
        // Sans état de chargement, la table affichait « Aucune donnée » le temps du premier appel.
        firstLoad && loading ? (
          <TableSkeleton rows={6} columns={3} />
        ) : (
          <Table<OrganigrammeNode>
            rowKey="organigrammeId"
            dataSource={rows}
            columns={columns}
            loading={loading}
            size="middle"
            scroll={{ x: 'max-content' }}
            rowClassName={(r) => (r.organigrammeId === highlightId ? 'da-row-flash' : '')}
            // Sélection purement visuelle : dans une longue liste à plat, elle sert de repère
            // le temps de suivre une branche du regard (aucune incidence métier).
            onRow={(r) => ({
              onClick: () => setSelectedId(r.organigrammeId),
              'aria-selected': r.organigrammeId === selectedId,
              style:
                r.organigrammeId === selectedId
                  ? { background: `var(--ant-color-primary-bg, ${colors.primarySoft})` }
                  : undefined,
            })}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `${t} nœud(s)` }}
          />
        )
      }
      renderForm={(close) => (
        <NewItemForm>
          <NewItemField label="Nom du nœud" required>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={() => label.trim() && void create(close)}
              placeholder="Ex. Direction générale"
            />
          </NewItemField>
          <NewItemField label="Parent (vide = racine)">
            <TreeSelect
              style={{ width: '100%' }}
              allowClear
              showSearch
              treeNodeFilterProp="title"
              treeDefaultExpandAll
              placeholder="— Racine —"
              value={parentId ?? undefined}
              onChange={(v) => setParentId((v as number) ?? null)}
              treeData={tree}
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
