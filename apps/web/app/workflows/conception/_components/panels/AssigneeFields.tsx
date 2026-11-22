'use client';

import { useEffect, useState } from 'react';
import { InputNumber, Select } from 'antd';
import type { WfStep } from '@archivage/types';
import { directoryApi } from '../../../../lib/workflows-api';
import { PanelField } from './PanelField';

type Assignee = WfStep['assignee'];
type AssigneeKind = NonNullable<Assignee>['kind'];

export interface AssigneeFieldsProps {
  value: Assignee;
  readOnly: boolean;
  onChange(next: Assignee): void;
  /** Types proposés (par défaut : tous). L'escalade se limite à user/group/role. */
  kinds?: readonly AssigneeKind[];
  /** Propose « Aucune affectation prévue » (par défaut oui). */
  allowNone?: boolean;
}

const KIND_LABELS: Record<AssigneeKind, string> = {
  initiator: 'Le lanceur',
  subject_owner: "Le propriétaire de l'objet lié",
  user: 'Un utilisateur',
  group: 'Un groupe',
  role: 'Un rôle',
};
const ALL_KINDS: readonly AssigneeKind[] = ['initiator', 'subject_owner', 'user', 'group', 'role'];
const NONE = '__none__';

interface DirectoryOption {
  id: number;
  name: string;
}
/** undefined = pas encore chargé ; null = liste indisponible (droits insuffisants) ; tableau = chargé. */
type DirectoryState = DirectoryOption[] | null | undefined;

const needsId = (kind: AssigneeKind | undefined) => kind === 'user' || kind === 'group' || kind === 'role';

export function AssigneeFields({ value, readOnly, onChange, kinds = ALL_KINDS, allowNone = true }: AssigneeFieldsProps) {
  const kind = value?.kind;
  const [groups, setGroups] = useState<DirectoryState>(undefined);
  const [roles, setRoles] = useState<DirectoryState>(undefined);

  // Chargement unique de la liste utile (groupes ou rôles), au premier besoin.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (kind === 'group' && groups === undefined) {
          const list = await directoryApi.groups();
          if (!cancelled) setGroups(list ? list.map((g) => ({ id: g.groupId, name: g.name })) : null);
        }
        if (kind === 'role' && roles === undefined) {
          const list = await directoryApi.roles();
          if (!cancelled) setRoles(list ? list.map((r) => ({ id: r.roleId, name: r.name })) : null);
        }
      } catch {
        // Annuaire indisponible : repli sur la saisie numérique, sans bloquer l'édition.
        if (!cancelled) {
          if (kind === 'group') setGroups(null);
          if (kind === 'role') setRoles(null);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [kind, groups, roles]);

  const directory: DirectoryState = kind === 'group' ? groups : kind === 'role' ? roles : undefined;
  const typeOptions = [
    ...(allowNone ? [{ value: NONE, label: 'Aucune affectation prévue' }] : []),
    ...kinds.map((k) => ({ value: k, label: KIND_LABELS[k] })),
  ];

  const missingId = needsId(kind) && value?.id === undefined;

  return (
    <div className="wfp-group" aria-disabled={readOnly || undefined}>
      <PanelField
        label="Affectation"
        hint={
          kind === undefined
            ? "Sans affectation, la tâche ira à la personne qui a lancé le workflow."
            : kind === 'subject_owner'
              ? "À défaut de propriétaire connu, la tâche ira au lanceur."
              : undefined
        }
      >
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            style={{ width: '100%' }}
            value={kind ?? NONE}
            disabled={readOnly}
            options={typeOptions}
            onChange={(next: string) => {
              if (next === NONE) onChange(undefined);
              // Les types sans identifiant n'émettent jamais `id` ; les autres attendent la saisie de l'identifiant.
              else onChange({ kind: next as AssigneeKind });
            }}
          />
        )}
      </PanelField>

      {needsId(kind) ? (
        <PanelField
          label={kind === 'group' ? 'Groupe' : kind === 'role' ? 'Rôle' : "Numéro d'utilisateur"}
          hint={
            kind === 'user' || directory === null
              ? "Numéro d'utilisateur (user_group_id) fourni par l'administration."
              : undefined
          }
          error={missingId ? 'Renseignez la cible pour que l’affectation soit enregistrée.' : null}
        >
          {({ controlId, describedBy }) =>
            kind !== 'user' && Array.isArray(directory) ? (
              <Select
                id={controlId}
                aria-describedby={describedBy}
                style={{ width: '100%' }}
                showSearch
                optionFilterProp="label"
                placeholder="Choisir dans la liste"
                value={value?.id}
                disabled={readOnly}
                options={withUnknown(directory, value?.id)}
                onChange={(id: number) => onChange({ kind: kind as AssigneeKind, id })}
              />
            ) : (
              <InputNumber
                id={controlId}
                aria-describedby={describedBy}
                style={{ width: '100%' }}
                min={1}
                precision={0}
                value={value?.id ?? null}
                disabled={readOnly || (kind !== 'user' && directory === undefined)}
                placeholder={kind !== 'user' && directory === undefined ? 'Chargement…' : 'Numéro'}
                onChange={(v) => {
                  if (!kind) return;
                  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) onChange({ kind, id: v });
                  else onChange({ kind });
                }}
              />
            )
          }
        </PanelField>
      ) : null}
    </div>
  );
}

/** Garde visible un identifiant absent de l'annuaire (groupe désactivé, par exemple). */
function withUnknown(list: DirectoryOption[], id: number | undefined) {
  const options = list.map((o) => ({ value: o.id, label: o.name }));
  if (id !== undefined && !list.some((o) => o.id === id)) options.unshift({ value: id, label: `Numéro ${id} (introuvable)` });
  return options;
}
