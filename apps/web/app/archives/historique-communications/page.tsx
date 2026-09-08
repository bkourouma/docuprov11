'use client';

import { LendingListPage } from '../../components/archives/LendingListPage';
import { lendingsApi } from '../../lib/archives';

/**
 * Prêts terminés. Consultation seule : le retour a déjà eu lieu, il n'y a plus rien à y faire —
 * d'où l'absence du bouton « Retour » présent sur les deux écrans opérationnels.
 */
export default function HistoriqueCommunicationsPage() {
  return (
    <LendingListPage
      // L'horloge « pending » annonçait une attente sur un écran où tout est clos ; la map
      // d'icônes n'a pas d'entrée « historique », `validated` dit le fait accompli.
      icon="validated"
      title="Historique des documents communiqués"
      canReturn={false}
      // Registre clos, consulté ponctuellement : densité consultation (plan §5.3).
      density="consultation"
      fetch={lendingsApi.history}
    />
  );
}
