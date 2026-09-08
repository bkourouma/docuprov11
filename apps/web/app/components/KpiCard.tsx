'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Card, Skeleton, Tooltip, Typography } from 'antd';
import { icons, iconDefaults, type IconName } from '../theme/icons';
import { fmtInt, fmtPct } from '../theme/charts';
import { fontSize, motion } from '../theme/tokens';

/**
 * Tuile de chiffre clé. Le dépôt n'utilise `Statistic` d'AntD nulle part : les nombres y sont
 * composés à la main en `da-mono` (Geist Mono, chiffres tabulaires). On garde cette convention et
 * on la factorise ici, plutôt que de la réécrire dans chaque zone du tableau de bord.
 *
 * `href` rend la tuile cliquable : un compteur qui signale un problème sans permettre d'agir
 * n'est qu'un rapport. Toutes les tuiles de files pointent vers leur écran.
 */
export type KpiTone = 'default' | 'danger' | 'warning' | 'success';

const COULEURS: Record<KpiTone, string | undefined> = {
  default: undefined,
  danger: 'var(--ant-color-error)',
  warning: 'var(--ant-color-warning)',
  success: 'var(--ant-color-success)',
};

export interface KpiVariation {
  ratio: number | null;
  sens: 'hausse' | 'baisse' | 'stable' | 'indetermine';
}

export function KpiCard({
  label,
  value,
  suffix,
  hint,
  icon,
  tone = 'default',
  variation,
  /** `true` = une hausse est une mauvaise nouvelle (retards, backlog). */
  hausseDefavorable = false,
  href,
  loading,
  compact,
}: {
  label: string;
  value: number | string | null;
  suffix?: string;
  hint?: ReactNode;
  icon?: IconName;
  tone?: KpiTone;
  variation?: KpiVariation | null;
  hausseDefavorable?: boolean;
  href?: string;
  loading?: boolean;
  compact?: boolean;
}) {
  const couleur = COULEURS[tone];
  const affichage = value === null ? '—' : typeof value === 'number' ? fmtInt(value) : value;
  const Glyph = icon ? icons[icon] : null;
  const cliquable = Boolean(href);
  const [survolee, setSurvolee] = useState(false);

  const corps = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        {Glyph && (
          <span style={{ color: couleur ?? 'var(--ant-color-text-tertiary)', display: 'flex' }}>
            <Glyph {...iconDefaults} size={16} />
          </span>
        )}
        <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
          {label}
        </Typography.Text>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          className="da-mono"
          style={{
            fontSize: compact ? 22 : 28,
            fontWeight: 600,
            lineHeight: 1.1,
            color: couleur,
          }}
        >
          {affichage}
        </span>
        {suffix && (
          <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
            {suffix}
          </Typography.Text>
        )}
        {variation && <BadgeVariation variation={variation} defavorable={hausseDefavorable} />}
      </div>

      {hint && (
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
            {hint}
          </Typography.Text>
        </div>
      )}
    </>
  );

  return (
    // Carte PLATE : `hoverable` d'AntD porte une ombre ET efface la bordure au survol — la
    // hiérarchie du design system passe par la bordure seule, qui vire au primaire si la tuile
    // mène quelque part.
    <Card
      styles={{ body: { padding: compact ? 12 : 16 } }}
      style={{
        height: '100%',
        borderColor: cliquable && survolee ? 'var(--ant-color-primary)' : undefined,
        transition: `border-color ${motion.duration.micro}s ease`,
      }}
      onMouseEnter={cliquable ? () => setSurvolee(true) : undefined}
      onMouseLeave={cliquable ? () => setSurvolee(false) : undefined}
    >
      {loading ? (
        <Skeleton active paragraph={false} title={{ width: '70%' }} />
      ) : href ? (
        <Link href={href} style={{ display: 'block', color: 'inherit' }}>
          {corps}
        </Link>
      ) : (
        corps
      )}
    </Card>
  );
}

/**
 * Variation vs période précédente. Deux règles :
 *  - `indetermine` (précédent à 0) s'affiche « — » : passer de 0 à 12 est une apparition, pas une
 *    hausse de +1200 % ;
 *  - la couleur suit le SENS MÉTIER, pas le signe : plus de retards est une mauvaise nouvelle.
 */
function BadgeVariation({
  variation,
  defavorable,
}: {
  variation: KpiVariation;
  defavorable: boolean;
}) {
  if (variation.ratio === null || variation.sens === 'indetermine') {
    return (
      <Tooltip title="Aucune comparaison possible : la période précédente est à zéro.">
        <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
          —
        </Typography.Text>
      </Tooltip>
    );
  }

  if (variation.sens === 'stable') {
    return (
      <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
        =
      </Typography.Text>
    );
  }

  const hausse = variation.sens === 'hausse';
  const bon = hausse !== defavorable;
  return (
    <Tooltip title="Comparé à la période précédente de même durée">
      <Typography.Text
        style={{
          fontSize: fontSize.xs,
          color: bon ? 'var(--ant-color-success)' : 'var(--ant-color-error)',
        }}
      >
        {hausse ? '▲' : '▼'} {fmtPct(Math.abs(variation.ratio), 0)}
      </Typography.Text>
    </Tooltip>
  );
}
