'use client';

import { useEffect, useRef } from 'react';

/**
 * Protège les modifications non enregistrées :
 * - fermeture / rechargement de l'onglet : `beforeunload` (confirmation du navigateur) ;
 * - clic sur un lien interne (menu latéral, fil d'Ariane) : on intercepte le clic en phase de capture,
 *   on demande confirmation via `confirmLeave`, puis on navigue nous-mêmes.
 * Le routeur de Next.js (App Router) n'offre pas de garde de navigation native : l'interception de lien
 * couvre les cas courants, le retour arrière du navigateur reste couvert par `beforeunload` seulement.
 */
export function useLeaveGuard(
  dirty: boolean,
  confirmLeave: () => Promise<boolean>,
  navigate: (href: string) => void,
): void {
  const confirmRef = useRef(confirmLeave);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    confirmRef.current = confirmLeave;
    navigateRef.current = navigate;
  });

  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      if (target.target && target.target !== '_self') return;
      if (target.hasAttribute('download')) return;
      const url = new URL(target.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Même page (ancre, même chemin et même requête) : rien à protéger.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      void confirmRef.current().then((ok) => {
        if (ok) navigateRef.current(`${url.pathname}${url.search}${url.hash}`);
      });
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);
}
