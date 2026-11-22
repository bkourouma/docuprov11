'use client';

import { fontSize } from '../theme/tokens';

/**
 * Comptage en tête de liste : le nombre en chiffres étroits et gras, puis son libellé —
 * « 38 courriers ». Le nombre est le total reporté en tête du registre ; il n'a plus de
 * pastille de couleur, c'est sa graisse et sa taille qui le font lire en premier.
 */
export function CountBadge({ value, label }: { value: number | string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
      <span
        className="da-display"
        style={{ fontSize: fontSize.lg, lineHeight: 1, fontVariantNumeric: 'tabular-nums lining-nums' }}
      >
        {value}
      </span>
      <span style={{ fontWeight: 500 }}>{label}</span>
    </span>
  );
}
