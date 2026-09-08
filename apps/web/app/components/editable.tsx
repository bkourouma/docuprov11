'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Input, Select, TreeSelect, Typography } from 'antd';
import { icons } from '../theme/icons';
import { radii } from '../theme/tokens';

/**
 * Cellules « cliquer pour modifier » partagées par les pages de référentiels
 * (auparavant dupliquées dans chaque page admin).
 *
 * Affordance : curseur main + crayon primaire au survol ET au focus clavier
 * (la cellule est un vrai bouton : role/tabIndex, activation Entrée/Espace,
 * anneau de focus global de globals.css).
 * Validation : Entrée/blur. Champ requis vidé → restauré. Champ optionnel vidé
 * → enregistre la valeur vide. Retour visuel : flash bref après sauvegarde.
 */

const Pencil = icons['edit'];

export interface TreeOption {
  value: number;
  title: string;
  children?: TreeOption[];
}

function Display({
  children,
  onClick,
  mono,
}: {
  children: ReactNode;
  onClick: () => void;
  mono?: boolean;
}) {
  // Révélation du crayon au clavier : la souris est déjà couverte par
  // `.da-editable:hover` (globals.css), qui force l'opacité en !important.
  const [keyboardFocus, setKeyboardFocus] = useState(false);

  return (
    <span
      className={`da-editable${mono ? ' da-mono' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        // Espace ferait défiler la page : on consomme l'événement.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      // Pas de crayon sur un focus pris à la souris : seul le focus VISIBLE compte.
      onFocus={(e) => setKeyboardFocus(e.currentTarget.matches(':focus-visible'))}
      onBlur={() => setKeyboardFocus(false)}
      title="Cliquer pour modifier"
      style={{
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 24,
        minWidth: 80,
      }}
    >
      <span>{children}</span>
      <span
        className="da-editable-pen"
        aria-hidden
        style={{
          display: 'inline-flex',
          opacity: keyboardFocus ? 1 : 0,
          color: 'var(--ant-color-primary)',
        }}
      >
        <Pencil size={13} strokeWidth={1.75} />
      </span>
    </span>
  );
}

const Dash = <Typography.Text type="secondary">—</Typography.Text>;

export function EditableText({
  value,
  required,
  mono,
  onSave,
}: {
  value: string | null;
  required?: boolean;
  mono?: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState(false);
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => setDraft(value ?? ''), [value]);

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (required && !next) {
      setDraft(value ?? '');
      return;
    }
    if (next !== (value ?? '')) {
      await onSave(next);
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
    }
  };

  if (editing) {
    return (
      <Input
        autoFocus
        size="small"
        value={draft}
        status={required && !draft.trim() ? 'error' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={() => void commit()}
        onBlur={() => void commit()}
      />
    );
  }

  return (
    <span
      style={
        flash
          ? {
              borderRadius: radii.base,
              transition: 'background 1.2s',
              background: 'var(--ant-color-primary-bg)',
            }
          : undefined
      }
    >
      <Display onClick={() => setEditing(true)} mono={mono}>
        {value || Dash}
      </Display>
    </span>
  );
}

export function EditableSelect({
  currentId,
  currentLabel,
  options,
  onSave,
}: {
  currentId: number | null;
  currentLabel: string;
  options: { value: number; label: string }[];
  onSave: (v: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(true);

  if (!editing) {
    return (
      <Display
        onClick={() => {
          setOpen(true);
          setEditing(true);
        }}
      >
        {currentLabel || Dash}
      </Display>
    );
  }

  return (
    <Select
      autoFocus
      open={open}
      style={{ minWidth: 180 }}
      size="small"
      defaultValue={currentId ?? undefined}
      options={options}
      showSearch
      optionFilterProp="label"
      placeholder="Sélectionner"
      onChange={(v) => {
        setEditing(false);
        void onSave((v as number | undefined) ?? null);
      }}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setEditing(false);
      }}
    />
  );
}

export function EditableLocation({
  currentId,
  currentLabel,
  options,
  onSave,
}: {
  currentId: number | null;
  currentLabel: string;
  options: TreeOption[];
  onSave: (v: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(true);

  if (!editing) {
    return (
      <Display
        onClick={() => {
          setOpen(true);
          setEditing(true);
        }}
      >
        {currentLabel || Dash}
      </Display>
    );
  }

  return (
    <TreeSelect
      autoFocus
      open={open}
      style={{ minWidth: 220 }}
      size="small"
      defaultValue={currentId ?? undefined}
      treeData={options}
      showSearch
      treeNodeFilterProp="title"
      placeholder="Sélectionner"
      onChange={(v) => {
        setEditing(false);
        void onSave((v as number | undefined) ?? null);
      }}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setEditing(false);
      }}
    />
  );
}
