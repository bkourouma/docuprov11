import { z } from 'zod';

/** Limite de taille d'un dépôt de version (octets). */
export const MAX_VERSION_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Chaîne optionnelle : vide ou blanche = absente (un champ multipart vide arrive en `''`). */
const optionalText = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .transform((v) => (v ? v : undefined));

/** Champs texte du multipart `POST /documents/:id/versions` (le fichier est traité à part). */
export const createVersionSchema = z.object({
  changeSummary: optionalText,
  comment: optionalText,
});
export type CreateVersionDto = z.infer<typeof createVersionSchema>;

/** Corps (optionnel) de `POST /documents/:id/versions/:versionId/restore`. */
export const restoreVersionSchema = z
  .object({ changeSummary: optionalText })
  .strict()
  .optional();
export type RestoreVersionDto = z.infer<typeof restoreVersionSchema>;
