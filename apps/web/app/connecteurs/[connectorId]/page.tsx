'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { icons, iconDefaults } from '../../theme/icons';
import { space as spacing } from '../../theme/tokens';
import {
  GED_SOURCE_MODE_LABELS,
  connecteursApi,
  displayConfig,
  formatDateTime,
  isForbiddenError,
  type ConnectorTestResult,
  type GedConnectorTypeInfo,
  type GedConnectorView,
} from '../../lib/connecteurs';
import { ConnectorFormModal } from '../_components/ConnectorFormModal';
import { ConnectorStatusTag } from '../_components/ConnectorBadges';
import { ConnectorItemsTab } from '../_components/ConnectorItemsTab';
import { ConnectorRunsTab } from '../_components/ConnectorRunsTab';
import { ForbiddenState } from '../_components/ForbiddenState';
import { OAuthAuthorizeButton, OAuthSummary } from '../_components/OAuthAuthorization';
import { useConnectorActions } from '../_components/useConnectorActions';

const dash = <Typography.Text type="secondary">—</Typography.Text>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Droits d'origine configurés (clé `rights` de la config) : correspondances et groupes de repli. */
function RightsSummary({ config }: { config: Record<string, unknown> | null }) {
  const rights = isRecord(config?.rights) ? config.rights : {};
  const map = isRecord(rights.principalMap) ? Object.entries(rights.principalMap) : [];
  const fallback = Array.isArray(rights.fallbackUserGroupIds) ? rights.fallbackUserGroupIds : [];
  return (
    <Space direction="vertical" size={spacing.xs}>
      <Typography.Text>
        Groupes de repli : {fallback.length > 0 ? fallback.join(', ') : 'aucun'}
      </Typography.Text>
      {map.length === 0 ? (
        <Typography.Text type="secondary">Aucune correspondance de principaux.</Typography.Text>
      ) : (
        map.map(([principal, group]) => (
          <Typography.Text key={principal}>
            {principal} → groupe {String(group)}
          </Typography.Text>
        ))
      )}
    </Space>
  );
}

/**
 * Docu-GED lot 2a — détail d'un connecteur : fiche, historique des passes, éléments et provenance.
 * Réservé aux administrateurs (refus 403 de l'API -> état dédié).
 */
export default function ConnecteurDetailPage() {
  const { message } = App.useApp();
  const router = useRouter();
  const params = useParams<{ connectorId: string }>();
  const id = Number(params.connectorId);
  const validId = Number.isSafeInteger(id) && id > 0;

  const [connector, setConnector] = useState<GedConnectorView | null>(null);
  const [types, setTypes] = useState<GedConnectorTypeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(!validId);
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    if (!validId) return;
    setLoading(true);
    try {
      const [c, t] = await Promise.all([connecteursApi.get(id), connecteursApi.types()]);
      setConnector(c);
      setTypes(t);
      setForbidden(false);
      setNotFound(false);
    } catch (e) {
      if (isForbiddenError(e)) setForbidden(true);
      else {
        setNotFound(true);
        message.error(e instanceof Error ? e.message : 'Chargement du connecteur impossible');
      }
    } finally {
      setLoading(false);
    }
  }, [id, validId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(async () => {
    await load();
    setRefreshKey((k) => k + 1);
  }, [load]);

  const { busy, test, sync, toggle } = useConnectorActions(reload);

  const Check = icons.check;
  const Sync = icons.refresh;
  const Edit = icons.edit;
  const Back = icons.arrowLeft;

  const crumbs = [
    { label: 'Connecteurs', href: '/connecteurs' },
    { label: connector?.label ?? 'Détail' },
  ];

  if (forbidden) {
    return (
      <div>
        <PageHeader title="Connecteur" icon="download" breadcrumb={crumbs} />
        <ForbiddenState />
      </div>
    );
  }

  if (notFound) {
    return (
      <div>
        <PageHeader title="Connecteur" icon="download" breadcrumb={crumbs} />
        <Card>
          <EmptyState
            icon="search"
            title="Ce connecteur est introuvable."
            action={
              <Button
                icon={<Back size={iconDefaults.size} />}
                onClick={() => router.push('/connecteurs')}
              >
                Retour aux connecteurs
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (!connector) {
    return (
      <div aria-busy={loading}>
        <PageHeader title="Connecteur" icon="download" breadcrumb={crumbs} />
        <Card>
          <Skeleton active paragraph={{ rows: 6 }} />
        </Card>
      </div>
    );
  }

  const typeInfo = types.find((t) => t.type === connector.connectorType);
  const cid = connector.gedSourceConnectorId;
  const config = displayConfig(connector.config);

  return (
    <div>
      <PageHeader
        title={connector.label}
        icon="download"
        breadcrumb={crumbs}
        actions={
          <>
            <OAuthAuthorizeButton connector={connector} typeInfo={typeInfo} />
            <Button
              icon={<Check size={iconDefaults.size} />}
              loading={busy === `test:${cid}`}
              onClick={async () => {
                const r = await test(connector);
                if (r) setTestResult(r);
              }}
            >
              Tester
            </Button>
            <Button
              icon={<Sync size={iconDefaults.size} />}
              loading={busy === `sync:${cid}`}
              disabled={!connector.isActive}
              onClick={() => void sync(connector)}
            >
              Synchroniser maintenant
            </Button>
            <Button loading={busy === `toggle:${cid}`} onClick={() => toggle(connector)}>
              {connector.isActive ? 'Désactiver' : 'Activer'}
            </Button>
            <Button
              type="primary"
              icon={<Edit size={iconDefaults.size} />}
              onClick={() => setEditing(true)}
            >
              Modifier
            </Button>
          </>
        }
      />

      {testResult && (
        <Alert
          style={{ marginBottom: spacing.lg }}
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          closable
          onClose={() => setTestResult(null)}
          message={testResult.ok ? 'Test de connexion réussi' : 'Test de connexion échoué'}
          description={testResult.message}
        />
      )}

      <Card style={{ marginBottom: spacing.lg }}>
        <Descriptions
          column={{ xs: 1, sm: 1, md: 2, lg: 2 }}
          size="small"
          bordered
          items={[
            {
              key: 'type',
              label: 'Type de source',
              children: typeInfo?.label ?? connector.connectorType,
            },
            { key: 'mode', label: 'Mode', children: GED_SOURCE_MODE_LABELS[connector.mode] },
            {
              key: 'status',
              label: 'Statut',
              children: <ConnectorStatusTag status={connector.status} />,
            },
            {
              key: 'active',
              label: 'Actif',
              children: connector.isActive ? <Tag color="success">Oui</Tag> : <Tag>Non</Tag>,
            },
            {
              key: 'interval',
              label: 'Synchronisation',
              children: connector.syncIntervalMinutes
                ? `Toutes les ${connector.syncIntervalMinutes} minutes`
                : 'Manuelle',
            },
            {
              key: 'dossier',
              label: 'Dossier de destination',
              children: connector.targetDossierId ?? dash,
            },
            {
              key: 'last',
              label: 'Dernière passe',
              children: formatDateTime(connector.lastSyncAt) || dash,
            },
            {
              key: 'ok',
              label: 'Dernière réussite',
              children: formatDateTime(connector.lastSuccessAt) || dash,
            },
            ...(typeInfo?.oauth
              ? [
                  {
                    key: 'oauth',
                    label: 'Autorisation',
                    span: 'filled' as const,
                    children: <OAuthSummary connector={connector} typeInfo={typeInfo} />,
                  },
                ]
              : []),
            {
              key: 'creds',
              label: 'Identifiants',
              children: connector.hasCredentials ? 'Enregistrés' : 'Aucun',
            },
            {
              key: 'credsExp',
              label: 'Expiration des identifiants',
              children: formatDateTime(connector.credentialsExpiresAt) || dash,
            },
            ...config.map((c) => ({
              key: `cfg-${c.key}`,
              label: c.key,
              children: c.value || dash,
            })),
            {
              key: 'rights',
              label: 'Droits d’origine',
              span: 'filled' as const,
              children: <RightsSummary config={connector.config} />,
            },
            {
              key: 'created',
              label: 'Créé le',
              children: formatDateTime(connector.createdAt),
            },
            {
              key: 'updated',
              label: 'Modifié le',
              children: formatDateTime(connector.updatedAt),
            },
          ]}
        />
        {connector.lastError && (
          <Alert
            style={{ marginTop: spacing.lg }}
            type="error"
            showIcon
            message="Dernière erreur"
            description={connector.lastError}
          />
        )}
      </Card>

      <Card>
        <Tabs
          defaultActiveKey="runs"
          items={[
            {
              key: 'runs',
              label: 'Synchronisations',
              children: <ConnectorRunsTab connectorId={cid} refreshKey={refreshKey} />,
            },
            {
              key: 'items',
              label: 'Éléments et provenance',
              children: <ConnectorItemsTab connectorId={cid} refreshKey={refreshKey} />,
            },
          ]}
        />
      </Card>

      <ConnectorFormModal
        open={editing}
        types={types}
        connector={connector}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          void reload();
        }}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: spacing.lg }}>
        <Link href="/connecteurs">Retour à la liste des connecteurs</Link>
      </Typography.Paragraph>
    </div>
  );
}
