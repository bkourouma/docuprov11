'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { App, Button, Input, Select, Space, Table, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { EmptyState } from '../../components/EmptyState';
import { TableSkeleton } from '../../components/skeletons';
import { space as spacing } from '../../theme/tokens';
import {
  GED_SOURCE_ITEM_STATE_LABELS,
  GedSourceItemState,
  connecteursApi,
  formatDateTime,
  truncate,
  type GedSourceItemView,
} from '../../lib/connecteurs';
import { ItemStateTag } from './ConnectorBadges';

const PAGE_SIZE = 25;
const HASH_PREVIEW = 12;
const FIELD = spacing.xxxl * 5;
const dash = <Typography.Text type="secondary">—</Typography.Text>;

const STATE_OPTIONS = (
  Object.keys(GED_SOURCE_ITEM_STATE_LABELS).map(Number) as GedSourceItemState[]
).map((s) => ({ value: s, label: GED_SOURCE_ITEM_STATE_LABELS[s] }));

/** Lien cliquable seulement pour http(s) : toute autre origine (file:, chemin…) reste du texte. */
function OriginText({ item }: { item: GedSourceItemView }) {
  const text = item.originUrl ?? item.originPath;
  if (!text) return dash;
  const isWeb = /^https?:\/\//i.test(text);
  return (
    <Tooltip title={text}>
      {isWeb ? (
        <a href={text} target="_blank" rel="noopener noreferrer">
          {truncate(text, 48)}
        </a>
      ) : (
        <Typography.Text>{truncate(text, 48)}</Typography.Text>
      )}
    </Tooltip>
  );
}

/** Détail repliable d'une ligne : droits d'origine (ACL de la source) et message d'erreur. */
function ItemExpanded({ item }: { item: GedSourceItemView }) {
  const acl = item.originAcl;
  return (
    <Space direction="vertical" size={spacing.sm} style={{ width: '100%' }}>
      <Typography.Text strong>Droits d’origine</Typography.Text>
      {acl === null || acl === undefined ? (
        <Typography.Text type="secondary">Aucun droit d’origine enregistré.</Typography.Text>
      ) : (
        <Typography.Paragraph>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {JSON.stringify(acl, null, 2)}
          </pre>
        </Typography.Paragraph>
      )}
      {item.errorMessage && (
        <Typography.Text type="danger">Erreur : {item.errorMessage}</Typography.Text>
      )}
    </Space>
  );
}

/** Éléments issus de la source : tableau paginé côté serveur, filtre d'état et recherche. */
export function ConnectorItemsTab({
  connectorId,
  refreshKey,
  variant = 'default',
}: {
  connectorId: number;
  refreshKey: number;
  /**
   * `messages` (WhatsApp) : « Messages reçus ». Colonnes réduites (nom, état, motif d'erreur, date) ;
   * ni origine, ni auteur, ni droits d'origine, qui pourraient identifier un numéro de téléphone.
   */
  variant?: 'default' | 'messages';
}) {
  const messages = variant === 'messages';
  const { message } = App.useApp();
  const router = useRouter();
  const [items, setItems] = useState<GedSourceItemView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<GedSourceItemState | undefined>();
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await connecteursApi.items(connectorId, { state, q, page, pageSize: PAGE_SIZE });
      setItems(r.items);
      setTotal(r.total);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Chargement des éléments impossible');
    } finally {
      setLoading(false);
    }
  }, [connectorId, state, q, page, message]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  /** « Doublon » : renvoie à l'original (son document s'il existe, sinon son nom). */
  const openOriginal = async (itemId: number) => {
    setOpening(itemId);
    try {
      const original = await connecteursApi.item(connectorId, itemId);
      if (original.documentId) router.push(`/documents/${original.documentId}`);
      else message.info(`Original : « ${original.name} » (aucun document associé).`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Chargement de l'original impossible");
    } finally {
      setOpening(null);
    }
  };

  const columns: TableColumnsType<GedSourceItemView> = [
    {
      title: 'Nom',
      dataIndex: 'name',
      render: (v: string) => <Typography.Text strong>{truncate(v, 60)}</Typography.Text>,
    },
    { title: 'Origine', key: 'origin', render: (_, r) => <OriginText item={r} /> },
    { title: 'Auteur', dataIndex: 'originAuthor', render: (v: string | null) => v ?? dash },
    {
      title: 'Dates d’origine',
      key: 'dates',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Typography.Text type="secondary">
            Créé : {formatDateTime(r.originCreatedAt) || '—'}
          </Typography.Text>
          <Typography.Text type="secondary">
            Modifié : {formatDateTime(r.originModifiedAt) || '—'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Empreinte',
      dataIndex: 'contentHash',
      render: (h: string | null) =>
        h ? (
          <Typography.Text code copyable={{ text: h, tooltips: ['Copier l’empreinte', 'Copiée'] }}>
            {truncate(h, HASH_PREVIEW)}
          </Typography.Text>
        ) : (
          dash
        ),
    },
    {
      title: 'État',
      dataIndex: 'state',
      render: (s: GedSourceItemState, r) => (
        <Space direction="vertical" size={spacing.xs}>
          <ItemStateTag state={s} />
          {s === GedSourceItemState.Doublon && r.duplicateOfId != null && (
            <Button
              type="link"
              size="small"
              style={{ padding: 0 }}
              loading={opening === r.duplicateOfId}
              onClick={() => void openOriginal(r.duplicateOfId as number)}
            >
              Voir l’original (n° {r.duplicateOfId})
            </Button>
          )}
        </Space>
      ),
    },
    {
      title: 'Document',
      dataIndex: 'documentId',
      render: (id: number | null) =>
        id ? <Link href={`/documents/${id}`}>Ouvrir le document</Link> : dash,
    },
  ];

  const messageColumns: TableColumnsType<GedSourceItemView> = [
    {
      title: 'Nom',
      dataIndex: 'name',
      render: (v: string) => <Typography.Text strong>{truncate(v, 60)}</Typography.Text>,
    },
    {
      title: 'Reçu le',
      dataIndex: 'firstSeenAt',
      render: (v: string) => formatDateTime(v) || '—',
    },
    {
      title: 'État',
      dataIndex: 'state',
      render: (s: GedSourceItemState) => <ItemStateTag state={s} />,
    },
    {
      title: 'Motif d’erreur',
      dataIndex: 'errorMessage',
      render: (v: string | null) =>
        v ? <Typography.Text type="danger">{truncate(v, 120)}</Typography.Text> : dash,
    },
    {
      title: 'Document',
      dataIndex: 'documentId',
      render: (id: number | null) =>
        id ? <Link href={`/documents/${id}`}>Ouvrir le document</Link> : dash,
    },
  ];

  if (loading && items.length === 0 && !q && state === undefined) {
    return <TableSkeleton rows={5} columns={messages ? 5 : 7} />;
  }

  return (
    <>
      <div style={{ display: 'flex', gap: spacing.md, flexWrap: 'wrap', marginBottom: spacing.lg }}>
        <Input.Search
          allowClear
          placeholder={messages ? 'Rechercher un nom' : 'Rechercher un nom ou un chemin'}
          aria-label={messages ? 'Rechercher parmi les messages' : 'Rechercher parmi les éléments'}
          style={{ flex: `1 1 ${FIELD}px`, maxWidth: FIELD * 2 }}
          onSearch={(v) => {
            setPage(1);
            setQ(v);
          }}
        />
        <Select<GedSourceItemState>
          allowClear
          placeholder="Tous les états"
          aria-label="Filtrer par état"
          style={{ flex: `0 1 ${FIELD}px`, minWidth: FIELD }}
          value={state}
          onChange={(v) => {
            setPage(1);
            setState(v);
          }}
          options={STATE_OPTIONS}
        />
      </div>
      <Table<GedSourceItemView>
        rowKey="gedSourceItemId"
        loading={loading}
        columns={messages ? messageColumns : columns}
        dataSource={items}
        scroll={{ x: 'max-content' }}
        expandable={messages ? undefined : { expandedRowRender: (r) => <ItemExpanded item={r} /> }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          hideOnSinglePage: true,
          onChange: (p) => setPage(p),
        }}
        locale={{
          emptyText: (
            <EmptyState
              compact
              icon="search"
              title={
                q || state !== undefined
                  ? 'Aucun élément ne correspond à ce filtre.'
                  : messages
                    ? 'Aucun message reçu pour l’instant : les documents envoyés par WhatsApp apparaîtront ici.'
                    : 'Aucun élément pour l’instant : ils apparaîtront après la première synchronisation.'
              }
            />
          ),
        }}
      />
    </>
  );
}
