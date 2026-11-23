/**
 * Aides GED (T4) : gouvernance des documents (`/gouvernance`, API `/governance`).
 *
 * Sans IA ni document archivé préparé, aucune proposition n'existe : les tests portent sur le
 * tableau de bord, les filtres, l'analyse de numéros inexistants (rien n'est mis en file) et les
 * refus. Les libellés viennent de `@archivage/types` (ged-governance.ts) et des composants.
 */

export const GOVERNANCE_KINDS = [
  { kind: 'duplicate_exact', label: 'Doublon exact' },
  { kind: 'duplicate_near', label: 'Quasi-doublon' },
  { kind: 'pii', label: 'Données personnelles' },
  { kind: 'sensitivity', label: 'Sensibilité' },
] as const;

export const GOVERNANCE_FORBIDDEN_TEXT =
  'Accès refusé. Votre rôle ne donne pas accès à la gouvernance des documents. Demandez l’accès à un administrateur.';

export const GOVERNANCE_EMPTY_FILTERED = 'Aucune proposition ne correspond à ces filtres.';

/** Message affiché par la modale d'analyse sur un 404 (après correctif ANO-GED-T4-2). */
export const ANALYZE_DOCUMENT_NOT_FOUND =
  'Ce document est introuvable, n’est pas archivé ou ne vous est pas accessible.';

export interface GovernanceDashboard {
  aiEnabled: boolean;
  aiMessage: string | null;
  byKind: Record<string, { proposee: number; validee: number; rejetee: number; total: number }>;
  totals: { proposee: number; validee: number; rejetee: number; total: number };
  openDuplicateGroups: number;
  generatedAt: string;
}

export interface GovernancePage {
  items: unknown[];
  total: number;
  page: number;
  pageSize: number;
}
