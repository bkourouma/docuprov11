import { z } from 'zod';
import { WF_TRIGGER_EVENT_TYPES, type WfTriggerEventType } from '@archivage/types';
import type { WfFieldKind } from './domain/event-catalog';
import type { WfSubjectKind, WfTriggerConditions, WfTriggerOp } from './domain/contracts';

// Docu-Flow W3 — déclencheurs par événement : schémas d'entrée (stricts) et formes de réponse.
// La FORME des conditions est seulement contrôlée ici (objet) ; leur sémantique (champs du catalogue, opérateurs,
// types de valeur) est vérifiée par `parseTriggerConditions` dans le service, qui renvoie la liste des problèmes.

const intId = z.number().int().positive().max(2_147_483_647);

const eventTypeSchema = z.enum(WF_TRIGGER_EVENT_TYPES as unknown as [WfTriggerEventType, ...WfTriggerEventType[]]);

const nameSchema = z.string().trim().min(1).max(200);

/** Objet JSON libre à ce stade (jamais un tableau) : normalisé par le service. */
const conditionsSchema = z.record(z.string(), z.unknown());

/** Identifiant de déclencheur (Int) dans le chemin. */
export const wfTriggerIdSchema = z.coerce.number().int().positive().max(2_147_483_647);

export const createTriggerSchema = z
  .object({
    name: nameSchema,
    eventType: eventTypeSchema,
    definitionId: intId,
    conditions: conditionsSchema.default({}),
    runAsUserGroupId: intId,
    isActive: z.boolean().default(true),
  })
  .strict();
export type CreateTriggerInput = z.output<typeof createTriggerSchema>;

/** Le type d'événement et la définition ne changent jamais après création (clé inconnue refusée). */
export const updateTriggerSchema = z
  .object({
    name: nameSchema.optional(),
    conditions: conditionsSchema.optional(),
    runAsUserGroupId: intId.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.conditions !== undefined ||
      v.runAsUserGroupId !== undefined ||
      v.isActive !== undefined,
    { message: 'aucune modification fournie' },
  );
export type UpdateTriggerInput = z.output<typeof updateTriggerSchema>;

export const listTriggersQuerySchema = z
  .object({
    definitionId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
    eventType: eventTypeSchema.optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type ListTriggersQuery = z.output<typeof listTriggersQuerySchema>;

// ---------------------------------------------------------------------------
// Sorties
// ---------------------------------------------------------------------------

export interface TriggerDto {
  wfTriggerId: number;
  name: string;
  eventType: WfTriggerEventType;
  definitionId: number;
  definitionName: string;
  /** Conditions normalisées (forme `WfTriggerConditions`). */
  conditions: WfTriggerConditions;
  runAsUserGroupId: number;
  runAsLabel: string | null;
  isActive: boolean;
  lastFiredAt: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerCatalogFieldDto {
  name: string;
  kind: WfFieldKind;
  label: string;
}

export interface TriggerCatalogEventDto {
  type: WfTriggerEventType;
  label: string;
  subjectType: WfSubjectKind;
  fields: TriggerCatalogFieldDto[];
}

export interface TriggerCatalogDto {
  eventTypes: TriggerCatalogEventDto[];
  operators: WfTriggerOp[];
  limits: {
    defaults: { maxLaunches: number; windowMinutes: number };
    ceiling: { maxLaunches: number; windowMinutes: number };
  };
}
