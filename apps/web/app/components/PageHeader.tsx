'use client';

import type { ReactNode } from 'react';
import { Breadcrumb, Grid, Typography } from 'antd';
import Link from 'next/link';
import { motion } from 'motion/react';
import { fadeUp } from '../theme/motion';
import type { IconName } from '../theme/icons';
import { fontSize } from '../theme/tokens';

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * En-tête de page standard, utilisé sur toutes les pages pour la cohérence :
 * fil d'Ariane optionnel, titre (display), actions à droite. Les actions passent
 * sous le titre en mobile.
 *
 * Le titre porte seul l'en-tête : la pastille d'icône qui le précédait a été retirée. La
 * prop `icon` reste acceptée (une soixantaine de pages la passent) mais n'est plus rendue —
 * l'icône de l'écran vit dans la navigation, pas à côté de son nom.
 *
 * Pas de sous-titre : les descriptions grises sous les titres d'écran ont été retirées de
 * toute l'application (2026-09-08). Ne pas réintroduire de prop `description` ici.
 */
export function PageHeader({
  title,
  breadcrumb,
  actions,
}: {
  title: string;
  /** Conservée pour compatibilité ; n'est plus rendue. */
  icon?: IconName;
  breadcrumb?: Crumb[];
  actions?: ReactNode;
}) {
  const screens = Grid.useBreakpoint();
  const stacked = !screens.sm;

  return (
    <motion.header variants={fadeUp} initial="hidden" animate="show" style={{ marginBottom: 20 }}>
      {breadcrumb && breadcrumb.length > 0 && (
        <Breadcrumb
          style={{ marginBottom: 10, fontSize: fontSize.sm }}
          items={breadcrumb.map((c) => ({
            title: c.href ? <Link href={c.href}>{c.label}</Link> : c.label,
          }))}
        />
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: stacked ? 'column' : 'row',
          // Centré dans une rangée de 36 px (la hauteur d'un bouton) : le titre garde la même
          // assise qu'il y ait des actions à droite ou non.
          alignItems: stacked ? 'stretch' : 'center',
          minHeight: stacked ? undefined : 36,
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          {/* Titre d'écran : Archivo étroit et gras (`.da-display`), 30 px — 24 px quand les
              actions passent dessous, pour qu'un titre long ne prenne pas trois lignes. */}
          <Typography.Title
            level={1}
            className="da-display"
            style={{
              margin: 0,
              fontSize: stacked ? fontSize.xl : fontSize.xxl,
              fontWeight: 700,
              lineHeight: 1.1,
              textWrap: 'balance',
            }}
          >
            {title}
          </Typography.Title>
        </div>
        {actions && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
              flex: 'none',
            }}
          >
            {actions}
          </div>
        )}
      </div>
    </motion.header>
  );
}
