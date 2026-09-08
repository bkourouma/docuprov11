// Domaine PUR de la saisie des métadonnées d'un document — aucune dépendance NestJS/Prisma.
//
// Une métadonnée (`metadata`) déclare un TYPE DE SAISIE (`data_type`), mais sa valeur est stockée
// dans une colonne texte unique (`document_metadata_value.value`). Ce module est le seul endroit
// où l'on décide ce qu'« une saisie valide » veut dire pour chaque type, et sous quelle forme
// canonique elle part en base — pour que deux écrans qui saisissent « 5 000 » ou « 05/2026 »
// n'aboutissent jamais à deux représentations différentes de la même valeur.

import { MetaDataType } from '@archivage/types';

/** Ce que l'écran envoie pour un champ : une chaîne libre, ou l'élément choisi pour une Liste. */
export interface RawMetadataValue {
  metaDataId: number;
  value?: string | null;
  metaDataListItemId?: number | null;
}

/** Ce qui part en base — `null` signifiant « champ vidé », donc ligne à supprimer. */
export interface NormalizedMetadataValue {
  value: string | null;
  metaDataListItemId: number | null;
}

/** Saisie refusée : le message est destiné à l'utilisateur, préfixé du libellé du champ par l'appelant. */
export class MetadataValueError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Une date civile n'est valide que si Postgres l'accepterait : `2026-02-31` a beau respecter le
 * format, il n'existe pas. On reconstruit la date en UTC et on vérifie qu'elle n'a pas débordé
 * sur le mois suivant (même précaution qu'`addMonths` dans le domaine DUA).
 */
function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/**
 * Normalise UNE saisie selon le type de la métadonnée.
 *
 * Renvoie `null` quand le champ est vide : « absent » et « vide » ne sont pas deux états
 * distincts (cf. le CHECK de `document_metadata_value`), la ligne est alors supprimée.
 * Lève `MetadataValueError` sur une saisie non convertible — mieux vaut refuser l'indexation que
 * stocker un texte qu'aucun écran ne saura relire.
 */
export function normalizeMetadataValue(
  dataType: number,
  raw: RawMetadataValue,
): NormalizedMetadataValue | null {
  if (dataType === MetaDataType.Liste) {
    // Pour une Liste, la vérité est la clé étrangère : `value` resterait un libellé recopié,
    // qui divergerait du référentiel au premier renommage.
    return raw.metaDataListItemId == null ? null : { value: null, metaDataListItemId: raw.metaDataListItemId };
  }

  const text = (raw.value ?? '').trim();
  if (text === '') return null;

  switch (dataType) {
    case MetaDataType.Entier: {
      if (!/^-?\d+$/.test(text)) throw new MetadataValueError('nombre entier attendu');
      return { value: String(Number(text)), metaDataListItemId: null }; // « 007 » → « 7 »
    }
    case MetaDataType.Date: {
      if (!DATE_RE.test(text) || !isRealDate(text)) {
        throw new MetadataValueError('date attendue au format AAAA-MM-JJ');
      }
      return { value: text, metaDataListItemId: null };
    }
    case MetaDataType.Booleen: {
      const lower = text.toLowerCase();
      if (!['true', 'false'].includes(lower)) {
        throw new MetadataValueError('valeur attendue : true ou false');
      }
      return { value: lower, metaDataListItemId: null };
    }
    case MetaDataType.Texte:
    case MetaDataType.TexteLong:
      return { value: text, metaDataListItemId: null };
    default:
      // `Aucun` (0) ou valeur inconnue : la métadonnée n'est pas paramétrée pour être saisie.
      throw new MetadataValueError('type de saisie non défini pour cette métadonnée');
  }
}
