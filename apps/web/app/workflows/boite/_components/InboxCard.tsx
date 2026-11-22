'use client';

import type { WfInboxEntry } from '../../../lib/workflows-api';
import { icons, iconDefaults } from '../../../theme/icons';
import { DueTag, InboxStatusTag, PriorityTag } from '../../_components/StatusTags';
import { formatDateTime } from '../../_lib/format';
import { entryAriaLabel, entryDueAt, isOpenEntry, isOverdue } from '../../_lib/inbox-logic';
import { NatureTag } from './NatureTag';

/**
 * Carte d'un élément : UN seul contrôle interactif (le bouton) dont le nom accessible est complet.
 * Un retard est dit par le texte « En retard de … » et l'icône, en plus de la bordure et du fond.
 */
export function InboxCard({
  entry,
  now,
  selected,
  onOpen,
  registerRef,
}: {
  entry: WfInboxEntry;
  now: Date;
  selected: boolean;
  onOpen: (entry: WfInboxEntry) => void;
  registerRef: (id: string, el: HTMLButtonElement | null) => void;
}) {
  const { item, task } = entry;
  const late = isOverdue(entry, now);
  const due = entryDueAt(entry);
  const open = isOpenEntry(entry);

  return (
    <li className="wfb-item">
      <button
        type="button"
        ref={(el) => registerRef(item.wfInboxItemId, el)}
        className={`wfb-card${late ? ' wfb-card--overdue' : ''}${selected ? ' wfb-card--selected' : ''}`}
        aria-label={entryAriaLabel(entry, now)}
        aria-haspopup="dialog"
        onClick={() => onOpen(entry)}
      >
        <span className="wfb-card-title">{item.title}</span>
        <span className="wfb-card-sub">
          {entry.definitionName} · étape {task.stepKey}
        </span>
        <span className="wfb-card-tags" aria-hidden="true">
          <NatureTag kind={item.kind} />
          <InboxStatusTag status={item.status} />
          <PriorityTag priority={item.priority} />
          {open ? (
            <span className={late ? 'wfb-late' : undefined}>
              {late && <icons.alert {...iconDefaults} size={14} aria-hidden="true" />}
              <DueTag dueAt={due} now={now} />
            </span>
          ) : (
            <span className="wf-muted">{due ? `Échéance : ${formatDateTime(due)}` : 'Sans échéance'}</span>
          )}
        </span>
      </button>
    </li>
  );
}
