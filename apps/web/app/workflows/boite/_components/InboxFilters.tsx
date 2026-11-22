'use client';

import { Button, Input, Select } from 'antd';
import { icons, iconDefaults } from '../../../theme/icons';
import {
  DUE_OPTIONS,
  INBOX_STATUS_GROUPS,
  NATURE_OPTIONS,
  SORT_OPTIONS,
  type InboxDueFilter,
  type InboxFilters as Filters,
  type InboxNatureFilter,
  type InboxSort,
  type InboxStatusGroup,
} from '../../_lib/inbox-logic';

/** Barre de filtres : chaque contrôle a un libellé visible relié par `htmlFor`. */
export function InboxFilters({
  group,
  filters,
  sort,
  canReset,
  onGroup,
  onFilters,
  onSort,
  onReset,
}: {
  group: InboxStatusGroup;
  filters: Filters;
  sort: InboxSort;
  canReset: boolean;
  onGroup: (g: InboxStatusGroup) => void;
  onFilters: (f: Filters) => void;
  onSort: (s: InboxSort) => void;
  onReset: () => void;
}) {
  return (
    <div className="wf-toolbar wfb-filters" role="search" aria-label="Filtrer la boîte de tâches">
      <div className="wf-field">
        <label htmlFor="wfb-group">Statut</label>
        <Select
          id="wfb-group"
          value={group}
          onChange={(v: InboxStatusGroup) => onGroup(v)}
          options={INBOX_STATUS_GROUPS.map((g) => ({ value: g.value, label: g.label }))}
        />
      </div>
      <div className="wf-field">
        <label htmlFor="wfb-nature">Nature</label>
        <Select
          id="wfb-nature"
          value={filters.nature}
          onChange={(v: InboxNatureFilter) => onFilters({ ...filters, nature: v })}
          options={[...NATURE_OPTIONS]}
        />
      </div>
      <div className="wf-field">
        <label htmlFor="wfb-due">Échéance</label>
        <Select
          id="wfb-due"
          value={filters.due}
          onChange={(v: InboxDueFilter) => onFilters({ ...filters, due: v })}
          options={[...DUE_OPTIONS]}
        />
      </div>
      <div className="wf-field wfb-search">
        <label htmlFor="wfb-text">Recherche</label>
        <Input
          id="wfb-text"
          allowClear
          value={filters.text}
          placeholder="Titre, workflow ou étape"
          prefix={<icons.search {...iconDefaults} size={16} aria-hidden="true" />}
          onChange={(e) => onFilters({ ...filters, text: e.target.value })}
        />
      </div>
      <div className="wf-field">
        <label htmlFor="wfb-sort">Tri</label>
        <Select id="wfb-sort" value={sort} onChange={(v: InboxSort) => onSort(v)} options={[...SORT_OPTIONS]} />
      </div>
      {canReset && (
        <Button icon={<icons.reset {...iconDefaults} />} onClick={onReset}>
          Réinitialiser
        </Button>
      )}
    </div>
  );
}
