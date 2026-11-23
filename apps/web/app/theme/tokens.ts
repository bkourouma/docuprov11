/**
 * Tokens du design system « Registre » (apps/web/.impeccable/surfaces — contrat de direction).
 *
 * Source de vérité unique : couleurs (clair + sombre), rayons, échelle
 * typographique et durées de mouvement. Le thème Ant Design (antdTheme.ts)
 * et les feuilles CSS sur-mesure se construisent à partir d'ici.
 *
 * Le monde : le registre du courrier à colonnes. Toile vert bouteille pour le rail et les
 * actions, papier blanc sur fond teinté de vert, réglure bleu-gris, et un rouge de marge.
 *
 * Règles d'or :
 * - le ROUGE DE MARGE (`marginRule`, `danger`) ne sert qu'à deux choses : le double filet qui
 *   borde la marge numérotée des listes, et ce qui signale un problème — retard, erreur,
 *   suppression, évolution défavorable d'un indicateur. Jamais décoratif, jamais sur une
 *   simple marque de forme (l'astérisque des champs obligatoires est à l'encre) ;
 * - les sémantiques VIVES (`*Vivid`) ne portent JAMAIS de texte : pastilles, icônes,
 *   remplissages, bordures uniquement. Tout texte d'état passe par les dérivés AA (`success`,
 *   `warning`, `danger`, `info`, `secondaryStrong`) ;
 * - coins nets (4 à 6 px), aucune ombre de carte : c'est le filet qui structure.
 */

/** Palette mode clair. */
export const colors = {
  // Primaire « toile vert bouteille » : actions, liens, rail des modules, états actifs.
  primary: '#0E3B2E', // 12,5:1 sur blanc
  primaryHover: '#17513F',
  primaryActive: '#0A2C22', // état pressé
  primarySoft: '#E3EFE7', // remplissage discret (survol, sélection de ligne)

  // Toile un cran plus claire : survol du rail, aplats secondaires. Porte toujours du blanc.
  menuActiveBg: '#17513F', // blanc dessus : 9,2:1

  // Écran courant dans le panneau de navigation : aplat vert plein, libellé blanc.
  menuSelectedBg: '#0E3B2E',
  menuSelectedColor: '#FFFFFF', // 12,5:1

  bgLayout: '#EFF4F0', // fond de page : papier teinté de vert
  bgContainer: '#FFFFFF', // le papier du registre
  bgElevated: '#FFFFFF',
  bgSpotlight: '#12201B',

  border: '#C6D3DF', // réglure bleu-gris (cartes, tableaux)
  borderSecondary: '#D9E2EA', // réglure légère (séparateurs internes)
  borderControl: '#7C9086', // champs de saisie et boutons — 3,4:1 sur blanc (WCAG 1.4.11)

  text: '#12201B', // encre
  textStrong: '#12201B',
  textSecondary: '#4D5E56', // 6,2:1 sur le fond de page
  textTertiary: '#5F6F67', // 4,8:1 sur le fond de page, 5,3:1 sur blanc
  textQuaternary: '#A9B5AE',
  sidebarLabel: '#22332C', // libellés du panneau de navigation

  // Sémantiques FORTES (AA) : texte d'état + fonds de badge à texte blanc.
  success: '#0C6641', // 7,0:1 sur blanc
  successSoft: '#DDF0E4',
  warning: '#8A5200', // 6,4:1
  warningSoft: '#FCEFD3',
  danger: '#B3261E', // 6,5:1 — même rouge que le filet de marge
  dangerSoft: '#FBE6E3',
  info: '#2B5F7C', // encre bleu-gris — 6,9:1
  infoSoft: '#E2EDF3',
  // Filets des bandeaux d'alerte (décoratifs : le texte et l'icône portent l'état).
  successBorder: '#A9D5BD',
  warningBorder: '#E8CD95',
  dangerBorder: '#EDB4AE',
  infoBorder: '#AFC9D8',
  secondary: '#93A69C',
  secondaryStrong: '#5B6B63', // 5,6:1

  // Sémantiques VIVES — surfaces sans texte uniquement.
  successVivid: '#2FA36B',
  infoVivid: '#4A90B8',
  warningVivid: '#D9902B',
  dangerVivid: '#D8473C',

  // En-têtes de table : papier blanc, c'est le filet d'encre sous l'en-tête qui le distingue.
  theadBg: '#FFFFFF',

  // Panneau de marque : aplat de toile, sans dégradé (les deux bornes sont identiques).
  brandBgFrom: '#0E3B2E',
  brandBgTo: '#0E3B2E',
  onBrand: '#FFFFFF',
  onBrandMuted: '#BDD3C9', // 7,9:1 sur la toile

  // Barre supérieure : posée sur le fond de page, séparée par un filet.
  topbarBg: '#EFF4F0',
  onTopbar: '#12201B',
  onTopbarMuted: '#4D5E56',
  topbarAvatarBg: '#0E3B2E',

  // Chrome : rail des modules (toile) et panneau des écrans (papier).
  railBg: '#0E3B2E',
  onRail: '#BDD3C9', // 7,9:1 sur la toile
  railActiveBg: '#FFFFFF',
  railActiveColor: '#0E3B2E',
  panelBg: '#F9FBF9',
  chromeEdge: '#D2DED6', // filet entre panneau, barre et page

  // Signature : la marge numérotée des listes.
  marginRule: '#B3261E', // double filet rouge
  ink: '#12201B', // filet d'encre sous les en-têtes et au-dessus des totaux
} as const;

/**
 * Palette mode sombre (overrides ; le darkAlgorithm d'AntD fait le reste).
 *
 * Le mode sombre est désactivé dans l'application (cf. `Providers`) : ces valeurs gardent la
 * forme du thème cohérente mais n'ont PAS été vérifiées à l'écran.
 */
export const colorsDark = {
  primary: '#7CC7A6', // toile éclaircie — le #0E3B2E est illisible sur fond sombre
  primaryHover: '#98D6BA',
  primaryActive: '#5FAF8D',
  primarySoft: '#1C3229',

  menuActiveBg: '#17513F',

  menuSelectedBg: '#1F5745',
  menuSelectedColor: '#FFFFFF',

  bgLayout: '#0D1512',
  bgContainer: '#16211C',
  bgElevated: '#1F2C26',
  bgSpotlight: '#E6EEE9',

  border: '#2B3A34',
  borderSecondary: '#22302A',
  borderControl: '#6E8279',

  text: '#E3EAE6',
  textStrong: '#E3EAE6',
  textSecondary: '#9FB0A7',
  textTertiary: '#7D8F86',
  textQuaternary: '#56665E',
  sidebarLabel: '#C4D2CA',

  success: '#5CC896',
  successSoft: '#143325',
  warning: '#E0A44A',
  warningSoft: '#33260F',
  danger: '#F0776C',
  dangerSoft: '#3A1917',
  info: '#7FB7D6',
  infoSoft: '#15303E',
  successBorder: '#1F5A40',
  warningBorder: '#5C4416',
  dangerBorder: '#6B2A25',
  infoBorder: '#27536B',
  secondary: '#93A69C',
  secondaryStrong: '#A9B5AE',

  successVivid: '#2FA36B',
  infoVivid: '#4A90B8',
  warningVivid: '#D9902B',
  dangerVivid: '#D8473C',

  theadBg: '#16211C',

  brandBgFrom: '#0E3B2E',
  brandBgTo: '#0E3B2E',
  onBrand: '#FFFFFF',
  onBrandMuted: '#BDD3C9',

  topbarBg: '#0D1512',
  onTopbar: '#E3EAE6',
  onTopbarMuted: '#9FB0A7',
  topbarAvatarBg: '#7CC7A6',

  railBg: '#0A2C22',
  onRail: '#BDD3C9',
  railActiveBg: '#E3EFE7',
  railActiveColor: '#0E3B2E',
  panelBg: '#111B17',
  chromeEdge: '#22302A',

  marginRule: '#F0776C',
  ink: '#E3EAE6',
} as const;

export type ColorScheme = Record<keyof typeof colors, string>;

/**
 * Rayons (px) — coins nets. Deux valeurs portent l'interface : 4 pour ce qui étiquette
 * (badges, tags), 6 pour ce qu'on manipule ou qui encadre (champs, boutons, cartes, tableaux,
 * surfaces flottantes). Pilules et cercles restent en contraste.
 */
export const radii = {
  xs: 2,
  sm: 3,
  base: 4, // badges, tags, base globale
  lg: 6, // modales, dropdowns, popovers, tooltips
  /** Champs de saisie et boutons — appliqué globalement dans `antdTheme.ts`. */
  field: 6,
  /** Cartes, tableaux, bandeaux : le papier a des coins nets. */
  card: 6,
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

/** Échelle typographique (px). Dominante : 14. */
export const fontSize = {
  xs: 12,
  sm: 13, // boutons, champs de saisie, textes d'appoint
  base: 14, // corps, tables, labels
  md: 16, // titre de carte
  lg: 20,
  xl: 24,
  xxl: 30, // titre d'écran
} as const;

/**
 * Familles typographiques. Archivo partout (famille variable, axes graisse ET largeur) : la
 * variable `--font-sans` est posée par next/font dans layout.tsx. La largeur fait la voix :
 * normale pour le texte, étroite pour les titres d'écran et les en-têtes de colonne en
 * capitales (`.da-display`, en-têtes de table dans globals.css). `--font-display` reste un
 * ALIAS de `--font-sans`. Geist Mono pour ce qui se recopie caractère par caractère
 * (empreintes, identifiants QR, cotes).
 */
export const fonts = {
  sans: "var(--font-sans), 'Archivo', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  display: "var(--font-display), var(--font-sans), 'Archivo', system-ui, sans-serif",
  mono: "var(--font-geist-mono), 'SFMono-Regular', ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
} as const;

/**
 * Mouvement — durées (s) et courbes. « Moins, mais juste. »
 * Respecte prefers-reduced-motion via <MotionConfig reducedMotion="user">.
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
 * Ombres — le registre est PLAT : les cartes n'ont AUCUNE ombre (le filet structure),
 * seules les surfaces flottantes en portent une, décalée et douce.
 */
export const shadows = {
  card: 'none',
  raised: '0 1px 2px rgba(18, 32, 27, 0.08)',
  popover: '0 8px 24px rgba(18, 32, 27, 0.16)',
  modal: '0 16px 40px rgba(18, 32, 27, 0.22)',
} as const;

/**
 * Tuiles de synthèse (StatTile) : des tuiles de PAPIER, bordées d'un filet. La teinte d'une
 * tuile n'est plus un aplat mais une pastille devant son libellé — purement décorative, elle
 * distingue les tuiles d'un bandeau entre elles. Aucune ne reprend une couleur sémantique
 * (succès, alerte, danger, info) ni le rouge de marge : une tuile décorative ne doit jamais se
 * lire comme un état. Les tuiles d'état (StatusTile) prennent, elles, les sémantiques fortes
 * via les variables AntD.
 */
export type TileTone = 'ink' | 'sky' | 'violet' | 'coral';

export const tileMarks: Record<TileTone, string> = {
  ink: '#0E3B2E', // toile
  sky: '#4F8A6F', // vert de reliure clair
  violet: '#5B4B8A', // violet d'encre
  coral: '#6B4A2E', // brun de reliure
};

export const tileMarksDark: Record<TileTone, string> = {
  ink: '#7CC7A6',
  sky: '#9FC4B3',
  violet: '#A79BD6',
  coral: '#C9A27C',
};

/** Tons des tuiles d'état (StatusTile). */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info';
