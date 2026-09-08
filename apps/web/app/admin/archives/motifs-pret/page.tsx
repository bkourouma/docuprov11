'use client';

import { BulkRefPage } from '../../../components/archives/BulkRefPage';
import { lendingMotivesApi, type LendingMotiveRow } from '../../../lib/archives';

/** Référentiel des motifs invoqués lors d'une communication (prêt) de document. */
export default function LendingMotivesPage() {
  return (
    <BulkRefPage<LendingMotiveRow>
      icon="send"
      title="Motifs de prêt"
      tableTitle="Motifs enregistrés"
      // Saisie UNITAIRE : le titre du formulaire suit au singulier (le patron le reconstruit sur
      // `itemNoun` pour les écrans qui ne l'ont pas encore aligné).
      formTitle="Nouveau motif"
      itemSingular="ce motif"
      itemPlural="motifs"
      itemNoun="motif"
      placeholder="Ex. Consultation"
      idOf={(r) => r.lendingMotiveId}
      labelOf={(r) => r.label}
      api={lendingMotivesApi}
      singleEntry
    />
  );
}
