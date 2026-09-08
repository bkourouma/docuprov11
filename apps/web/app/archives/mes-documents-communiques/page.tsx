'use client';

import { LendingListPage } from '../../components/archives/LendingListPage';
import { lendingsApi } from '../../lib/archives';

/**
 * Même écran que « Documents communiqués », restreint aux prêts dont l'utilisateur connecté est
 * le bénéficiaire. Le filtrage est fait par le serveur à partir du jeton.
 */
export default function MesDocumentsCommuniquesPage() {
  return (
    <LendingListPage
      icon="users"
      title="Mes documents communiqués"
      canReturn
      // Écran opérationnel comme « Documents communiqués » : même densité production.
      density="production"
      // Le bénéficiaire, ici, c'est toujours l'utilisateur connecté.
      hideBeneficiary
      fetch={lendingsApi.mine}
    />
  );
}
