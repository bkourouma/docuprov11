'use client';

import { Alert, Card, Descriptions, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { API_BASE } from '../../lib/api';
import type { GedConnectorView } from '../../lib/connecteurs';
import { space as spacing } from '../../theme/tokens';
import { ConnectorStatusTag } from './ConnectorBadges';
import { useDocuproGroups } from './useDocuproGroups';
import {
  readWhatsappSendersMasked,
  readWhatsappValues,
  whatsappWebhookUrl,
  type WhatsappSenderView,
} from './whatsapp-config';

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/** Indicateur oui/non : le sens est porté par le texte, la teinte n'est qu'un renfort. */
const flag = (on: boolean, yes: string, no: string) =>
  on ? <Tag color="success">{yes}</Tag> : <Tag>{no}</Tag>;

/**
 * Panneau « WhatsApp Business » de la page de détail : état, URL du webhook à saisir dans Meta,
 * indicateurs et expéditeurs autorisés. Aucun numéro complet n'est affiché (masquage dès la lecture)
 * et aucun secret n'est connu de cette page (booléen `hasCredentials` seulement).
 */
export function WhatsappPanel({ connector }: { connector: GedConnectorView }) {
  const groups = useDocuproGroups();
  const values = readWhatsappValues(connector);
  const senders = readWhatsappSendersMasked(connector);
  const webhook = whatsappWebhookUrl(connector.gedSourceConnectorId, API_BASE);

  const columns: TableColumnsType<WhatsappSenderView> = [
    {
      title: 'Numéro (masqué)',
      dataIndex: 'masked',
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    { title: 'Libellé', dataIndex: 'label', render: (v: string) => v || dash },
    {
      title: 'Groupe DocuPro',
      dataIndex: 'userGroupId',
      render: (id: number | null) =>
        id === null ? (
          <Typography.Text type="secondary">Groupes de repli</Typography.Text>
        ) : (
          groups.labelOf(id)
        ),
    },
  ];

  return (
    <Card title="WhatsApp Business" style={{ marginBottom: spacing.lg }}>
      <Descriptions
        column={{ xs: 1, sm: 1, md: 2, lg: 2 }}
        size="small"
        bordered
        items={[
          {
            key: 'state',
            label: 'État',
            children: (
              <>
                <ConnectorStatusTag status={connector.status} />{' '}
                {connector.isActive ? <Tag color="success">Actif</Tag> : <Tag>Inactif</Tag>}
              </>
            ),
          },
          {
            key: 'phoneNumberId',
            label: 'Phone Number ID',
            children: values.phoneNumberId || dash,
          },
          {
            key: 'ack',
            label: 'Accusé de réception',
            children: flag(values.ackEnabled !== false, 'Activé', 'Désactivé'),
          },
          {
            key: 'refuse',
            label: 'Refus poli aux inconnus',
            children: flag(values.refuseUnknownSenders === true, 'Activé', 'Désactivé'),
          },
          {
            key: 'secrets',
            label: 'Secrets',
            children: flag(connector.hasCredentials, 'Enregistrés', 'Non enregistrés'),
          },
          {
            key: 'webhook',
            label: 'URL du webhook',
            span: 'filled' as const,
            children: (
              <>
                <Typography.Text
                  code
                  copyable={{ text: webhook.url, tooltips: ['Copier l’URL', 'URL copiée'] }}
                  style={{ wordBreak: 'break-all' }}
                >
                  {webhook.url}
                </Typography.Text>
                {!webhook.complete && (
                  <Typography.Paragraph type="secondary" style={{ margin: `${spacing.xs}px 0 0` }}>
                    Ceci est le chemin : préfixez-le par l’adresse publique (HTTPS) de l’API.
                  </Typography.Paragraph>
                )}
              </>
            ),
          },
        ]}
      />

      <Alert
        style={{ marginTop: spacing.lg }}
        type="info"
        showIcon
        message="À saisir dans la console Meta"
        description="Dans la configuration du webhook WhatsApp, collez l’URL ci-dessus et le « Verify token » enregistré dans DocuPro. Le « Secret de l’application » doit aussi être celui de votre application Meta : il sert à vérifier la signature des messages. Ces valeurs ne sont jamais réaffichées ici."
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

      <Typography.Title level={5} style={{ marginTop: spacing.lg }}>
        Expéditeurs autorisés
      </Typography.Title>
      <Table<WhatsappSenderView>
        size="small"
        rowKey={(_, index) => String(index)}
        columns={columns}
        dataSource={senders}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: 'Aucun expéditeur autorisé : tous les messages sont refusés.',
        }}
      />
    </Card>
  );
}
