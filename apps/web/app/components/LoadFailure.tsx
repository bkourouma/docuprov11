'use client';

import { useState } from 'react';
import { Button } from 'antd';
import { EmptyState } from './EmptyState';

/**
 * État d'échec de lecture d'un écran : dit que la lecture a échoué (jamais « vide » ou « 0 »)
 * et propose de réessayer. `onRetry` peut rendre une promesse : le bouton tourne pendant
 * l'attente. Un seul composant pour tous les écrans, hors listes de courriers et référentiels
 * (qui passent par `MailWorklist` et `RefLayout`).
 */
export function LoadFailure({
  title = 'Le chargement a échoué',
  onRetry,
  compact = false,
}: {
  title?: string;
  onRetry: () => void | Promise<void>;
  compact?: boolean;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  return (
    <EmptyState
      icon="alert"
      compact={compact}
      title={title}
      action={
        <Button loading={retrying} onClick={() => void retry()}>
          Réessayer
        </Button>
      }
    />
  );
}
