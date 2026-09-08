'use client';

import type { CSSProperties } from 'react';

const LOGO_SRC = '/DocuPro.png';
const LOGO_RATIO = 200 / 50; // largeur / hauteur du lockup
// Le pictogramme (pile de documents) occupe ~26 % de la largeur du lockup.
const ICON_FRACTION = 0.26;

/**
 * Logo officiel « DocuPro » (lockup complet : pictogramme + mot-symbole).
 * Fond transparent → s'affiche sur clair comme sur le panneau « Encre » sombre.
 */
export function Logo({ height = 28, style }: { height?: number; style?: CSSProperties }) {
  return (
    // `<img>` et non `next/image` : asset local de quelques kilo-octets, servi tel quel depuis
    // /public et affiché à une taille fixe — l'optimiseur n'aurait rien à optimiser, et son
    // conteneur ajouterait une couche de positionnement dont le lockup n'a pas besoin.
    <img
      src={LOGO_SRC}
      alt="DocuPro"
      width={Math.round(height * LOGO_RATIO)}
      height={height}
      style={{ height, width: 'auto', display: 'block', ...style }}
    />
  );
}

/**
 * Pictogramme seul (recadrage du lockup) — pour le rail replié, la TopBar
 * mobile et l'écran de chargement, là où le mot-symbole ne tiendrait pas.
 */
export function LogoIcon({ size = 32, style }: { size?: number; style?: CSSProperties }) {
  const cropWidth = Math.round(size * LOGO_RATIO * ICON_FRACTION);
  return (
    <span
      aria-label="DocuPro"
      role="img"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        width: cropWidth,
        height: size,
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* `<img>` obligatoire ici : le pictogramme est un RECADRAGE du lockup, obtenu en
          débordant (`maxWidth: 'none'`) d'un parent en `overflow: hidden`. Le conteneur que
          `next/image` impose contraindrait la largeur et annulerait le recadrage. */}
      <img
        src={LOGO_SRC}
        alt=""
        style={{ height: size, width: 'auto', maxWidth: 'none', display: 'block' }}
      />
    </span>
  );
}
