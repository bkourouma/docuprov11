'use client';

import { Skeleton } from 'antd';
import {
  GOVERNANCE_KIND_LABELS,
  GOVERNANCE_KINDS,
  type GovernanceDashboard,
  type GovernanceKind,
} from '@archivage/types';
import { icons } from '../../theme/icons';

/**
 * Synthèse : une carte par nature (cliquable = filtre de la liste) et une carte d'information
 * sur les groupes de doublons. Chaque carte porte un aria-label complet : les chiffres sont
 * lisibles par un lecteur d'écran, et l'état « filtre actif » est écrit, pas seulement coloré.
 */
export function SummaryCards({
  dashboard,
  loading,
  activeKind,
  onToggleKind,
}: {
  dashboard: GovernanceDashboard | null;
  loading: boolean;
  activeKind: GovernanceKind | undefined;
  onToggleKind: (kind: GovernanceKind) => void;
}) {
  const Check = icons.check;
  const Dup = icons.archive;

  if (!dashboard) {
    return (
      <div className="gov-cards" aria-busy={loading}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="gov-card gov-card-static">
            <Skeleton active paragraph={{ rows: 1 }} title={{ width: '60%' }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="gov-cards" role="group" aria-label="Synthèse des propositions">
      {GOVERNANCE_KINDS.map((kind) => {
        const c = dashboard.byKind[kind];
        const active = activeKind === kind;
        const label = GOVERNANCE_KIND_LABELS[kind];
        return (
          <button
            key={kind}
            type="button"
            className="gov-card"
            aria-pressed={active}
            aria-label={`${label} : ${c.proposee} en attente, ${c.validee} validée(s), ${c.rejetee} rejetée(s). ${
              active ? 'Filtre actif, activer pour le retirer.' : 'Activer pour filtrer la liste.'
            }`}
            onClick={() => onToggleKind(kind)}
          >
            <span className="gov-card-title">
              <span>{label}</span>
              {active && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <Check size={14} aria-hidden="true" /> Filtre actif
                </span>
              )}
            </span>
            <span className="gov-card-main" aria-hidden="true">
              {c.proposee}
              <small>en attente</small>
            </span>
            <span className="gov-card-sub" aria-hidden="true">
              <span>{c.validee} validée(s)</span>
              <span>{c.rejetee} rejetée(s)</span>
            </span>
          </button>
        );
      })}
      <div
        className="gov-card gov-card-static"
        role="group"
        aria-label={`Groupes de doublons ouverts : ${dashboard.openDuplicateGroups}`}
      >
        <span className="gov-card-title">
          <span>Groupes de doublons ouverts</span>
          <Dup size={16} aria-hidden="true" />
        </span>
        <span className="gov-card-main" aria-hidden="true">
          {dashboard.openDuplicateGroups}
          <small>groupe(s)</small>
        </span>
        <span className="gov-card-sub" aria-hidden="true">
          Un original et ses copies proposées
        </span>
      </div>
    </div>
  );
}
