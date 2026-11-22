'use client';

import { Button } from 'antd';
import { WfDefinitionVersionStatus } from '@archivage/types';
import { icons, iconDefaults } from '../../../../theme/icons';
import type { WfDefinitionVersionSummary } from '../../../../lib/workflows-api';
import { formatDateTime } from '../../../_lib/format';
import { VersionStatusTag } from './DefinitionStatusTags';

export interface VersionsPanelProps {
  versions: WfDefinitionVersionSummary[];
  /** Numéro de la version actuellement ouverte. */
  openedNumber: number;
  /** Le workflow est archivé : plus de nouveau brouillon possible. */
  definitionArchived: boolean;
  busy: boolean;
  onOpen(versionNumber: number): void;
  onCreateDraftFrom(versionNumber: number): void;
}

/** Historique des versions, plus récente d'abord. Publiée et archivée : immuables (cadenas + texte). */
export function VersionsPanel({
  versions,
  openedNumber,
  definitionArchived,
  busy,
  onOpen,
  onCreateDraftFrom,
}: VersionsPanelProps) {
  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
  const Lock = icons.lock;

  return (
    <section className="wfe-versions" aria-labelledby="wfe-versions-title">
      <h3 id="wfe-versions-title" className="wfe-section-title">
        Versions
      </h3>
      {sorted.length === 0 ? (
        <p className="wf-muted">Aucune version.</p>
      ) : (
        <ul className="wfe-version-list">
          {sorted.map((v) => {
            const isOpen = v.versionNumber === openedNumber;
            const immutable = v.status !== WfDefinitionVersionStatus.Draft;
            return (
              <li
                key={v.wfDefinitionVersionId}
                className={`wfe-version${isOpen ? ' wfe-version--open' : ''}`}
                aria-current={isOpen ? 'true' : undefined}
              >
                <div className="wfe-version-head">
                  <strong>Version n° {v.versionNumber}</strong>
                  <VersionStatusTag status={v.status} />
                  {isOpen && <span className="wfe-version-open">Ouverte</span>}
                </div>
                {immutable && (
                  <div className="wfe-version-lock">
                    <Lock {...iconDefaults} size={14} aria-hidden="true" />
                    <span>immuable</span>
                  </div>
                )}
                {v.publishedAt && <div className="wf-muted">Publiée le {formatDateTime(v.publishedAt)}</div>}
                {v.changeNote && <div className="wfe-version-note">Note : {v.changeNote}</div>}
                <div className="wfe-row-actions">
                  <Button
                    size="small"
                    disabled={isOpen || busy}
                    onClick={() => onOpen(v.versionNumber)}
                    aria-label={`Ouvrir la version n° ${v.versionNumber}`}
                  >
                    Ouvrir
                  </Button>
                  {immutable && (
                    <Button
                      size="small"
                      disabled={busy || definitionArchived}
                      onClick={() => onCreateDraftFrom(v.versionNumber)}
                      aria-label={`Créer un brouillon à partir de la version n° ${v.versionNumber}`}
                    >
                      Créer un brouillon à partir de celle-ci
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
