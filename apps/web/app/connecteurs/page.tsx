'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { App, Button, Card, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { GED_WHATSAPP_CONNECTOR_TYPE } from './_components/whatsapp-config';
import type { TableColumnsType } from 'antd';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { LoadFailure } from '../components/LoadFailure';
import { TableSkeleton } from '../components/skeletons';
import { icons, iconDefaults } from '../theme/icons';
import { space as spacing } from '../theme/tokens';
import {
  GED_SOURCE_MODE_LABELS,
  connecteursApi,
  formatDateTime,
  isForbiddenError,
  oauthStatus,
  truncate,
  type GedConnectorTypeInfo,
  type GedConnectorView,
} from '../lib/connecteurs';
import { ConnectorStatusTag } from './_components/ConnectorBadges';
import { ConnectorFormModal } from './_components/ConnectorFormModal';
import { ForbiddenState } from './_components/ForbiddenState';
import { OAuthAuthorizeButton, OAuthStatusTag } from './_components/OAuthAuthorization';
import { useConnectorActions } from './_components/useConnectorActions';

const ERROR_PREVIEW = 60;
const dash = <Typography.Text type="secondary">—</Typography.Text>;

/**
 * Docu-GED lot 2a — connecteurs de sources (administration).
 *
 * L'accès réel est décidé par l'API (`@RequireAdmin`) : un refus 403 affiche l'état « Accès
 * réservé aux administrateurs ». Les identifiants ne sont jamais affichés ici.
 */
export default function ConnecteursPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<GedConnectorView[]>([]);
  const [types, setTypes] = useState<GedConnectorTypeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [editing, setEditing] = useState<GedConnectorView | undefined>();
  const [formOpen, setFormOpen] = useState(false);

  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, t] = await Promise.all([connecteursApi.list(), connecteursApi.types()]);
      setRows(list);
      setTypes(t);
      setForbidden(false);
      setLoadFailed(false);
    } catch (e) {
      if (isForbiddenError(e)) setForbidden(true);
      else setLoadFailed(true);
      if (!isForbiddenError(e)) message.error(e instanceof Error ? e.message : 'Chargement des connecteurs impossible');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const { busy, test, sync, toggle } = useConnectorActions(load);
  const typeLabel = useMemo(() => new Map(types.map((t) => [t.type, t.label])), [types]);
  const typeInfo = useMemo(() => new Map(types.map((t) => [t.type, t])), [types]);

  const openForm = (c?: GedConnectorView) => {
    setEditing(c);
    setFormOpen(true);
  };

  const Add = icons.add;
  const Edit = icons.edit;
  const View = icons.view;
  const Sync = icons.refresh;
  const Check = icons.check;

  const columns: TableColumnsType<GedConnectorView> = [
    {
      title: 'Connecteur',
      dataIndex: 'label',
      render: (v: string, r) => <Link href={`/connecteurs/${r.gedSourceConnectorId}`}>{v}</Link>,
    },
    {
      title: 'Type',
      dataIndex: 'connectorType',
      render: (t: string) => typeLabel.get(t) ?? t,
    },
    {
      title: 'Mode',
      dataIndex: 'mode',
      render: (m: keyof typeof GED_SOURCE_MODE_LABELS) => GED_SOURCE_MODE_LABELS[m],
    },
    {
      title: 'Statut',
      dataIndex: 'status',
      render: (s) => <ConnectorStatusTag status={s} />,
    },
    {
      title: 'Autorisation',
      key: 'oauth',
      render: (_, r) => {
        const s = oauthStatus(r, typeInfo.get(r.connectorType));
        return s === 'not_applicable' ? dash : <OAuthStatusTag status={s} />;
      },
    },
    {
      title: 'Actif',
      dataIndex: 'isActive',
      render: (a: boolean) => (a ? <Tag color="success">Oui</Tag> : <Tag>Non</Tag>),
    },
    {
      title: 'Dernière synchro réussie',
      dataIndex: 'lastSuccessAt',
      render: (v: string | null) => (v ? formatDateTime(v) : dash),
    },
    {
      title: 'Dernière erreur',
      dataIndex: 'lastError',
      render: (v: string | null) =>
        v ? (
          <Tooltip title={v}>
            <Typography.Text type="danger">{truncate(v, ERROR_PREVIEW)}</Typography.Text>
          </Tooltip>
        ) : (
          dash
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      fixed: 'right',
      render: (_, r) => {
        const id = r.gedSourceConnectorId;
        return (
          <Space size={spacing.xs} wrap>
            <OAuthAuthorizeButton
              connector={r}
              typeInfo={typeInfo.get(r.connectorType)}
              size="small"
            />
            <Button
              size="small"
              icon={<Check size={iconDefaults.size} />}
              loading={busy === `test:${id}`}
              onClick={() => void test(r)}
            >
              Tester
            </Button>
            {r.connectorType !== GED_WHATSAPP_CONNECTOR_TYPE && (
              <Button
                size="small"
                icon={<Sync size={iconDefaults.size} />}
                loading={busy === `sync:${id}`}
                disabled={!r.isActive}
                onClick={() => void sync(r)}
              >
                Synchroniser maintenant
              </Button>
            )}
            <Button size="small" loading={busy === `toggle:${id}`} onClick={() => toggle(r)}>
              {r.isActive ? 'Désactiver' : 'Activer'}
            </Button>
            <Button
              size="small"
              icon={<Edit size={iconDefaults.size} />}
              aria-label={`Modifier ${r.label}`}
              onClick={() => openForm(r)}
            >
              Modifier
            </Button>
            <Link href={`/connecteurs/${id}`}>
              <Button
                size="small"
                icon={<View size={iconDefaults.size} />}
                aria-label={`Détail de ${r.label}`}
              >
                Détail
              </Button>
            </Link>
          </Space>
        );
      },
    },
  ];

  const newButton = (
    <Button type="primary" icon={<Add size={iconDefaults.size} />} onClick={() => openForm()}>
      Nouveau connecteur
    </Button>
  );

  return (
    <div>
      <PageHeader title="Connecteurs" icon="download" actions={forbidden ? undefined : newButton} />

      {forbidden ? (
        <ForbiddenState />
      ) : (
        <Card>
          {loading && rows.length === 0 ? (
            <TableSkeleton rows={4} columns={9} />
          ) : loadFailed && rows.length === 0 ? (
            <LoadFailure title="Les connecteurs n’ont pas pu être chargés" onRetry={load} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="download"
              title="Aucun connecteur : branchez une source (dossier partagé, messagerie…) pour importer ou indexer ses documents dans DocuPro."
              action={newButton}
            />
          ) : (
            <Table<GedConnectorView>
              rowKey="gedSourceConnectorId"
              loading={loading}
              columns={columns}
              dataSource={rows}
              scroll={{ x: 'max-content' }}
              pagination={{ pageSize: 20, hideOnSinglePage: true }}
            />
          )}
        </Card>
      )}

      <ConnectorFormModal
        open={formOpen}
        types={types}
        connector={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          void load();
        }}
      />
    </div>
  );
}
