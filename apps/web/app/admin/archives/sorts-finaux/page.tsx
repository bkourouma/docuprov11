'use client';

import { BulkRefPage } from '../../../components/archives/BulkRefPage';
import { finalFatesApi, type FinalFateRow } from '../../../lib/archives';

/** Référentiel des sorts finaux d'un document arrivé au terme de sa durée de conservation. */
export default function FinalFatesPage() {
  return (
    <BulkRefPage<FinalFateRow>
      icon="archive"
      title="Sorts finaux"
      tableTitle="Sorts enregistrés"
      // Saisie UNITAIRE : le titre du formulaire suit au singulier (le patron le reconstruit sur
      // `itemNoun` pour les écrans qui ne l'ont pas encore aligné).
      formTitle="Nouveau sort final"
      itemSingular="ce sort final"
      itemPlural="sorts finaux"
      itemNoun="sort final"
      placeholder="Ex. Destruction"
      idOf={(r) => r.finalFateId}
      labelOf={(r) => r.label}
      api={finalFatesApi}
      singleEntry
    />
  );
}
