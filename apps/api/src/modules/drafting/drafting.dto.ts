// Schémas de validation du contrat partagé (`@archivage/types`), reliés à `ZodValidationPipe`.
// Les corps sont STRICTS : tout champ inconnu est refusé (400).
export {
  gedDraftCreateDocumentSchema,
  gedDraftRequestSchema,
  type GedDraftCreateDocumentRequest,
  type GedDraftRequest,
} from '@archivage/types';
