import { z } from 'zod';

// Un dossier n'a plus ni catégorie ni localisation (migration 20260731160000).
export const newDossierSchema = z.object({
  label: z.string().min(1),
  parentId: z.number().int().positive().optional(),
});

export const createBatchSchema = z
  .object({
    // The destination dossier is OPTIONAL: a "DOSSIER" QR intercalaire inside the scanned
    // PDFs can set it during processing (FR-016). When given here it seeds the running dossier.
    dossierId: z.number().int().positive().optional(),
    newDossier: newDossierSchema.optional(),
    // Type de document du lot, choisi avant le téléversement : il classe les documents produits
    // (dossier + plan du paramétrage) et fixe les métadonnées de l'indexation. Optionnel : en mode
    // « avec intercalaires », le type peut venir entièrement des QR.
    documentTypeId: z.number().int().positive().optional(),
    // Plan de classement choisi manuellement à l'ouverture du lot, en écrasement du plan par
    // défaut du type (`document_type_setting`). Optionnel : à défaut, le worker retombe sur le
    // paramétrage du type.
    planId: z.number().int().positive().optional(),
    // Confidentialité choisie manuellement à l'ouverture du lot, en écrasement du niveau par
    // défaut du type (`document_type_setting`). Optionnel : à défaut, le worker retombe sur le
    // paramétrage du type.
    confidentialiteId: z.number().int().positive().optional(),
    sourceLabel: z.string().optional(),
    // true = ancien système (découpage par intercalaire QR + OCR) ; false/absent = mode normal.
    useIntercalaires: z.boolean().optional(),
  })
  .refine((d) => !(d.dossierId != null && d.newDossier != null), {
    message: 'Fournir un dossier existant OU un nouveau dossier, pas les deux.',
  });

export type NewDossierDto = z.infer<typeof newDossierSchema>;
export type CreateBatchDto = z.infer<typeof createBatchSchema>;
