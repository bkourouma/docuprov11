import { z } from 'zod';
import type { WfTriggerEventType } from '@archivage/types';
import { evaluateCondition } from '../../workflows/engine/interpreter';
import {
  WF_TRIGGER_DEFAULT_LIMITS,
  WF_TRIGGER_LIMIT_CEILING,
  WF_TRIGGER_OPS,
  type WfDomainEvent,
  type WfParseResult,
  type WfTriggerCondition,
  type WfTriggerConditions,
} from './contracts';
import { STRING_FIELD_PATTERN, WF_EVENT_CATALOG, type WfFieldKind } from './event-catalog';

// Conditions des déclencheurs. DEUX garanties :
//  1. champs STRUCTURÉS seulement : `subject.<champ du catalogue>` ; aucun chemin libre, donc jamais de texte libre
//     d'un courrier entrant ;
//  2. opérateurs FERMÉS (`WF_TRIGGER_OPS`) évalués par `evaluateCondition` du moteur (même sémantique que les arêtes
//     des workflows). Rien n'est jamais interprété comme du code ou une expression.

const SUBJECT_PREFIX = 'subject.';
const MAX_CONDITIONS = 20;
const MAX_IN_VALUES = 50;

const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);

const conditionSchema = z
  .object({
    field: z.string().min(1).max(100),
    op: z.enum(WF_TRIGGER_OPS as unknown as [string, ...string[]]),
    value: z.union([scalar, z.array(scalar).max(MAX_IN_VALUES)]).optional(),
  })
  .strict();

const conditionsSchema = z
  .object({
    match: z.array(conditionSchema).max(MAX_CONDITIONS).optional(),
    deadline: z
      .object({ leadHours: z.number().int().min(0).max(24 * 365) })
      .strict()
      .optional(),
    threshold: z
      .object({
        metaDataId: z.number().int().positive().max(2_147_483_647),
        op: z.enum(['gt', 'gte']),
        value: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        maxLaunches: z.number().int().min(1).max(WF_TRIGGER_LIMIT_CEILING.maxLaunches),
        windowMinutes: z.number().int().min(1).max(WF_TRIGGER_LIMIT_CEILING.windowMinutes),
      })
      .strict()
      .optional(),
  })
  .strict();

function checkValueKind(kind: WfFieldKind, v: unknown): boolean {
  if (kind === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (kind === 'boolean') return typeof v === 'boolean';
  return typeof v === 'string' && STRING_FIELD_PATTERN.test(v);
}

/**
 * Valide et normalise `wf_trigger.conditions` pour un type d'événement. `{}`/`null` sont valides (aucune condition).
 * Refuse : clé inconnue, champ hors catalogue, opérateur inconnu, valeur du mauvais type, comparaison d'ordre sur un
 * champ non numérique, `deadline` hors `deadline.reached`, `threshold` hors `threshold.crossed` (et obligatoire pour
 * ce dernier).
 */
export function parseTriggerConditions(
  eventType: WfTriggerEventType,
  raw: unknown,
): WfParseResult<WfTriggerConditions> {
  const spec = WF_EVENT_CATALOG[eventType];
  if (!spec) return { ok: false, issues: [`Type d'événement inconnu : « ${String(eventType)} ».`] };

  const parsed = conditionsSchema.safeParse(raw == null ? {} : raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'conditions'} : ${i.message}`),
    };
  }
  const issues: string[] = [];
  const match: WfTriggerCondition[] = [];

  (parsed.data.match ?? []).forEach((c, idx) => {
    const where = `match.${idx}`;
    if (!c.field.startsWith(SUBJECT_PREFIX)) {
      issues.push(`${where} : le champ doit commencer par « subject. ».`);
      return;
    }
    const fieldName = c.field.slice(SUBJECT_PREFIX.length);
    const field = Object.prototype.hasOwnProperty.call(spec.fields, fieldName) ? spec.fields[fieldName] : undefined;
    if (!field) {
      issues.push(`${where} : champ « ${fieldName} » absent du catalogue de ${eventType}.`);
      return;
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && field.kind !== 'number') {
      issues.push(`${where} : « ${c.op} » n'est permis que sur un champ numérique.`);
      return;
    }
    if (c.op === 'exists') {
      match.push({ field: c.field, op: 'exists' });
      return;
    }
    if (c.value === undefined) {
      issues.push(`${where} : valeur obligatoire pour « ${c.op} ».`);
      return;
    }
    if (c.op === 'in') {
      if (!Array.isArray(c.value) || c.value.length === 0 || !c.value.every((v) => checkValueKind(field.kind, v))) {
        issues.push(`${where} : « in » attend une liste non vide de valeurs de type ${field.kind}.`);
        return;
      }
    } else if (Array.isArray(c.value) || !checkValueKind(field.kind, c.value)) {
      issues.push(`${where} : la valeur doit être de type ${field.kind}.`);
      return;
    }
    match.push({ field: c.field, op: c.op as WfTriggerCondition['op'], value: c.value });
  });

  if (parsed.data.deadline && eventType !== 'deadline.reached') {
    issues.push('deadline : réservé au type deadline.reached.');
  }
  if (parsed.data.threshold && eventType !== 'threshold.crossed') {
    issues.push('threshold : réservé au type threshold.crossed.');
  }
  if (eventType === 'threshold.crossed' && !parsed.data.threshold) {
    issues.push('threshold : obligatoire pour un déclencheur threshold.crossed (métadonnée, opérateur, seuil).');
  }
  if (issues.length > 0) return { ok: false, issues };

  const value: WfTriggerConditions = { match };
  if (parsed.data.deadline) value.deadline = parsed.data.deadline;
  if (parsed.data.threshold) value.threshold = parsed.data.threshold;
  if (parsed.data.limits) value.limits = parsed.data.limits;
  return { ok: true, value };
}

/** Plafond effectif : valeurs du déclencheur, sinon défaut ; toujours borné par le plafond dur. */
export function resolveLimits(conditions: Pick<WfTriggerConditions, 'limits'>): {
  maxLaunches: number;
  windowMinutes: number;
} {
  const l = conditions.limits ?? WF_TRIGGER_DEFAULT_LIMITS;
  return {
    maxLaunches: Math.min(Math.max(1, l.maxLaunches), WF_TRIGGER_LIMIT_CEILING.maxLaunches),
    windowMinutes: Math.min(Math.max(1, l.windowMinutes), WF_TRIGGER_LIMIT_CEILING.windowMinutes),
  };
}

/** Contexte d'évaluation : champs structurés de l'événement uniquement. */
export function buildMatchContext(event: WfDomainEvent): Record<string, unknown> {
  return {
    event: { type: event.type, subjectType: event.subjectType, subjectId: event.subjectId, occurredAt: event.occurredAt },
    subject: { ...event.fields },
  };
}

/** Toutes les conditions `match` sont vraies (liste vide = vrai), avec l'évaluateur du moteur. */
export function matchesConditions(conditions: Pick<WfTriggerConditions, 'match'>, event: WfDomainEvent): boolean {
  const context = buildMatchContext(event);
  return conditions.match.every((c) => evaluateCondition({ field: c.field, op: c.op, value: c.value }, context));
}
