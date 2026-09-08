'use client';

import type { ReactNode } from 'react';
import { Breadcrumb, Grid, Typography } from 'antd';
import Link from 'next/link';
import { motion } from 'motion/react';
import { fadeUp } from '../theme/motion';
import { icons, iconDefaults, type IconName } from '../theme/icons';
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
 * Pas de sous-titre : les descriptions grises sous les titres d'écran ont été retirées de
 * toute l'application (2026-09-08). Ne pas réintroduire de prop `description` ici.
 */
export function PageHeader({
  title,
  icon,
  breadcrumb,
  actions,
}: {
  title: string;
  icon?: IconName;
  breadcrumb?: Crumb[];
  actions?: ReactNode;
}) {
  const screens = Grid.useBreakpoint();
  const stacked = !screens.sm;
  const Glyph = icon ? icons[icon] : null;

  return (
    <motion.header variants={fadeUp} initial="hidden" animate="show" style={{ marginBottom: 24 }}>
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
          alignItems: stacked ? 'stretch' : 'flex-end',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', minWidth: 0 }}>
          {Glyph && (
            <span
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 44,
                height: 44,
                flex: 'none',
                // Pastille = cercle (grille de rondeur §4.2) ; teintes prises aux
                // variables AntD pour suivre clair/sombre sans logique JS.
                borderRadius: 'var(--da-radius-pill)',
                background: 'var(--ant-color-primary-bg)',
                color: 'var(--ant-color-primary)',
              }}
            >
              <Glyph size={22} strokeWidth={iconDefaults.strokeWidth} />
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            {/* Titre d'écran Plus Admin : 24 px / 600 — la graisse est explicite car
                `.da-display` n'est plus qu'un alias de police (plus de famille display). */}
            <Typography.Title
              level={2}
              className="da-display"
              style={{ margin: 0, fontSize: fontSize.xl, fontWeight: 600, lineHeight: 1.2 }}
            >
              {title}
            </Typography.Title>
          </div>
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
