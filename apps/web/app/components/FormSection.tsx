'use client';

import type { ReactNode } from 'react';
import { Divider, Typography } from 'antd';
import { icons, iconDefaults, type IconName } from '../theme/icons';
import { colors, fontSize } from '../theme/tokens';

/**
 * Section de formulaire réutilisable : titre court + description optionnelle, séparée du groupe
 * précédent par un `Divider`. Sert à découper les longs formulaires (enregistrement de courrier,
 * courrier de départ…) en groupes logiques plutôt qu'une grille de champs indifférenciée.
 *
 * L'icône optionnelle reprend le même badge coloré que `PageHeader`, pour une hiérarchie visuelle
 * cohérente entre le titre de page et les titres de section à l'intérieur.
 */
export function FormSection({
  title,
  description,
  children,
  first = false,
  icon,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Première section d'un formulaire : pas de séparateur au-dessus. */
  first?: boolean;
  icon?: IconName;
}) {
  const Glyph = icon ? icons[icon] : null;
  return (
    <div>
      {!first && <Divider style={{ marginTop: 8 }} />}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: description ? 2 : 12,
        }}
      >
        {Glyph && (
          <span
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 26,
              height: 26,
              flex: 'none',
              // Même pastille que PageHeader : cercle (§4.2) sur le primaire du thème.
              borderRadius: 'var(--da-radius-pill)',
              background: 'var(--ant-color-primary-bg)',
              color: 'var(--ant-color-primary)',
            }}
          >
            <Glyph {...iconDefaults} size={14} />
          </span>
        )}
        <Typography.Text strong>{title}</Typography.Text>
      </div>
      {description && (
        <Typography.Text
          type="secondary"
          style={{ display: 'block', fontSize: fontSize.xs, marginBottom: 12 }}
        >
          {description}
        </Typography.Text>
      )}
      {children}
    </div>
  );
}

/**
 * Étiquette « IA » accolée au libellé d'un champ que la saisie automatique vient de pré-remplir.
 * Badge plein 11 px/600 sur le dérivé AA « info » : le blanc y passe (4,75:1) dans les deux
 * thèmes, contrairement au cyan vif de la palette sombre (règle d'or §4.1).
 */
export function AiFilledTag() {
  return (
    <span
      className="da-pill"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 11,
        fontWeight: 600,
        padding: '0 6px',
        background: colors.info,
        color: 'var(--ant-color-white)',
        lineHeight: '16px',
      }}
    >
      IA
    </span>
  );
}
