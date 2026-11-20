'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { App, Button, Card, Input, Select, Space, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { TableSkeleton } from '../components/skeletons';
import { AccessTag, PublicationTag, SpaceKindTag } from '../components/espaces/SpaceBadges';
import { DocumentCount } from '../components/espaces/SpaceCount';
import { SpaceFormModal } from '../components/espaces/SpaceFormModal';
import { icons, iconDefaults } from '../theme/icons';
import { space as spacing } from '../theme/tokens';
import {
  EDITABLE_KINDS,
  GED_SPACE_KIND_LABELS,
  espacesApi,
  type GedSpaceKind,
  type GedSpaceSummary,
} from '../lib/espaces';

/** Largeurs de champs, dérivées de l'échelle d'espacement plutôt que de littéraux. */
const SHORT_FIELD = spacing.xxxl * 4;
const MID_FIELD = spacing.xxxl * 5;
const LONG_FIELD = spacing.xxxl * 8;

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/**
 * Docu-GED lot 4a — liste des espaces visibles par l'acteur.
 *
 * La visibilité est décidée par l'API (propriétaire, membre, ou publication) : la page affiche
 * ce qu'elle reçoit, sans filtrer de droits côté client. Recherche et filtre de type sont
 * locaux : la liste d'un acteur reste courte.
 */
export default function EspacesPage() {
  const { message } = App.useApp();
  const router = useRouter();
  const [rows, setRows] = useState<GedSpaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<GedSpaceKind | undefined>();
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await espacesApi.list());
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Chargement des espaces impossible');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (kind === undefined || r.kind === kind) &&
        (!needle ||
          r.label.toLowerCase().includes(needle) ||
          (r.description ?? '').toLowerCase().includes(needle)),
    );
  }, [rows, q, kind]);

  const Add = icons.add;

  const columns: TableColumnsType<GedSpaceSummary> = [
    {
      title: 'Espace',
      dataIndex: 'label',
      render: (v: string, r) => (
        <Space direction="vertical" size={0}>
          <Link href={`/espaces/${r.gedSpaceId}`}>{v}</Link>
          {r.description && (
            <Typography.Text type="secondary" ellipsis style={{ maxWidth: LONG_FIELD }}>
              {r.description}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: 'Type', dataIndex: 'kind', render: (k: GedSpaceKind) => <SpaceKindTag kind={k} /> },
    { title: 'Propriétaire', dataIndex: 'ownerName', render: (v: string | null) => v ?? dash },
    {
      title: 'Documents',
      dataIndex: 'documentCount',
      align: 'right',
      render: (v: number | null) => <DocumentCount value={v} />,
    },
    { title: 'Membres', dataIndex: 'memberCount', align: 'right' },
    {
      title: 'Publication',
      dataIndex: 'publicationSlug',
      render: (s: string | null) => <PublicationTag slug={s} />,
    },
    { title: 'Mon droit', dataIndex: 'myAccess', render: (a) => <AccessTag access={a} /> },
  ];

  return (
    <div>
      <PageHeader
        title="Espaces"
        icon="dossier"
        actions={
          <Button type="primary" icon={<Add size={iconDefaults.size} />} onClick={() => setCreating(true)}>
            Nouvel espace
          </Button>
        }
      />

      <Card>
        {loading && rows.length === 0 ? (
          <TableSkeleton rows={5} columns={7} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="dossier"
            title="Aucun espace pour l'instant : créez-en un pour regrouper des documents."
            action={
              <Button type="primary" icon={<Add size={iconDefaults.size} />} onClick={() => setCreating(true)}>
                Nouvel espace
              </Button>
            }
          />
        ) : (
          <>
            <div style={{ display: 'flex', gap: spacing.md, flexWrap: 'wrap', marginBottom: spacing.lg }}>
              <Input.Search
                allowClear
                placeholder="Rechercher un espace"
                aria-label="Rechercher un espace"
                style={{ flex: `1 1 ${MID_FIELD}px`, maxWidth: LONG_FIELD }}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <Select<GedSpaceKind>
                allowClear
                placeholder="Tous les types"
                aria-label="Filtrer par type"
                style={{ flex: `0 1 ${MID_FIELD}px`, minWidth: SHORT_FIELD }}
                value={kind}
                onChange={(v) => setKind(v)}
                options={[...EDITABLE_KINDS, 3 as const].map((k) => ({
                  value: k,
                  label: GED_SPACE_KIND_LABELS[k],
                }))}
              />
            </div>
            <Table<GedSpaceSummary>
              rowKey="gedSpaceId"
              loading={loading}
              columns={columns}
              dataSource={filtered}
              scroll={{ x: 'max-content' }}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
              locale={{
                emptyText: (
                  <EmptyState compact icon="search" title="Aucun espace ne correspond à ce filtre." />
                ),
              }}
            />
          </>
        )}
      </Card>

      <SpaceFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(s) => {
          setCreating(false);
          router.push(`/espaces/${s.gedSpaceId}`);
        }}
      />
    </div>
  );
}
