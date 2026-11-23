// État d'affichage de la liste des espaces — fonction PURE (sans React), testée à part.
//
// Un chargement en ÉCHEC n'est pas une liste vide : afficher « Aucun espace pour l'instant :
// créez-en un » après un refus (403 sans le menu « Espaces ») ou une panne affirmait une chose
// fausse et invitait à une création vouée à l'échec. L'échec a donc son propre état, prioritaire
// sur la liste vide, tant qu'aucune ligne n'a été chargée.

export type SpacesListView = 'loading' | 'error' | 'empty' | 'table';

export function spacesListView(state: {
  loading: boolean;
  rowCount: number;
  error: string | null;
}): SpacesListView {
  // Des lignes déjà affichées restent affichées pendant un rechargement ou après son échec
  // (le message d'erreur suffit alors) : on ne vide pas l'écran sous l'utilisateur.
  if (state.rowCount > 0) return 'table';
  if (state.loading) return 'loading';
  if (state.error !== null) return 'error';
  return 'empty';
}
