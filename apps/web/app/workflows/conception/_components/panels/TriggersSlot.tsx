'use client';

import { useEffect, useState } from 'react';
import { Tag } from 'antd';
import type { WfTriggerDto } from '@archivage/types';
import { workflowsApi } from '../../../../lib/workflows-api';
import { formatDateTime } from '../../../_lib/format';

export interface TriggersSlotProps {
  definitionId: number;
  /** Source des déclencheurs, injectable pour les tests. Par défaut : l'API W3. */
  loader?: (definitionId: number) => Promise<WfTriggerDto[] | null>;
}

/** Liste en lecture seule ; retourne null s'il n'y a rien à montrer. */
export function TriggersView({ triggers }: { triggers: WfTriggerDto[] | null | undefined }) {
  if (!triggers || triggers.length === 0) return null;
  return (
    <section className="wfp-section" aria-labelledby="wfp-triggers-title">
      <h3 id="wfp-triggers-title" className="wfp-title">
        Déclencheurs
      </h3>
      <ul className="wfp-triggers">
        {triggers.map((t) => (
          <li key={t.wfTriggerId} className="wfp-trigger">
            <div className="wfp-trigger-head">
              <strong>{t.name}</strong>
              <Tag>{t.isActive ? 'Actif' : 'Inactif'}</Tag>
            </div>
            <div className="wfp-hint">Événement : {t.eventType}</div>
            <div className="wfp-hint">
              Dernière activation : {t.lastFiredAt ? formatDateTime(t.lastFiredAt) : 'jamais'}
            </div>
            <div className="wfp-hint">Exécuté en tant que utilisateur n° {t.runAsUserGroupId}</div>
          </li>
        ))}
      </ul>
      <p className="wfp-hint">La gestion des déclencheurs arrivera prochainement.</p>
    </section>
  );
}

/** Emplacement W3 : invisible tant que l'API des déclencheurs n'existe pas ou ne renvoie rien. */
export function TriggersSlot({ definitionId, loader = workflowsApi.listTriggers }: TriggersSlotProps) {
  const [triggers, setTriggers] = useState<WfTriggerDto[] | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTriggers(undefined);
    setFailed(false);
    loader(definitionId).then(
      (list) => {
        if (!cancelled) setTriggers(list);
      },
      () => {
        // Erreur autre que 404/403 : discrète, jamais bloquante.
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [definitionId, loader]);

  if (failed) return <p className="wf-muted">Les déclencheurs ne sont pas disponibles pour le moment.</p>;
  return <TriggersView triggers={triggers} />;
}
