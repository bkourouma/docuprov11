'use client';

import { useState } from 'react';
import { Button, Tag, Typography } from 'antd';
import { useFeedback } from '../../components/feedback';
import { icons, iconDefaults } from '../../theme/icons';
import { space as spacing } from '../../theme/tokens';
import {
  OAUTH_STATUS_LABELS,
  formatDateTime,
  oauthButtonLabel,
  oauthScopesHelp,
  oauthStatus,
  startOAuthAuthorization,
  type GedConnectorTypeInfo,
  type GedConnectorView,
  type OAuthStatus,
} from '../../lib/connecteurs';

const OAUTH_COLOR: Record<Exclude<OAuthStatus, 'not_applicable'>, string> = {
  missing: 'default',
  expired: 'error',
  expiring: 'warning',
  authorized: 'success',
};

/** Pastille d'état d'autorisation : le sens est porté par le texte, pas par la seule couleur. */
export function OAuthStatusTag({ status }: { status: OAuthStatus }) {
  if (status === 'not_applicable') return null;
  const alert = status === 'expired' || status === 'expiring';
  const Glyph = alert ? icons.alert : status === 'authorized' ? icons.check : null;
  return (
    <Tag
      color={OAUTH_COLOR[status]}
      icon={
        Glyph ? (
          <Glyph
            size={iconDefaults.size}
            style={{ verticalAlign: 'text-bottom', marginInlineEnd: spacing.xs }}
          />
        ) : undefined
      }
    >
      {OAUTH_STATUS_LABELS[status]}
    </Tag>
  );
}

/**
 * Bouton « Autoriser avec Google / Microsoft ». N'est rendu que pour un type disposant d'OAuth.
 * Au clic : démarre l'autorisation côté API puis redirige le navigateur (rien n'est stocké).
 */
export function OAuthAuthorizeButton({
  connector,
  typeInfo,
  size,
  type,
}: {
  connector: GedConnectorView;
  typeInfo: GedConnectorTypeInfo | undefined;
  size?: 'small' | 'middle';
  type?: 'primary' | 'default';
}) {
  const { message } = useFeedback();
  const [loading, setLoading] = useState(false);
  const oauth = typeInfo?.oauth;
  if (!oauth) return null;

  const status = oauthStatus(connector, typeInfo);
  const Go = icons.arrowRight;
  const label = oauthButtonLabel(oauth, status);

  const onClick = async () => {
    setLoading(true);
    try {
      await startOAuthAuthorization(connector.gedSourceConnectorId);
      // La page est quittée : on laisse le bouton en chargement jusqu'au changement de page.
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Autorisation impossible');
      setLoading(false);
    }
  };

  return (
    <Button
      size={size}
      type={type}
      icon={<Go size={iconDefaults.size} />}
      loading={loading}
      aria-label={`${label} — ${connector.label}`}
      onClick={() => void onClick()}
    >
      {label}
    </Button>
  );
}

/** Bloc d'état pour la fiche : pastille, date d'expiration et périmètres demandés (lecture seule). */
export function OAuthSummary({
  connector,
  typeInfo,
}: {
  connector: GedConnectorView;
  typeInfo: GedConnectorTypeInfo | undefined;
}) {
  if (!typeInfo?.oauth) return null;
  const status = oauthStatus(connector, typeInfo);
  const expires = formatDateTime(connector.credentialsExpiresAt);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.xs }}>
      <span>
        <OAuthStatusTag status={status} />
        {expires && (
          <Typography.Text type="secondary">
            {status === 'expired' ? 'Expirée le ' : 'Expire le '}
            {expires}
          </Typography.Text>
        )}
      </span>
      <Typography.Text type="secondary">{oauthScopesHelp(typeInfo.oauth)}</Typography.Text>
    </div>
  );
}
