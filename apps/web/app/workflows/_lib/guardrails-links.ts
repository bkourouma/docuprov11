// Docu-Flow — liens vers les écrans des garde-fous des agents. Fonctions pures, sans React.
// Ces chemins sont FIGÉS : plusieurs écrans les utilisent (explications de problèmes, éditeur, navigation).

const isId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;

/** Écran « Outils autorisés » d'un workflow (administration) ; `null` si l'identifiant n'est pas un entier positif. */
export function toolGrantsHref(definitionId: number): string | null {
  return isId(definitionId) ? `/workflows/conception/${definitionId}/outils` : null;
}

/**
 * Écran d'évaluation d'un workflow (conception), éventuellement centré sur une étape agent (`?etape=<clé>`) ;
 * `null` si l'identifiant n'est pas un entier positif. Une clé d'étape vide est ignorée.
 */
export function evaluationHref(definitionId: number, stepKey?: string): string | null {
  if (!isId(definitionId)) return null;
  const base = `/workflows/conception/${definitionId}/evaluation`;
  return typeof stepKey === 'string' && stepKey !== '' ? `${base}?etape=${encodeURIComponent(stepKey)}` : base;
}

/** Écran « Plafonds et arrêt d'urgence » (administration). */
export function budgetHref(): string {
  return '/workflows/administration/plafonds';
}
