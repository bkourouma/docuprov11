'use client';

import { LendingListPage } from '../../components/archives/LendingListPage';
import { lendingsApi } from '../../lib/archives';

/** Prêts en cours, tous bénéficiaires confondus, avec enregistrement du retour. */
export default function DocumentsCommuniquesPage() {
  return (
    <LendingListPage
      icon="view"
      title="Documents communiqués"
      canReturn
      // File de travail balayée en volume : densité production.
      density="production"
      fetch={lendingsApi.out}
    />
  );
}
