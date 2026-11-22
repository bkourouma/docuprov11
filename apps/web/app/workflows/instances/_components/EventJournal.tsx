'use client';

import { useMemo, useState } from 'react';
import { Radio, Switch } from 'antd';
import { WF_AUTONOMY_LEVEL_LABELS, type WfEventLogDto } from '@archivage/types';
import { icons, iconDefaults } from '../../../theme/icons';
import { asText, formatConfidence, formatDateTime } from '../../_lib/format';
import {
  EVENT_FAMILIES,
  describeEvent,
  filterEvents,
  orderEvents,
  readDecisionSummary,
  type EventFamilyFilter,
} from '../../_lib/instances-logic';

/**
 * Journal lisible : une ligne = QUI / QUOI / QUAND, plus les détails présents (confiance, valideur, autonomie,
 * modèle, explication, étape). Tout est rendu en texte brut (React échappe) ; aucun JSON n'est affiché.
 */
export function EventJournal({ events }: { events: WfEventLogDto[] }) {
  const [family, setFamily] = useState<EventFamilyFilter>('all');
  const [newestFirst, setNewestFirst] = useState(false);

  const shown = useMemo(() => orderEvents(filterEvents(events, family), newestFirst), [events, family, newestFirst]);
  const Sparkle = icons.sparkle;
  const Cog = icons.settings;

  return (
    <div>
      <div className="wfi-filters">
        <Radio.Group
          aria-label="Filtrer le journal par famille d’événements"
          optionType="button"
          buttonStyle="solid"
          value={family}
          onChange={(e) => setFamily(e.target.value as EventFamilyFilter)}
          options={EVENT_FAMILIES.map((f) => ({ value: f.key, label: f.label }))}
        />
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <Switch checked={newestFirst} onChange={setNewestFirst} />
          Plus récent d’abord
        </label>
      </div>

      <p className="wf-muted" aria-live="polite">
        {shown.length} événement{shown.length > 1 ? 's' : ''} affiché{shown.length > 1 ? 's' : ''} sur {events.length}.
      </p>

      {shown.length === 0 ? (
        <p className="wf-muted">Aucun événement dans cette famille.</p>
      ) : (
        <ol className="wfi-journal" aria-label="Journal des événements">
          {shown.map((e) => {
            const d = describeEvent(e);
            const confidence = formatConfidence(e.confidence);
            const explanation = asText(e.explanation);
            const model = asText(e.model);
            const decisionLines = readDecisionSummary(e.decision);
            const isAgent = e.actorKind === 2;
            const details: Array<[string, string]> = [];
            if (e.stepKey) details.push(['Étape', e.stepKey]);
            if (confidence) details.push(['Confiance', confidence]);
            if (e.autonomyLevel !== null && e.autonomyLevel !== undefined) {
              details.push(['Autonomie', WF_AUTONOMY_LEVEL_LABELS[e.autonomyLevel] ?? `Niveau ${e.autonomyLevel}`]);
            }
            if (model) details.push(['Modèle', model]);
            for (const line of decisionLines) details.push(['Décision', line]);
            return (
              <li key={e.wfEventLogId} className={`wfi-event wfi-event-${d.tone}`}>
                <div className="wfi-event-line">
                  <span className="wfi-event-who">
                    {isAgent ? (
                      <Sparkle size={14} strokeWidth={iconDefaults.strokeWidth} aria-hidden="true" />
                    ) : e.actorKind === 0 ? (
                      <Cog size={14} strokeWidth={iconDefaults.strokeWidth} aria-hidden="true" />
                    ) : null}
                    {d.who}
                  </span>
                  <span>{d.what}</span>
                  <time className="wfi-event-time" dateTime={e.occurredAt}>
                    {formatDateTime(e.occurredAt)}
                  </time>
                </div>
                {e.validatedBy !== null && (
                  <p className="wfi-event-details" style={{ margin: 0 }}>
                    <span>
                      Validé par Utilisateur n° {e.validatedBy}
                      {e.validatedAt ? (
                        <>
                          {' '}
                          le <time dateTime={e.validatedAt}>{formatDateTime(e.validatedAt)}</time>
                        </>
                      ) : null}
                    </span>
                  </p>
                )}
                {details.length > 0 && (
                  <dl className="wfi-event-details">
                    {details.map(([k, v], i) => (
                      <div key={`${k}-${i}`}>
                        <dt>{k} :</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {explanation && (
                  <p className="wfi-explanation">
                    <strong>{isAgent ? 'Explication de la proposition : ' : 'Explication : '}</strong>
                    {explanation}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
