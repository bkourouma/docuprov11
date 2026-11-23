'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, Input, Typography } from 'antd';
import { NAV } from './nav';
import { icons } from '../theme/icons';
import { radii } from '../theme/tokens';

interface Command {
  key: string;
  label: string;
  section: string;
  icon: keyof typeof icons;
  keywords: string[];
  /** Permissions alternatives ouvrant la même entrée (cf. `NavItem.altKeys`). */
  altKeys?: string[];
}

const COMMANDS: Command[] = NAV.flatMap((s) =>
  s.items.map((i) => ({
    key: i.key,
    label: i.label,
    section: s.label,
    icon: i.icon,
    keywords: [i.label.toLowerCase(), ...(i.keywords ?? [])],
    altKeys: i.altKeys,
  })),
);

// Actions clés (mêmes routes, mais formulées en verbe d'action pour la palette).
const ACTIONS: Command[] = [
  {
    key: '/acquisition',
    label: 'Démarrer un nouveau lot',
    section: 'Actions',
    icon: 'add',
    keywords: ['nouveau', 'lot', 'acquisition'],
  },
  {
    key: '/intercalaires',
    label: 'Générer des intercalaires',
    section: 'Actions',
    icon: 'qr',
    keywords: ['générer', 'qr', 'imprimer'],
  },
  {
    key: '/search',
    label: 'Rechercher des documents',
    section: 'Actions',
    icon: 'search',
    keywords: ['chercher', 'recherche'],
  },
];

const ALL = [...ACTIONS, ...COMMANDS];

function score(cmd: Command, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return cmd.label.toLowerCase().includes(needle) || cmd.keywords.some((k) => k.includes(needle));
}

/**
 * Palette de commandes (⌘K / Ctrl+K) : navigation rapide + actions clés.
 * Composant contrôlé : l'AppShell gère l'état d'ouverture et le raccourci global.
 */
export function CommandPalette({
  open,
  onClose,
  allowedKeys = null,
}: {
  open: boolean;
  onClose: () => void;
  /** Clés de menu autorisées (null = pas de filtrage). L'accueil reste toujours accessible. */
  allowedKeys?: string[] | null;
}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<React.ComponentRef<typeof Input>>(null);

  const results = useMemo(() => {
    const allowed = allowedKeys ? new Set(allowedKeys) : null;
    return ALL.filter(
      (c) =>
        (!allowed ||
          c.key === '/dashboards' ||
          allowed.has(c.key) ||
          c.altKeys?.some((k) => allowed.has(k))) &&
        score(c, q),
    );
  }, [q, allowedKeys]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      // focus après l'ouverture de la modale
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  useEffect(() => setActive(0), [q]);

  // Suivi clavier : l'option active reste visible quand la sélection descend
  // au-delà de la zone visible de la liste (a11y, PRD relook §6.9).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (cmd?: Command) => {
    const target = cmd ?? results[active];
    if (!target) return;
    onClose();
    router.push(target.key);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose();
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={560}
      style={{ top: 96 }}
      styles={{ body: { padding: 0 }, content: { padding: 0, overflow: 'hidden' } }}
      destroyOnHidden
    >
      <div
        style={{
          padding: 12,
          borderBottom: '1px solid var(--ant-color-border-secondary, #d9e2ea)',
        }}
      >
        <Input
          ref={inputRef}
          variant="borderless"
          placeholder="Rechercher une page ou une action…"
          prefix={(() => {
            const S = icons['search'];
            return (
              <S size={18} strokeWidth={1.75} style={{ color: 'var(--ant-color-text-tertiary)' }} />
            );
          })()}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        ref={listRef}
        style={{ maxHeight: 360, overflow: 'auto', padding: 6 }}
        role="listbox"
        aria-label="Commandes"
      >
        {results.length === 0 && (
          <div style={{ padding: '28px 16px', textAlign: 'center' }}>
            <Typography.Text type="secondary">Aucune commande pour « {q} »</Typography.Text>
          </div>
        )}
        {results.map((cmd, i) => {
          const Glyph = icons[cmd.icon];
          const isActive = i === active;
          return (
            <button
              key={`${cmd.section}-${cmd.key}-${cmd.label}`}
              role="option"
              aria-selected={isActive}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(cmd)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                border: 'none',
                borderRadius: radii.field,
                cursor: 'pointer',
                textAlign: 'left',
                background: isActive ? 'var(--ant-color-primary-bg, #e3efe7)' : 'transparent',
                color: isActive
                  ? 'var(--ant-color-primary, #0e3b2e)'
                  : 'var(--ant-color-text, #12201b)',
              }}
            >
              <Glyph size={18} strokeWidth={1.75} />
              <span style={{ flex: 1 }}>{cmd.label}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {cmd.section}
              </Typography.Text>
            </button>
          );
        })}
      </div>
      <div
        style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--ant-color-border-secondary, #d9e2ea)',
          display: 'flex',
          gap: 16,
          fontSize: 12,
          color: 'var(--ant-color-text-tertiary)',
        }}
      >
        <span>↑↓ naviguer</span>
        <span>↵ ouvrir</span>
        <span>Échap fermer</span>
      </div>
    </Modal>
  );
}
