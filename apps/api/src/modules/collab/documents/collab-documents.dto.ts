import { z } from 'zod';

/** Taille maximale d'un fichier DOCX importé (octets) : même plafond que `@archivage/editor`. */
export const MAX_DOCX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Plus grand identifiant admis (entier 32 bits signé, colonnes `*_id`). */
const MAX_ID = 2_147_483_647;
/** Longueur maximale du libellé d'un document (colonne `document.label`). */
export const MAX_DOCUMENT_LABEL = 500;

const positiveId = z.number().int().positive().max(MAX_ID);

/** Chaîne optionnelle : vide ou blanche = absente (un champ multipart vide arrive en `''`). */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const label = z
  .string()
  .trim()
  .min(1, 'Libellé obligatoire')
  .max(MAX_DOCUMENT_LABEL, `Libellé trop long (${MAX_DOCUMENT_LABEL} caractères maximum)`);

/** Corps de `POST /collab/documents`. */
export const createCollabDocumentSchema = z.object({ spaceId: positiveId, label }).strict();
export type CreateCollabDocumentDto = z.infer<typeof createCollabDocumentSchema>;

/** Champs texte du multipart `POST /collab/documents/import` (le fichier est traité à part). */
export const importCollabDocumentSchema = z
  .object({
    spaceId: z.coerce.number().int().positive().max(MAX_ID),
    label: optionalText(MAX_DOCUMENT_LABEL),
  })
  .strict();
export type ImportCollabDocumentDto = z.infer<typeof importCollabDocumentSchema>;

/** Corps (facultatif) de `POST /collab/documents/:id/versions`. */
export const saveCollabVersionSchema = z.preprocess(
  (v) => v ?? {},
  z.object({ changeSummary: optionalText(2000) }).strict(),
);
export type SaveCollabVersionDto = z.infer<typeof saveCollabVersionSchema>;

/** Corps de `POST /collab/documents/:id/restore`. */
export const restoreCollabVersionSchema = z
  .object({ versionId: positiveId, changeSummary: optionalText(2000) })
  .strict();
export type RestoreCollabVersionDto = z.infer<typeof restoreCollabVersionSchema>;

/** `?q=` de `GET /collab/documents/:id/mention-candidates`. */
export const mentionCandidatesQuerySchema = z
  .object({ q: z.string().trim().max(100).default('') })
  .strict();
export type MentionCandidatesQueryDto = z.infer<typeof mentionCandidatesQuerySchema>;
