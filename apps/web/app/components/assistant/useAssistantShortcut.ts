'use client';
// Raccourci global d'ouverture du panneau (Alt+Maj+A) : actif seulement si l'utilisateur détient le menu.
import { useEffect } from 'react';
import { isAssistantShortcut } from './_lib/composer-logic';

export function useAssistantShortcut(enabled: boolean, toggle: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      // Touche maintenue : une seule bascule (sinon le panneau clignote).
      if (e.isComposing || e.repeat) return;
      if (isAssistantShortcut(e)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, toggle]);
}
