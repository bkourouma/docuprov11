'use client';

import { BulkRefPage } from '../../../components/archives/BulkRefPage';
import { destructionModesApi, type DestructionModeRow } from '../../../lib/archives';

/** Référentiel des modes de destruction appliqués en fin de cycle de vie. */
export default function DestructionModesPage() {
  return (
    <BulkRefPage<DestructionModeRow>
      icon="delete"
      title="Modes de destruction"
      tableTitle="Modes enregistrés"
      // Saisie UNITAIRE : le titre du formulaire suit au singulier (le patron le reconstruit sur
      // `itemNoun` pour les écrans qui ne l'ont pas encore aligné).
      formTitle="Nouveau mode de destruction"
      itemSingular="ce mode de destruction"
      itemPlural="modes de destruction"
      itemNoun="mode de destruction"
      placeholder="Ex. Broyage"
      idOf={(r) => r.destructionModeId}
      labelOf={(r) => r.label}
      api={destructionModesApi}
      singleEntry
    />
  );
}
