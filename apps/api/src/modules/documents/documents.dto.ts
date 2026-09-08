import { z } from 'zod';

/**
 * Indexation d'un document : ses métadonnées de type, son classement, puis, avec `validate`, la
 * bascule `isArchived=true` (équivalent legacy Archive 0→1).
 *
 * Deux usages, un seul contrat :
 *  - l'ACQUISITION (QA d'un lot) n'envoie que `metadataValues` + `validate` : le classement y est
 *    décidé à l'ouverture du lot (`acquisition_batch.document_type_id` + `document_type_setting`)
 *    et posé par le worker à la création des documents ;
 *  - la CONSULTATION (onglet « Indexation » de `/documents/:id`) réindexe complètement un document
 *    déjà archivé — corriger un type mal lu par un QR ou un classement erroné est le geste même de
 *    cet écran, et le refuser obligerait à re-numériser.
 *
 * `.strict()` est conservé : un champ inconnu (ou retiré du contrat, comme `cote`, que plus aucun
 * écran ne saisit) doit échouer bruyamment plutôt que d'être écarté en silence par zod — ce qui
 * ferait croire à un enregistrement réussi.
 */
export const indexationSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    documentTypeId: z.number().int().positive().nullable().optional(),
    planId: z.number().int().positive().nullable().optional(),
    dossierId: z.number().int().positive().nullable().optional(),
    documentDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ')
      .nullable()
      .optional(),
    validate: z.boolean().optional(),
    /**
     * Valeurs des métadonnées du type (formulaire dynamique d'indexation).
     * Liste EXHAUSTIVE des champs du type : ce qui n'y figure pas — ou y figure vide — est
     * effacé, ce qui permet de vider un champ sans geste de suppression dédié.
     * La conversion selon le `data_type` est faite par `domain/metadata-value.ts`, pas ici : zod
     * ne connaît pas le type de saisie de chaque métadonnée, qui se lit en base.
     */
    metadataValues: z
      .array(
        z.object({
          metaDataId: z.number().int().positive(),
          value: z.string().nullable().optional(),
          metaDataListItemId: z.number().int().positive().nullable().optional(),
        }),
      )
      .optional(),
  })
  .strict()
  .refine(
    (d) =>
      d.label !== undefined ||
      d.documentTypeId !== undefined ||
      d.planId !== undefined ||
      d.dossierId !== undefined ||
      d.documentDate !== undefined ||
      d.metadataValues !== undefined ||
      d.validate === true,
    { message: 'Aucun champ à mettre à jour' },
  );

export type IndexationDto = z.infer<typeof indexationSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');
const positiveId = z.number().int().positive();

/**
 * Cycle de vie PROPRE à un document (onglet « Cycle de vie ») : des DATES d'échéance, pas des
 * durées — contrairement à la règle de son type, qui s'exprime en mois. C'est la dérogation
 * manuelle, elle doit donc pouvoir s'écarter de ce que la règle générale calculerait.
 */
export const documentLifeCycleSchema = z.object({
  usefulnessLifespan: isoDate,
  complianceLifespan: isoDate,
  observations: z.string().optional(),
  finalFateId: positiveId.nullable().optional(),
  destructionModeId: positiveId.nullable().optional(),
});
export type DocumentLifeCycleDto = z.infer<typeof documentLifeCycleSchema>;

/**
 * Droit explicite sur un document — accordé SOIT à un acteur nommé, SOIT à un profil entier
 * (onglets « Accès par Utilisateur » / « Accès par Profil »). Le `.refine` reflète en entrée le
 * CHECK `ck_dp_grantee` de la table : exactement un bénéficiaire, jamais zéro ni deux. Le refuser
 * ici donne un 400 lisible, là où la base ne renverrait qu'une violation de contrainte en 500.
 */
export const documentPermissionSchema = z
  .object({
    userGroupId: positiveId.optional(),
    groupId: positiveId.optional(),
    permissionLevelId: positiveId,
    // Fenêtre de validité du droit, comme `document_type_permission` (même règle). Optionnel :
    // à défaut, le droit reste sans limite.
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
  })
  .refine((d) => (d.userGroupId != null) !== (d.groupId != null), {
    message: 'Fournir un utilisateur OU un profil, pas les deux',
  });
export type DocumentPermissionDto = z.infer<typeof documentPermissionSchema>;

/** Niveau de confidentialité exigé par un document — `null` retire toute exigence. */
export const documentConfidentialiteSchema = z.object({
  confidentialiteId: positiveId.nullable(),
});
export type DocumentConfidentialiteDto = z.infer<typeof documentConfidentialiteSchema>;
