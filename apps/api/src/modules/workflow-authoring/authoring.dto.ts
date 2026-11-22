import { z } from 'zod';
import {
  WF_AUTHORING_DESCRIPTION_MAX,
  WF_AUTHORING_DESCRIPTION_MIN,
  WF_TRIGGER_EVENT_TYPES,
  type WfTriggerEventType,
} from '@archivage/types';
import { sanitizeText } from '../workflow-agents/injection/untrusted';

// Docu-Flow W5 : schémas d'entrée de la création en langage naturel. La description est une DONNÉE.

/**
 * Description libre : contrôles et caractères invisibles retirés, fins de ligne unifiées, bords nettoyés.
 * Refusée si trop courte (vide après nettoyage comprise) ou trop longue (plafond mesuré sur le texte reçu).
 */
export const generateAuthoringSchema = z
  .object({
    description: z
      .string({
        required_error: 'La description est obligatoire.',
        invalid_type_error: 'La description doit être un texte.',
      })
      .max(
        WF_AUTHORING_DESCRIPTION_MAX * 2,
        `La description ne peut pas dépasser ${WF_AUTHORING_DESCRIPTION_MAX} caractères.`,
      )
      .transform((s) => sanitizeText(s).trim())
      .pipe(
        z
          .string()
          .min(1, 'La description est vide.')
          .min(
            WF_AUTHORING_DESCRIPTION_MIN,
            `La description est trop courte : ${WF_AUTHORING_DESCRIPTION_MIN} caractères au moins.`,
          )
          .max(
            WF_AUTHORING_DESCRIPTION_MAX,
            `La description ne peut pas dépasser ${WF_AUTHORING_DESCRIPTION_MAX} caractères.`,
          ),
      ),
    triggerHint: z
      .enum(WF_TRIGGER_EVENT_TYPES, {
        errorMap: () => ({ message: 'Type d’événement déclencheur inconnu.' }),
      })
      .optional(),
  })
  .strict('Champ inconnu dans la demande.');

export interface GenerateAuthoringInput {
  description: string;
  triggerHint?: WfTriggerEventType;
}

/** Identifiant de définition (Int) dans le chemin de `explain`. */
export const wfAuthoringDefinitionIdSchema = z.coerce
  .number({ invalid_type_error: 'Identifiant de workflow invalide.' })
  .int('Identifiant de workflow invalide.')
  .positive('Identifiant de workflow invalide.')
  .max(2_147_483_647, 'Identifiant de workflow invalide.');
