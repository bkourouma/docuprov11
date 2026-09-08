'use client';

import { Skeleton } from 'antd';
import { radii } from '../theme/tokens';

/**
 * Squelettes qui épousent la forme du contenu (pas de spinner générique).
 * Évite le layout shift au chargement.
 *
 * Toutes les teintes viennent des variables AntD (cssVar) : filets de lignes sur
 * `border-secondary` comme les tables, contour de carte sur `border` (#e4e9f0).
 */

/**
 * Squelette de tableau : en-tête + N lignes.
 *
 * `minmax(0, 1fr)` et non `1fr` : le minimum implicite d'une piste `1fr` est `auto`, donc la
 * largeur minimale de son contenu. Or `Skeleton.Button` porte un `min-width` imposé par AntD
 * (`controlHeightSM × 2` = 56 px) : les pistes refusaient de descendre sous 56 px et la grille
 * devenait irréductible à N × 56 + gouttières. Mesuré à 360 px pendant le chargement, avant
 * correction : 7 colonnes (files courrier) donnaient `56px` × 7 et une page de 537 px de large,
 * soit 177 px de débordement — sur le TOUT PREMIER écran affiché, celui du chargement.
 * Le `minWidth: 0` posé sur chaque `Skeleton.Button` lève le plancher côté enfant.
 */
export function TableSkeleton({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div style={{ width: '100%' }} aria-busy="true" aria-label="Chargement…">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: 16,
          padding: '12px 8px',
          borderBottom: '1px solid var(--ant-color-border-secondary)',
        }}
      >
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton.Button
            key={i}
            active
            size="small"
            style={{ width: '60%', height: 14, minWidth: 0 }}
            block={false}
          />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: 16,
            padding: '14px 8px',
            borderBottom: '1px solid var(--ant-color-border-secondary)',
          }}
        >
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton.Button
              key={c}
              active
              size="small"
              style={{ width: c === 0 ? '85%' : '50%', height: 16, minWidth: 0 }}
              block={false}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Squelette de grille de cartes. */
export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 16,
      }}
      aria-busy="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            // Carte plate : même bordure et même rayon que les vraies cartes.
            border: '1px solid var(--ant-color-border)',
            borderRadius: radii.card,
            padding: 20,
            background: 'var(--ant-color-bg-container)',
          }}
        >
          <Skeleton active paragraph={{ rows: 2 }} />
        </div>
      ))}
    </div>
  );
}
