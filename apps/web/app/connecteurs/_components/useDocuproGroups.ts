'use client';

import { useEffect, useMemo, useState } from 'react';
import { lookups } from '../../lib/archives';

export interface GroupOptions {
  /** Liste chargée (false : échec ou chargement en cours -> saisie numérique de repli). */
  loaded: boolean;
  options: { value: number; label: string }[];
  /** Libellé d'un groupe, ou « Groupe n° N » si inconnu. */
  labelOf: (id: number) => string;
}

/**
 * Groupes DocuPro (`app_user_group`, identifiant `user_group_id`) : lookup « acteurs » déjà exposé à
 * tout utilisateur authentifié et employé par les écrans de prêt et de courriers. Aucun endpoint à créer.
 */
export function useDocuproGroups(enabled = true): GroupOptions {
  const [rows, setRows] = useState<{ userGroupId: number; label: string }[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void lookups
      .actors()
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch(() => {
        if (alive) setRows(null);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  return useMemo(() => {
    const options = (rows ?? []).map((r) => ({ value: r.userGroupId, label: r.label }));
    const names = new Map(options.map((o) => [o.value, o.label]));
    return {
      loaded: rows !== null,
      options,
      labelOf: (id: number) => names.get(id) ?? `Groupe n° ${id}`,
    };
  }, [rows]);
}
