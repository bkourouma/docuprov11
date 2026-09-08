import { z } from 'zod';

/**
 * Chaque champ est facultatif ET annulable, et la chaîne vide est normalisée en `null`.
 *
 * C'est la règle centrale du paramétrage : un formulaire HTML renvoie `''` pour un champ vidé, pas
 * `null`. Sans cette normalisation, la base stockerait des chaînes vides que le gabarit devrait
 * ensuite distinguer de « non renseigné » — la logique « champ vide ⟹ ligne omise » se dédoublerait
 * alors entre l'API et le gabarit.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null));

/**
 * URL absolue exigée : une URL relative ne s'affiche pas depuis une boîte mail, où il n'y a aucune
 * page d'origine pour la résoudre. Vérifiée après normalisation, comme les champs texte.
 */
const optionalUrl = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null))
    .refine((v) => v === null || /^https?:\/\/\S+$/i.test(v), 'URL absolue attendue (https://…)');

export const updateEmailTemplateSchema = z.object({
  orgName: optionalText(200).optional(),
  contactEmail: optionalText(200).optional(),
  websiteUrl: optionalUrl(300).optional(),
});

export type UpdateEmailTemplateDto = z.infer<typeof updateEmailTemplateSchema>;
