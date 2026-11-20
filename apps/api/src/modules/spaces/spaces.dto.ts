import { z } from 'zod';
import { SLUG_MAX, SLUG_MIN, SLUG_PATTERN } from './domain/space-slug';

/** Nature modifiable directement : 0 privé, 1 partage, 2 collaboration. La publication (3) passe par /publish. */
const editableKind = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const permission = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const positiveId = z.number().int().positive();

const label = z.string().trim().min(1, 'Libellé obligatoire').max(200);
/** Description vide ⟹ `null` (effacement explicite). */
const description = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .transform((v) => (v ? v : null));

export const createSpaceSchema = z
  .object({
    label,
    description: description.optional(),
    kind: editableKind,
  })
  .strict();
export type CreateSpaceDto = z.infer<typeof createSpaceSchema>;

export const updateSpaceSchema = z
  .object({
    label: label.optional(),
    description: description.optional(),
    kind: editableKind.optional(),
  })
  .strict()
  .refine((v) => v.label !== undefined || v.description !== undefined || v.kind !== undefined, {
    message: 'Aucune modification fournie',
  });
export type UpdateSpaceDto = z.infer<typeof updateSpaceSchema>;

/** Bénéficiaire : un compte-groupe OU un rôle, exactement un des deux. */
export const addMemberSchema = z
  .object({
    userGroupId: positiveId.optional(),
    roleId: positiveId.optional(),
    permission,
  })
  .strict()
  .refine((v) => (v.userGroupId === undefined) !== (v.roleId === undefined), {
    message: 'Indiquer exactement un bénéficiaire : userGroupId ou roleId',
  });
export type AddMemberDto = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({ permission }).strict();
export type UpdateMemberDto = z.infer<typeof updateMemberSchema>;

export const attachDocumentSchema = z.object({ documentId: positiveId }).strict();
export type AttachDocumentDto = z.infer<typeof attachDocumentSchema>;

export const slugSchema = z
  .string()
  .trim()
  .min(SLUG_MIN)
  .max(SLUG_MAX)
  .regex(SLUG_PATTERN, 'Slug attendu : minuscules, chiffres et tirets (ex. rapport-annuel-2026)');

/** Corps absent toléré (équivaut à `{}`) : le slug est alors dérivé du libellé. */
export const publishSpaceSchema = z.preprocess(
  (v) => v ?? {},
  z.object({ slug: slugSchema.optional() }).strict(),
);
export type PublishSpaceDto = z.infer<typeof publishSpaceSchema>;

/**
 * Pagination du listing des documents (`?limit=&offset=`, chaînes de requête converties).
 * Défauts : 100 documents à partir du premier ; plafond 200 par page.
 */
export const listDocumentsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListDocumentsQueryDto = z.infer<typeof listDocumentsQuerySchema>;
