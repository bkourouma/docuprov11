'use client';

import { useEffect, useState } from 'react';
import { getMe, type Me } from '../../lib/auth';
import { computeWorkflowAccess, type WfAccess } from './access';

/** Charge `/auth/me` une fois et en déduit les droits d'affichage (`access` nul tant que non chargé). */
export function useWorkflowAccess(): { me: Me | null; access: WfAccess | null; loading: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    getMe()
      .then((m) => {
        if (alive) setMe(m);
      })
      .catch(() => undefined) // sans profil : aucun droit d'affichage (le serveur reste juge)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { me, access: loading ? null : computeWorkflowAccess(me), loading };
}
