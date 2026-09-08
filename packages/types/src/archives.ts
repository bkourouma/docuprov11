// Docu-Archives — énumérations & constantes métier partagées (api / worker / web).
// Miroir TS des états stockés en base sous forme de `smallint` + CHECK (pas d'enum Prisma) :
// cf. packages/db/prisma/models/archives.prisma et la migration 20260731120000_add_docu_archives.
// Réf. : docs/DOCUMENTATION_MENUS_DOCU_ARCHIVES.md.

/**
 * État documentaire (source `DocumentStates`). Stocké dans `document.document_state`.
 *
 * Cohabite avec `is_archived` / `is_frozen`, qui restent la vérité de l'acquisition, de la QA et
 * de la recherche : seule l'épuration (écran « DUA Expirés ») écrit ici, en posant `Epure`.
 */
export const DocumentState = {
  NonArchive: 0,
  Archive: 1,
  Restreint: 2,
  /** « Épuré » : DUA arrivée à échéance et traitée. Source : `Deleted`. */
  Epure: 3,
  VideoCodage: 4,
} as const;
export type DocumentState = (typeof DocumentState)[keyof typeof DocumentState];

export const DOCUMENT_STATE_LABELS: Record<DocumentState, string> = {
  [DocumentState.NonArchive]: 'Non archivé',
  [DocumentState.Archive]: 'Archivé',
  [DocumentState.Restreint]: 'Restreint',
  [DocumentState.Epure]: 'Épuré',
  [DocumentState.VideoCodage]: 'Vidéo-codage',
};

/**
 * Type de saisie d'une métadonnée (source `DataType`). Stocké dans `metadata.data_type`.
 * À `Liste`, les valeurs proposées viennent de `metadata_list_item`.
 */
export const MetaDataType = {
  Aucun: 0,
  Texte: 1,
  Entier: 2,
  Date: 3,
  TexteLong: 4,
  Booleen: 5,
  Liste: 6,
} as const;
export type MetaDataType = (typeof MetaDataType)[keyof typeof MetaDataType];

export const METADATA_TYPE_LABELS: Record<MetaDataType, string> = {
  [MetaDataType.Aucun]: 'Non défini',
  [MetaDataType.Texte]: 'Texte',
  [MetaDataType.Entier]: 'Nombre entier',
  [MetaDataType.Date]: 'Date',
  [MetaDataType.TexteLong]: 'Texte long',
  [MetaDataType.Booleen]: 'Oui / Non',
  [MetaDataType.Liste]: 'Liste de valeurs',
};

/** Options prêtes à l'emploi pour les `<Select>` du paramétrage des métadonnées. */
export const METADATA_TYPE_OPTIONS: Array<{ value: MetaDataType; label: string }> = (
  Object.values(MetaDataType) as MetaDataType[]
)
  .filter((v) => v !== MetaDataType.Aucun)
  .map((v) => ({ value: v, label: METADATA_TYPE_LABELS[v] }));
