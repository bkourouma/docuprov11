import { z } from 'zod';

/** Libellé de référentiel : obligatoire, espaces de bordure ignorés (cf. `normaliseLabel`). */
const label = z.string().trim().min(1);

/** Date civile `AAAA-MM-JJ` — les échéances et dates de prêt sont des dates, pas des instants. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');

const positiveId = z.number().int().positive();

// ---------------------------------------------------------------------------
// Référentiels plats : modes de destruction, sorts finaux, motifs de prêt (§4, §5, §6)
// ---------------------------------------------------------------------------

/** Création/renommage d'un élément de référentiel plat. */
export const refLabelSchema = z.object({ label });

/**
 * Création EN MASSE, reprise du `CreateMultipleNodes` du source : l'écran laisse saisir plusieurs
 * libellés d'un coup. Le dédoublonnage (dans le lot et vis-à-vis de l'existant) est fait par le
 * service, qui renvoie le détail de ce qui a été ignoré plutôt que d'échouer en bloc.
 */
export const refLabelsSchema = z.object({
  labels: z.array(label).min(1, 'Au moins un libellé'),
});

/** Suppression (désactivation) en masse — `DeleteNodes(ids)` du source. */
export const idsSchema = z.object({ ids: z.array(positiveId).min(1) });

// ---------------------------------------------------------------------------
// Paramétrage des types de documents (§1)
// ---------------------------------------------------------------------------

/**
 * Un paramétrage par type : `documentTypeId` identifie la ligne (upsert). Les deux axes de
 * rangement sont facultatifs — un paramétrage vide est légitime, il signifie « aucun défaut »,
 * et l'on peut n'en fixer qu'un des deux.
 */
export const documentTypeSettingSchema = z.object({
  documentTypeId: positiveId,
  dossierId: positiveId.nullable().optional(),
  planId: positiveId.nullable().optional(),
  /// Confidentialité par défaut des documents de ce type — posée à leur création, comme le dossier
  /// et le plan.
  confidentialiteId: positiveId.nullable().optional(),
  // Consigne de numérisation — documentaire : V6 ne pilote aucun scanner (cf. migration
  // 20260801170000). Le taux est un pourcentage, borné comme le CHECK de la table.
  ocr: z.boolean().optional(),
  cryptage: z.boolean().optional(),
  tauxCompression: z.number().int().min(1).max(100).nullable().optional(),
  profilScanner: z.string().trim().max(200).nullable().optional(),
  routines: z.string().trim().max(500).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Cycles de vie par type de document (§3)
// ---------------------------------------------------------------------------

/**
 * Règle de conservation d'un type. Les durées sont des MOIS (le source parlait de `Mois` pour la
 * recherche des documents à échéance) ; 0 est permis — un type sans conservation est échu d'office.
 * L'écran les saisit en années et convertit avant l'envoi (`archives.ts` côté web) : ce contrat
 * reste en mois pour ne rien changer au calcul d'échéance (`domain/dua.ts`, SQL `make_interval`).
 */
export const documentTypeLifeCycleSchema = z.object({
  documentTypeId: positiveId,
  usefulnessLifespan: z.number().int().min(0),
  complianceLifespan: z.number().int().min(0),
  finalFateId: positiveId.nullable().optional(),
  destructionModeId: positiveId.nullable().optional(),
});

/**
 * Cycle de vie propre à UN document : des DATES, qui l'emportent sur la règle de son type.
 * `documentId` identifie la ligne (upsert), comme pour le paramétrage.
 */
export const documentLifeCycleSchema = z.object({
  documentId: positiveId,
  usefulnessLifespan: isoDate,
  complianceLifespan: isoDate,
  observations: z.string().trim().max(2000).nullable().optional(),
  finalFateId: positiveId.nullable().optional(),
  destructionModeId: positiveId.nullable().optional(),
});

// ---------------------------------------------------------------------------
// Métadonnées (§7, §8, §9)
// ---------------------------------------------------------------------------

/** Type de saisie d'une métadonnée — miroir de `MetaDataType` (@archivage/types). */
const dataType = z.number().int().min(0).max(6);

export const createMetaDataSchema = z.object({ label, dataType });

export const updateMetaDataSchema = z
  .object({ label: label.optional(), dataType: dataType.optional() })
  .refine((d) => d.label !== undefined || d.dataType !== undefined, {
    message: 'Aucun champ à mettre à jour',
  });

/** Création en masse de métadonnées (`CreateMultipleMetaDatas` du source). */
export const createMetaDatasSchema = z.object({
  metaDatas: z.array(z.object({ label, dataType })).min(1),
});

/** Valeurs d'une métadonnée de type Liste — création en masse pour une même métadonnée (§9). */
export const createMetaDataListItemsSchema = z.object({
  metaDataId: positiveId,
  labels: z.array(label).min(1),
});

export const updateMetaDataListItemSchema = z
  .object({ label: label.optional(), metaDataId: positiveId.optional() })
  .refine((d) => d.label !== undefined || d.metaDataId !== undefined, {
    message: 'Aucun champ à mettre à jour',
  });

/**
 * Association métadonnées ↔ types (§7) : produit cartésien des deux listes, comme le source.
 * Les couples déjà en place ne sont pas une erreur — le service les compte et les signale.
 */
export const linkMetaDataDocumentTypesSchema = z.object({
  documentTypeIds: z.array(positiveId).min(1),
  metaDataIds: z.array(positiveId).min(1),
});

/**
 * Remplacement de la liste des métadonnées d'UN type (`UpdateMetaDataForDocumentType`) : ce qui
 * n'est pas dans `metaDataIds` est délié. Liste vide = plus aucune métadonnée sur ce type.
 */
export const setMetaDatasForTypeSchema = z.object({
  documentTypeId: positiveId,
  metaDataIds: z.array(positiveId),
});

// ---------------------------------------------------------------------------
// DUA / épuration (Docu-Archives §1, §2)
// ---------------------------------------------------------------------------

/** Pagination + tri + recherche communs aux quatre listes de l'espace Docu-Archives. */
const listQuery = {
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(25),
  search: z.string().trim().optional(),
  sortDirection: z.enum(['asc', 'desc']).default('asc'),
};

export const expiredQuerySchema = z.object({
  ...listQuery,
  sorting: z
    .enum(['label', 'documentType', 'usefulnessLifespan', 'complianceLifespan', 'startDate'])
    .default('usefulnessLifespan'),
  /**
   * Fenêtre d'anticipation en mois (0 = strictement échu). Le source raisonnait déjà sur une
   * fenêtre : à 3 on prépare la campagne d'épuration du trimestre.
   */
  monthsAhead: z.coerce.number().int().min(0).max(120).default(0),
});

export const purgedQuerySchema = z.object({
  ...listQuery,
  sorting: z.enum(['label', 'documentType', 'documentDate']).default('label'),
});

/** Épuration : passage des documents sélectionnés à l'état « Épuré ». */
export const purgeDocumentsSchema = z.object({
  documentIds: z.array(positiveId).min(1, 'Aucun document sélectionné'),
});

// ---------------------------------------------------------------------------
// Prêts / communications (Docu-Archives §3 à §6)
// ---------------------------------------------------------------------------

/**
 * Création d'une communication. Règles reprises de la validation front du source, mais portées
 * ICI pour qu'elles tiennent quel que soit l'appelant : date de début ≤ aujourd'hui, date de
 * retour prévue ≥ date de début (le « ≥ aujourd'hui » du source est équivalent dès lors que la
 * date de début est passée, et il refusait à tort un prêt court saisi le jour même).
 */
export const createLendingSchema = z
  .object({
    documentIds: z.array(positiveId).min(1, 'Sélectionnez au moins un document'),
    userGroupId: positiveId,
    lendingMotiveId: positiveId,
    startDate: isoDate,
    projectedReturnDate: isoDate,
  })
  .refine((d) => d.projectedReturnDate >= d.startDate, {
    message: 'La date de retour prévue doit suivre la date de début',
    path: ['projectedReturnDate'],
  });

export const lendingQuerySchema = z.object({
  ...listQuery,
  sorting: z
    .enum(['documentId', 'beneficiary', 'document', 'motive', 'startDate', 'projectedReturnDate', 'returnedDate'])
    .default('startDate'),
});

export const lendingCommentSchema = z.object({
  lendingDocumentId: positiveId,
  comments: z.string().trim().min(1).max(2000),
});

export type RefLabelDto = z.infer<typeof refLabelSchema>;
export type RefLabelsDto = z.infer<typeof refLabelsSchema>;
export type IdsDto = z.infer<typeof idsSchema>;
export type DocumentTypeSettingDto = z.infer<typeof documentTypeSettingSchema>;
export type DocumentTypeLifeCycleDto = z.infer<typeof documentTypeLifeCycleSchema>;
export type DocumentLifeCycleDto = z.infer<typeof documentLifeCycleSchema>;
export type CreateMetaDataDto = z.infer<typeof createMetaDataSchema>;
export type UpdateMetaDataDto = z.infer<typeof updateMetaDataSchema>;
export type CreateMetaDatasDto = z.infer<typeof createMetaDatasSchema>;
export type CreateMetaDataListItemsDto = z.infer<typeof createMetaDataListItemsSchema>;
export type UpdateMetaDataListItemDto = z.infer<typeof updateMetaDataListItemSchema>;
export type LinkMetaDataDocumentTypesDto = z.infer<typeof linkMetaDataDocumentTypesSchema>;
export type SetMetaDatasForTypeDto = z.infer<typeof setMetaDatasForTypeSchema>;
export type ExpiredQueryDto = z.infer<typeof expiredQuerySchema>;
export type PurgedQueryDto = z.infer<typeof purgedQuerySchema>;
export type PurgeDocumentsDto = z.infer<typeof purgeDocumentsSchema>;
export type CreateLendingDto = z.infer<typeof createLendingSchema>;
export type LendingQueryDto = z.infer<typeof lendingQuerySchema>;
export type LendingCommentDto = z.infer<typeof lendingCommentSchema>;
