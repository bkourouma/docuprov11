'use client';

import { useEffect, useState } from 'react';
import { Button, Checkbox, Input } from 'antd';
import { validateFieldKey, type ConfigListItem } from '../../../_lib/step-config';

export interface ConfigListEditorProps {
  /** Titre du bloc (« Champs du formulaire », « Éléments de la checklist »). */
  title: string;
  /** Préfixe des clés générées à l'ajout (`champ`, `element`). */
  keyPrefix: string;
  addLabel: string;
  items: ConfigListItem[];
  readOnly: boolean;
  onChange(next: ConfigListItem[]): void;
}

/** Éditeur de liste {clé, libellé, obligatoire} : ajout, suppression, déplacement, clés uniques. */
export function ConfigListEditor({ title, keyPrefix, addLabel, items, readOnly, onChange }: ConfigListEditorProps) {
  const replace = (index: number, patch: Partial<ConfigListItem>) =>
    onChange(items.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    onChange(next);
  };

  const add = () => {
    const used = new Set(items.map((i) => i.key));
    let n = items.length + 1;
    while (used.has(`${keyPrefix}_${n}`)) n++;
    onChange([...items, { key: `${keyPrefix}_${n}`, required: false }]);
  };

  return (
    <fieldset className="wfp-section" disabled={readOnly} aria-disabled={readOnly || undefined}>
      <legend className="wfp-legend">{title}</legend>
      {items.length === 0 ? <div className="wfp-hint">Aucun élément pour le moment.</div> : null}
      <ol className="wfp-list">
        {items.map((item, index) => (
          <ListRow
            key={`${index}:${item.key}`}
            item={item}
            index={index}
            count={items.length}
            others={items.filter((_, i) => i !== index).map((i) => i.key)}
            readOnly={readOnly}
            onPatch={(patch) => replace(index, patch)}
            onMove={(d) => move(index, d)}
            onRemove={() => onChange(items.filter((_, i) => i !== index))}
          />
        ))}
      </ol>
      <Button onClick={add} disabled={readOnly}>
        {addLabel}
      </Button>
    </fieldset>
  );
}

interface RowProps {
  item: ConfigListItem;
  index: number;
  count: number;
  others: string[];
  readOnly: boolean;
  onPatch(patch: Partial<ConfigListItem>): void;
  onMove(delta: -1 | 1): void;
  onRemove(): void;
}

function ListRow({ item, index, count, others, readOnly, onPatch, onMove, onRemove }: RowProps) {
  // Saisie de la clé en cours : validée à la sortie du champ, jamais écrite tant qu'elle est refusée.
  const [draftKey, setDraftKey] = useState(item.key);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftKey(item.key);
    setError(null);
  }, [item.key]);

  const commitKey = () => {
    if (draftKey === item.key) return setError(null);
    const message = validateFieldKey(draftKey, others);
    setError(message);
    if (message === null) onPatch({ key: draftKey });
  };

  const num = index + 1;
  const errId = `wfp-row-${index}-err`;
  return (
    <li className="wfp-row">
      <div className="wfp-row-fields">
        <Input
          aria-label={`Clé de l'élément ${num}`}
          aria-invalid={error !== null || undefined}
          aria-describedby={error ? errId : undefined}
          status={error ? 'error' : undefined}
          value={draftKey}
          maxLength={100}
          disabled={readOnly}
          onChange={(e) => setDraftKey(e.target.value)}
          onBlur={commitKey}
          onPressEnter={commitKey}
        />
        <Input
          aria-label={`Libellé de l'élément ${num}`}
          placeholder="Libellé affiché"
          value={item.label ?? ''}
          maxLength={200}
          disabled={readOnly}
          onChange={(e) => onPatch({ label: e.target.value })}
        />
        <Checkbox
          checked={item.required}
          disabled={readOnly}
          onChange={(e) => onPatch({ required: e.target.checked })}
        >
          Obligatoire
        </Checkbox>
      </div>
      <div className="wfp-row-actions">
        <Button size="small" aria-label={`Monter l'élément ${num}`} disabled={readOnly || index === 0} onClick={() => onMove(-1)}>
          Monter
        </Button>
        <Button
          size="small"
          aria-label={`Descendre l'élément ${num}`}
          disabled={readOnly || index === count - 1}
          onClick={() => onMove(1)}
        >
          Descendre
        </Button>
        <Button size="small" danger aria-label={`Supprimer l'élément ${num}`} disabled={readOnly} onClick={onRemove}>
          Supprimer
        </Button>
      </div>
      {error ? (
        <div id={errId} className="wfp-error" role="alert">
          {error}
        </div>
      ) : null}
    </li>
  );
}
