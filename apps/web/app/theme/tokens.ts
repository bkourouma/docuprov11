/**
 * Tokens du design system « Plus Admin » (relook 002 — specs/002-relook/design-tokens.md).
 *
 * Source de vérité unique : couleurs (clair + sombre), rayons, échelle
 * typographique et durées de mouvement. Le thème Ant Design (antdTheme.ts)
 * et les feuilles CSS sur-mesure se construisent à partir d'ici.
 *
 * Règles d'or (PRD relook.md §4.1/§4.2) :
 * - les sémantiques VIVES (`*Vivid`) ne portent JAMAIS de texte : pastilles,
 *   icônes, remplissages, bordures uniquement. Tout texte d'état et tout fond
 *   de badge à texte blanc passe par les dérivés AA (`success`, `warning`,
 *   `danger`, `info`, `secondaryStrong`) — ratios calculés dans design-tokens.md §3 ;
 * - petits rayons nets (2-5 px) partout, pilules et cercles en contraste ;
 * - le bleu roi `#0033c4` de la top bar est CONSTANT entre les deux thèmes.
 */

/** Palette mode clair. */
export const colors = {
  // Primaire « Bleu roi » Plus Admin : actions, liens, top bar, états actifs.
  primary: '#0033c4', // 9,25:1 sur blanc
  primaryHover: '#1a55e3',
  primaryActive: '#00279a', // état pressé
  primarySoft: '#e8eefc', // remplissage discret (survol nav, sélection)

  // Fond de l'item de menu actif (sidebar) et de la catégorie active (intercalaires).
  menuActiveBg: '#1a55e3', // blanc dessus : 6,08:1

  bgLayout: '#f8f9fb',
  bgContainer: '#ffffff',
  bgElevated: '#ffffff',
  bgSpotlight: '#313131',

  border: '#e4e9f0', // cartes (décoratif)
  borderSecondary: '#eef1f6',
  borderControl: '#8d95a5', // champs de saisie — 3,01:1 sur blanc (WCAG 1.4.11)

  text: '#030303',
  textStrong: '#313131', // titres de carte
  textSecondary: '#687480', // 4,53:1 sur #f8f9fb
  textTertiary: '#8f99a5',
  textQuaternary: '#b6bdc6',
  sidebarLabel: '#141212', // libellés de menu niveau 1

  // Sémantiques FORTES (AA) : texte d'état + fonds de badge à texte blanc.
  success: '#008453', // 4,75:1 sur blanc
  successSoft: '#e0f7ec',
  warning: '#dd2a00', // 4,77:1
  warningSoft: '#ffeae4',
  danger: '#e50047', // 4,75:1
  dangerSoft: '#ffe4ec',
  info: '#007e95', // cyan Plus Admin assombri — 4,75:1
  infoSoft: '#dff5fa',
  secondary: '#a0a0a0',
  secondaryStrong: '#737373', // 4,74:1

  // Sémantiques VIVES Plus Admin — surfaces sans texte uniquement.
  successVivid: '#00d284',
  infoVivid: '#00cff4',
  warningVivid: '#ff5730',
  dangerVivid: '#ff0854',

  // En-têtes de table (fond du thead).
  theadBg: '#f8f9fb',

  // Panneau de marque (login, bandeaux héros) — dégradé signature cyan → bleu roi.
  // Le texte se pose toujours sur la moitié bleue (le cyan seul est trop clair).
  brandBgFrom: '#00cff4',
  brandBgTo: '#0033c4',
  onBrand: '#ffffff',
  onBrandMuted: '#c9d7ff',

  // Îlot top bar — constant entre les thèmes (marqueur n°1 Plus Admin).
  topbarBg: '#0033c4',
  onTopbar: '#ffffff',
  onTopbarMuted: '#ffffff',
} as const;

/** Palette mode sombre (overrides ; le darkAlgorithm d'AntD fait le reste). */
export const colorsDark = {
  primary: '#5a85ff', // 4,53:1 sur #252529 — le #0033c4 est réservé à la top bar
  primaryHover: '#7a9cff',
  primaryActive: '#4a6fe0',
  primarySoft: '#2c3247',

  menuActiveBg: '#1a55e3', // conservé — texte blanc 6,08:1

  bgLayout: '#111115',
  bgContainer: '#252529',
  bgElevated: '#33333a', // popups — l'ombre est invisible en sombre, la surface se distingue
  bgSpotlight: '#eaeef6',

  border: '#111115', // « carte fondue » Plus Admin
  borderSecondary: '#2f2f36',
  borderControl: '#70708a', // 3,18:1 sur #252529

  text: '#dee2e6',
  textStrong: '#dee2e6',
  textSecondary: '#8e94a9', // 5,06:1 sur #252529
  textTertiary: '#757a8c',
  textQuaternary: '#52566a',
  sidebarLabel: '#8e94a9', // le #6a6b83 du template échoue (2,94:1)

  success: '#00d284', // les vifs passent l'AA en sombre (7,67:1)
  successSoft: '#0c2a1e',
  warning: '#ff5730', // 4,84:1
  warningSoft: '#2f1a13',
  danger: '#ff3d78', // dérivé — le #ff0854 échoue sur carte sombre
  dangerSoft: '#2f141c',
  info: '#00cff4', // 8,17:1
  infoSoft: '#0c2a30',
  secondary: '#a0a0a0',
  secondaryStrong: '#a0a0a0', // 5,4:1 sur #252529 — le vif suffit en sombre

  successVivid: '#00d284',
  infoVivid: '#00cff4',
  warningVivid: '#ff5730',
  dangerVivid: '#ff0854',

  theadBg: '#1e1e20',

  brandBgFrom: '#00829a',
  brandBgTo: '#00279a',
  onBrand: '#ffffff',
  onBrandMuted: '#c9d7ff',

  topbarBg: '#0033c4',
  onTopbar: '#ffffff',
  onTopbarMuted: '#b9c0d4', // 5,09:1 sur #0033c4
} as const;

export type ColorScheme = Record<keyof typeof colors, string>;

/**
 * Rayons (px) — grille Plus Admin (PRD §4.2, exhaustive) :
 * champs 2 · cartes 3 · boutons/badges 4 · modales/dropdowns/tooltips 5 · pilule.
 * Aucun composant ne s'en écarte hors dérogations §4.6.
 */
export const radii = {
  xs: 2, // champs de saisie (toutes tailles)
  sm: 3, // cartes
  base: 4, // boutons, badges, base globale
  lg: 5, // modales, dropdowns, popovers, tooltips
  /**
   * Rayons adoucis, décidés le 2026-09-08 par le propriétaire du produit : les 2 px de la
   * grille §4.2 paraissaient trop secs sur des champs de 46 px, et les 3 px des cartes trop
   * durs autour d'eux. `card` reste au-dessus de `field` pour que le conteneur enveloppe
   * visuellement ses champs ; les boutons suivent `field` (un bouton à 4 px collé à un champ
   * à 8 px se voit), et les bandeaux `Alert` suivent `card` (ce sont des blocs de page).
   *
   * Appliqués **globalement** dans `antdTheme.ts` — toute l'application, pas une page.
   * Les autres rayons de la grille §4.2 (badges 4, modales/popups 5, pilules, cercles) sont
   * inchangés.
   */
  field: 8,
  card: 12,
  pill: 999,
} as const;

/** Échelle d'espacement (base 4px). */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Échelle typographique (px). Dominante Plus Admin : 14. */
export const fontSize = {
  xs: 12, // boutons (graisse 600)
  sm: 13, // champs de saisie
  base: 14, // corps, tables, labels
  md: 16, // titre de carte (graisse 700)
  lg: 20,
  xl: 24,
  xxl: 32,
} as const;

/**
 * Familles typographiques. Open Sans partout (300/400/600/700) — la variable
 * `--font-sans` est posée par next/font dans layout.tsx ; `--font-display` est
 * conservée comme ALIAS d'Open Sans (globals.css) pour ne toucher aucun
 * consommateur `.da-display`. Geist Mono seule survivante (cotes, n° pièce).
 */
export const fonts = {
  sans: "var(--font-sans), 'Open Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  display: "var(--font-display), var(--font-sans), 'Open Sans', system-ui, sans-serif",
  mono: "var(--font-geist-mono), 'SFMono-Regular', ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
} as const;

/**
 * Mouvement — durées (s) et courbes. « Moins, mais juste. » (conservé tel quel,
 * PRD §6.8). Respecte prefers-reduced-motion via <MotionConfig reducedMotion="user">.
 */
export const motion = {
  duration: {
    micro: 0.14, // micro-interactions (hover/press)
    standard: 0.22, // transitions standard
    enter: 0.32, // entrées d'écran / listes
  },
  ease: {
    out: [0.16, 1, 0.3, 1] as [number, number, number, number], // ease-out cubique
    inOut: [0.65, 0, 0.35, 1] as [number, number, number, number],
  },
  spring: { type: 'spring', stiffness: 300, damping: 30 } as const,
  stagger: 0.045, // décalage subtil entre items d'une liste
} as const;

/**
 * Ombres — Plus Admin est un design PLAT : les cartes n'ont AUCUNE ombre
 * (bordure 1px), seules les surfaces flottantes en portent une.
 */
export const shadows = {
  card: 'none',
  raised: '0 1px 15px 1px rgba(230, 234, 236, 0.35)', // douce, rares éléments flottants clairs
  popover: '0 3px 21px rgba(0, 0, 0, 0.2)',
  modal: '0 3px 21px rgba(0, 0, 0, 0.25)',
} as const;

/**
 * Palette « tuiles » (StatTile) — re-basée Plus Admin (design-tokens.md §10).
 * Réservée aux tuiles de synthèse ; ne remplace jamais les couleurs sémantiques.
 * Aucune teinte ne réutilise le danger `#ff0854` pour éviter la confusion.
 */
export type TileTone = 'ink' | 'sky' | 'violet' | 'coral';
export interface TileStyle {
  from: string;
  to: string;
  fg: string;
  fgMuted: string;
}

export const tiles: Record<TileTone, TileStyle> = {
  // Bleu roi profond (marque) — tuile "hero".
  ink: { from: '#0033c4', to: '#001f77', fg: '#FFFFFF', fgMuted: '#c9d7ff' },
  // Bleu pâle — fond clair, texte foncé (tuile "douce").
  sky: { from: '#e8eefc', to: '#d4e0fa', fg: '#0033c4', fgMuted: '#3d5aa8' },
  // Violet Plus Admin — distinct du primaire.
  violet: { from: '#6a008a', to: '#4a0061', fg: '#FFFFFF', fgMuted: '#e6c3f2' },
  // Orange chaud — distinct du danger #ff0854, purement décoratif.
  coral: { from: '#ff5730', to: '#c93a1a', fg: '#FFFFFF', fgMuted: '#ffd9cd' },
};

export const tilesDark: Record<TileTone, TileStyle> = {
  ink: { from: '#1a55e3', to: '#001f77', fg: '#eaf1fb', fgMuted: '#9fb7e8' },
  sky: { from: '#2c3247', to: '#1e2333', fg: '#c9d7ff', fgMuted: '#8fa3d9' },
  violet: { from: '#4a0061', to: '#2e003d', fg: '#f0d9fa', fgMuted: '#c98fe0' },
  coral: { from: '#b3401f', to: '#7a2a12', fg: '#ffe4da', fgMuted: '#f0a98c' },
};

/**
 * Tuiles « de statut » — calées sur les sémantiques FORTES AA (texte blanc conforme).
 */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info';

export const statusTiles: Record<StatusTone, TileStyle> = {
  success: { from: '#008453', to: '#00522f', fg: '#FFFFFF', fgMuted: '#bfe9d4' },
  warning: { from: '#dd2a00', to: '#8f1b00', fg: '#FFFFFF', fgMuted: '#ffd0c2' },
  danger: { from: '#e50047', to: '#8f002c', fg: '#FFFFFF', fgMuted: '#ffc4d6' },
  info: { from: '#0033c4', to: '#001f77', fg: '#FFFFFF', fgMuted: '#c9d7ff' },
};

export const statusTilesDark: Record<StatusTone, TileStyle> = {
  success: { from: '#00663f', to: '#003d26', fg: '#dff3e9', fgMuted: '#66cfa4' },
  warning: { from: '#a82000', to: '#5e1200', fg: '#ffe4dc', fgMuted: '#ff9c7d' },
  danger: { from: '#ad0036', to: '#5e001d', fg: '#ffdae6', fgMuted: '#ff7da6' },
  info: { from: '#1a55e3', to: '#001f77', fg: '#eaf1fb', fgMuted: '#9fb7e8' },
};
