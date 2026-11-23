'use client';

import { useMemo } from 'react';
import { useThemeMode } from '../components/Providers';

// --- Formatage fr-FR (UTC → affichage local côté texte) ---

const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** Entier avec séparateurs de milliers (espaces fines fr-FR). */
export function fmtInt(n: number | null | undefined): string {
  return nf0.format(Math.round(n ?? 0));
}

/** Pourcentage fr-FR à partir d'un ratio 0..1. */
export function fmtPct(ratio: number | null | undefined, digits = 0): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'percent',
    maximumFractionDigits: digits,
  }).format(ratio ?? 0);
}

/** Octets → o / Ko / Mo / Go / To, base 1024, fr-FR. */
export function fmtBytes(bytes: number | null | undefined): string {
  const b = bytes ?? 0;
  if (b <= 0) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1);
  const v = b / Math.pow(1024, i);
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)} ${units[i]}`;
}

/** 'YYYY-MM-DD' → 'JJ/MM/AAAA'. Renvoie l'entrée telle quelle si non datée. */
export function fmtDateFr(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso ?? '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// --- Thème des graphiques, dérivé du design system « Registre » ---

/**
 * Palette catégorielle, dans un ORDRE FIXE (la couleur suit l'entité, jamais son rang).
 * Validée par calcul, en clair sur le papier blanc et en sombre sur la carte sombre :
 * séparation daltonisme entre voisines, plancher de chroma, contraste >= 3:1 sur la surface.
 * Le rouge n'y figure pas : il est réservé au retard et à l'erreur (rouge de marge).
 */
const CATEGORICAL_LIGHT = [
  '#17855E', // vert (série principale)
  '#2a78d6', // bleu
  '#e0752d', // orange
  '#6250d6', // violet
  '#a8672f', // brun
  '#1aa3a3', // sarcelle
  '#b98500', // ambre
  '#d0609a', // magenta
];
const CATEGORICAL_DARK = [
  '#199e70', // vert
  '#3987e5', // bleu
  '#d95926', // orange
  '#9085e9', // violet
  '#b0703c', // brun
  '#1aa3a3', // sarcelle
  '#c98500', // ambre
  '#d55181', // magenta
];

export interface ChartTheme {
  isDark: boolean;
  palette: string[];
  /** Couleur des séries principales (vert de série). */
  primary: string;
  /** Couleur de texte des axes/légendes. */
  label: string;
  /** Couleur des lignes de grille. */
  grid: string;
  /** Famille de police résolue (Archivo) : le canevas des graphiques ne lit pas `var(--font-sans)`. */
  fontFamily: string;
  /** false si l'utilisateur a demandé une réduction du mouvement. */
  animate: boolean;
}

/** Thème de graphique réactif au mode clair/sombre et à prefers-reduced-motion. */
export function useChartTheme(): ChartTheme {
  const { mode } = useThemeMode();
  return useMemo(() => {
    const isDark = mode === 'dark';
    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return {
      isDark,
      palette: isDark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT,
      primary: isDark ? '#199e70' : '#17855E',
      // Texte des axes/légendes en quasi-noir en mode clair (pas de gris, cf. demande dashboards).
      label: isDark ? '#E3EAE6' : '#12201B',
      grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(18,32,27,0.08)',
      fontFamily:
        typeof document !== 'undefined'
          ? getComputedStyle(document.body).fontFamily
          : 'system-ui, sans-serif',
      animate: !reduced,
    };
  }, [mode]);
}
