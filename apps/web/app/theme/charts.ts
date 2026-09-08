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

// --- Thème des graphiques, dérivé du design system « Plus Admin » (relook 002) ---

/**
 * Palette catégorielle compatible daltonisme (rouge/vert non adjacents).
 * Palette étendue Plus Admin, corrigée par thème pour rester ≥ 3:1 sur la
 * surface de carte (ratios calculés dans specs/002-relook/design-tokens.md §7 :
 * en clair, orange/jaune/vert/sarcelle/cyan/rouge sont des dérivés assombris ;
 * en sombre, bleu/indigo/violet sont éclaircis).
 */
const CATEGORICAL_LIGHT = [
  '#0033c4', // bleu roi (primaire)
  '#de7c11', // orange (dérivé de #f2a654)
  '#37a94e', // vert (dérivé de #46c35f)
  '#2da3b1', // cyan (dérivé de #57c7d4)
  '#e91e63', // rose
  '#6a008a', // violet
  '#a39608', // jaune (dérivé de #f6e84e)
  '#687480', // gris
];
const CATEGORICAL_DARK = [
  '#5a85ff', // bleu (primaire sombre)
  '#f2a654', // orange
  '#46c35f', // vert
  '#57c7d4', // cyan
  '#e91e63', // rose
  '#8743f5', // indigo (dérivé de #6610f2)
  '#f6e84e', // jaune
  '#8e94a9', // gris
];

export interface ChartTheme {
  isDark: boolean;
  palette: string[];
  /** Couleur des séries principales (encre/teal). */
  primary: string;
  /** Couleur de texte des axes/légendes. */
  label: string;
  /** Couleur des lignes de grille. */
  grid: string;
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
      primary: isDark ? '#5a85ff' : '#0033c4',
      // Texte des axes/légendes en quasi-noir en mode clair (pas de gris, cf. demande dashboards).
      label: isDark ? '#dee2e6' : '#1f1f1f',
      grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,51,196,0.06)',
      animate: !reduced,
    };
  }, [mode]);
}
