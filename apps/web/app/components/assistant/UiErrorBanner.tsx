'use client';

// Bandeau d'erreur de l'assistant. Message rendu en TEXTE (échappé par React). Présentationnel : aucun appel réseau.
import { Button } from 'antd';
import type { UiError } from './_lib/ui-error';

export interface UiErrorBannerProps {
  error: UiError;
  onRetry?: () => void;
  retryLabel?: string;
}

export function UiErrorBanner({ error, onRetry, retryLabel = 'Réessayer' }: UiErrorBannerProps) {
  // Informations (limite de débit, brique non branchée) : annonce polie ; le reste : alerte.
  const polite = error.kind === 'rate_limited' || error.kind === 'not_implemented';
  const showRetry = typeof onRetry === 'function' && error.retryable;
  const wait =
    typeof error.retryAfterSeconds === 'number' && error.retryAfterSeconds > 0
      ? Math.ceil(error.retryAfterSeconds)
      : null;
  return (
    <div className={`asst-banner asst-banner--${error.kind}`} role={polite ? 'status' : 'alert'}>
      <p className="asst-banner-text">{error.message}</p>
      {wait !== null && <p className="asst-banner-wait">Réessayez dans {wait} s.</p>}
      {showRetry && (
        <Button className="asst-btn" htmlType="button" onClick={() => onRetry?.()}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
