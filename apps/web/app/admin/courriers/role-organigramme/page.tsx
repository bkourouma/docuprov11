'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Card, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { PageHeader } from '../../../components/PageHeader';
import { EditableLocation, type TreeOption } from '../../../components/editable';
import { TableSkeleton } from '../../../components/skeletons';
import { colors } from '../../../theme/tokens';
import {
  assignRoleOrganigramme,
  listOrganigramme,
  listRoleAssignments,
  type OrganigrammeNode,
  type RoleAssignmentRow,
} from '../../../lib/courriers';

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

export default function RoleOrganigrammePage() {
  const { message } = App.useApp();
  const [roles, setRoles] = useState<RoleAssignmentRow[]>([]);
  const [nodes, setNodes] = useState<OrganigrammeNode[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, n] = await Promise.all([listRoleAssignments(), listOrganigramme()]);
      setRoles(r);
      setNodes(n);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const tree = useMemo(() => buildTree(nodes), [nodes]);

  const assign = async (roleId: number, organigrammeId: number | null) => {
    try {
      await assignRoleOrganigramme(roleId, organigrammeId);
      await load();
      message.success('Assignation enregistrée');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Assignation impossible');
      await load();
    }
  };

  const columns: TableColumnsType<RoleAssignmentRow> = [
    { title: 'Rôle', dataIndex: 'name', key: 'name' },
    {
      title: 'Organigramme assigné',
      key: 'organigramme',
      width: 320,
      render: (_, r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <EditableLocation
            currentId={r.organigrammeId}
            currentLabel={r.organigramme?.label ?? ''}
            options={tree}
            onSave={(v) => assign(r.roleId, v)}
          />
          {r.organigrammeId == null && (
            // Un rôle non rattaché produit des courriers sans organigramme : le tiret d'une
            // cellule vide ne le disait pas. Fond AA (blanc dessus : 4,77:1), constant dans
            // les deux thèmes — les vifs ne portent jamais de texte (règle d'or §4.1).
            <Tag
              color={colors.warning}
              style={{ margin: 0, fontWeight: 600 }}
              title="Aucun nœud d'organigramme n'est assigné à ce rôle."
            >
              Non rattaché
            </Tag>
          )}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader icon="roles" title="Rôles ↔ organigramme" />
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="À quoi sert ce rattachement ?"
        description="À l'enregistrement d'un courrier, l'organigramme est dérivé du rôle de son destinataire. Il n'existe pas de table dédiée : l'assignation est portée par une colonne du rôle."
      />
      <Card title="Rôles">
        {loading ? (
          <TableSkeleton rows={6} columns={2} />
        ) : (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              Un rôle sans organigramme laisse le courrier sans rattachement organisationnel.
            </Typography.Paragraph>
            <Table<RoleAssignmentRow>
              rowKey="roleId"
              dataSource={roles}
              columns={columns}
              size="middle"
              scroll={{ x: 'max-content' }}
              pagination={{ pageSize: 20, showTotal: (t) => `${t} rôle(s)` }}
            />
          </>
        )}
      </Card>
    </div>
  );
}
