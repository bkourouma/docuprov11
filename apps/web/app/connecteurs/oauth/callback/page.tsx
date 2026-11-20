'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, Spin } from 'antd';
import { PageHeader } from '../../../components/PageHeader';
import { icons, iconDefaults } from '../../../theme/icons';
import { space as spacing } from '../../../theme/tokens';
import {
  connecteursApi,
  consumeOAuthReturn,
  formatDateTime,
  isForbiddenError,
} from '../../../lib/connecteurs';
import { ForbiddenState } from '../../_components/ForbiddenState';

/** Délai d'affichage du message de réussite avant le retour à la fiche du connecteur. */
const REDIRECT_DELAY_MS = 1500;

type View =
  | { kind: 'loading' }
  | { kind: 'denied' }
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'failure'; message: string }
  | { kind: 'success'; connectorId: number; expiresAt: string | null };

const crumbs = [
  { label: 'Connecteurs', href: '/connecteurs' },
  { label: 'Autorisation du compte' },
];

/**
 * Docu-GED lot 2b — page de retour de l'autorisation OAuth (Google, Microsoft).
 *
 * Le code de retour est à usage unique et sensible : l'URL est nettoyée AVANT tout appel réseau
 * (historique, Referer), l'échange n'est tenté qu'une fois (mode strict de React inclus), et ni le
 * code ni le `state` ne sont jamais affichés. L'accès réel est décidé par l'API (administrateur).
 */
export default function OAuthCallbackPage() {
  const router = useRouter();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void consumeOAuthReturn({
      search: window.location.search,
      clearUrl: () =>
        window.history.replaceState(window.history.state, '', window.location.pathname),
      callback: (code, state) => connecteursApi.oauthCallback(code, state),
    }).then((outcome) => {
      if (outcome.kind === 'invalid') setView({ kind: outcome.reason });
      else if (outcome.kind === 'success') {
        setView({
          kind: 'success',
          connectorId: outcome.connectorId,
          expiresAt: outcome.expiresAt,
        });
      } else if (isForbiddenError(outcome.error)) setView({ kind: 'forbidden' });
      else {
        setView({
          kind: 'failure',
          message:
            outcome.error instanceof Error && outcome.error.message
              ? outcome.error.message
              : 'L’autorisation n’a pas pu être finalisée.',
        });
      }
    });
  }, []);

  const successId = view.kind === 'success' ? view.connectorId : null;
  useEffect(() => {
    if (successId === null) return;
    const t = window.setTimeout(
      () => router.replace(`/connecteurs/${successId}`),
      REDIRECT_DELAY_MS,
    );
    return () => window.clearTimeout(t);
  }, [successId, router]);

  const Back = icons.arrowLeft;

  if (view.kind === 'forbidden') {
    return (
      <div>
        <PageHeader title="Autorisation du compte" icon="download" breadcrumb={crumbs} />
        <ForbiddenState />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Autorisation du compte" icon="download" breadcrumb={crumbs} />
      <Card>
        {view.kind === 'loading' && (
          <div
            role="status"
            aria-live="polite"
            style={{ display: 'flex', alignItems: 'center', gap: spacing.md }}
          >
            <Spin />
            <span>Finalisation de l’autorisation en cours…</span>
          </div>
        )}
        {view.kind === 'success' && (
          <Alert
            type="success"
            showIcon
            message="Compte autorisé"
            description={`L’accès en lecture seule est enregistré${
              view.expiresAt ? ` (valable jusqu’au ${formatDateTime(view.expiresAt)})` : ''
            }. Retour à la fiche du connecteur…`}
          />
        )}
        {(view.kind === 'denied' || view.kind === 'missing' || view.kind === 'failure') && (
          <>
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: spacing.lg }}
              message={
                view.kind === 'denied'
                  ? 'Autorisation refusée'
                  : view.kind === 'missing'
                    ? 'Retour d’autorisation incomplet'
                    : 'Autorisation impossible'
              }
              description={
                view.kind === 'denied'
                  ? 'L’autorisation a été refusée ou annulée : aucun accès n’a été accordé. Vous pouvez recommencer depuis la fiche du connecteur.'
                  : view.kind === 'missing'
                    ? 'Cette page doit être ouverte par le fournisseur après l’autorisation. Relancez l’autorisation depuis la fiche du connecteur.'
                    : `${view.message} Relancez l’autorisation depuis la fiche du connecteur si besoin.`
              }
            />
            <Button
              icon={<Back size={iconDefaults.size} />}
              onClick={() => router.push('/connecteurs')}
            >
              Retour aux connecteurs
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
