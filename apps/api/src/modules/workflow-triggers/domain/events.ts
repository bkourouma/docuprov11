import { z } from 'zod';
import { isWfTriggerEventType } from '@archivage/types';
import { WF_TRIGGER_IDEMPOTENCY_PREFIX } from '../../workflows/extension/trigger-idempotency';
import type { WfDomainEvent, WfFieldValue, WfParseResult } from './contracts';
import { STRING_FIELD_PATTERN, WF_EVENT_CATALOG } from './event-catalog';

// Événements métier : validation (aussi pour les jobs venus du worker, donc NON fiables), clé d'idempotence,
// contexte d'instance et constructeurs des événements émis par les modules existants.

const OCCURRENCE_PATTERN = /^[A-Za-z0-9_.:-]{1,60}$/;
const SUBJECT_ID_PATTERN = /^\d{1,18}$/;

const rawEventSchema = z
  .object({
    type: z.string(),
    subjectType: z.enum(['mail', 'document']),
    subjectId: z.string().regex(SUBJECT_ID_PATTERN),
    fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    occurredAt: z.string().max(40),
    occurrenceKey: z.string().regex(OCCURRENCE_PATTERN).optional(),
    triggerId: z.number().int().positive().max(2_147_483_647).optional(),
  })
  .strict();

/**
 * Valide un événement inconnu (job BullMQ, émetteur tiers) : type du catalogue, type d'objet cohérent, champs
 * du catalogue SEULEMENT (un champ inconnu est refusé, jamais ignoré en silence), valeurs du bon genre, chaînes
 * conformes à `STRING_FIELD_PATTERN`. Un champ `null` est conservé (valeur absente).
 */
export function parseDomainEvent(raw: unknown): WfParseResult<WfDomainEvent> {
  const parsed = rawEventSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'événement'} : ${i.message}`) };
  }
  const e = parsed.data;
  if (!isWfTriggerEventType(e.type)) return { ok: false, issues: [`type : « ${e.type} » inconnu.`] };
  const spec = WF_EVENT_CATALOG[e.type];
  const issues: string[] = [];
  if (spec.subjectType !== e.subjectType) {
    issues.push(`subjectType : ${e.type} concerne « ${spec.subjectType} ».`);
  }
  if (Number.isNaN(Date.parse(e.occurredAt))) issues.push('occurredAt : date invalide.');

  const fields: Record<string, WfFieldValue> = {};
  for (const [name, value] of Object.entries(e.fields)) {
    const field = Object.prototype.hasOwnProperty.call(spec.fields, name) ? spec.fields[name] : undefined;
    if (!field) {
      issues.push(`fields.${name} : champ absent du catalogue de ${e.type}.`);
      continue;
    }
    if (value === null) {
      fields[name] = null;
      continue;
    }
    const ok =
      field.kind === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : field.kind === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'string' && STRING_FIELD_PATTERN.test(value);
    if (!ok) issues.push(`fields.${name} : valeur de type ${field.kind} attendue.`);
    else fields[name] = value;
  }
  if (issues.length > 0) return { ok: false, issues };

  const event: WfDomainEvent = {
    type: e.type,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    fields,
    occurredAt: new Date(e.occurredAt).toISOString(),
  };
  if (e.occurrenceKey) event.occurrenceKey = e.occurrenceKey;
  if (e.triggerId) event.triggerId = e.triggerId;
  return { ok: true, value: event };
}

/**
 * Clé d'idempotence d'un lancement : `trg:{triggerId}:{événement}:{objet}:{id}[:{occurrence}]`, 200 caractères au
 * plus. Le préfixe `trg:` est réservé (refusé sur la route publique). Le balayage du worker recalcule la MÊME
 * clé (`workflow-deadlines.keys.ts`) : toute modification doit être reportée des deux côtés.
 */
export function triggerIdempotencyKey(triggerId: number, event: WfDomainEvent): string {
  const base = `${WF_TRIGGER_IDEMPOTENCY_PREFIX}${triggerId}:${event.type}:${event.subjectType}:${event.subjectId}`;
  return event.occurrenceKey ? `${base}:${event.occurrenceKey}` : base;
}

/** Données de lancement (`context.input`) : métadonnées de l'événement et champs structurés, jamais de texte libre. */
export function buildInstanceInput(triggerId: number, event: WfDomainEvent): Record<string, unknown> {
  return {
    trigger: { id: triggerId, eventType: event.type },
    event: {
      type: event.type,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      occurredAt: event.occurredAt,
    },
    subject: { ...event.fields },
  };
}

// ---------------------------------------------------------------------------
// Constructeurs d'événements (appelés par les modules existants, après commit)
// ---------------------------------------------------------------------------

const isoOrNull = (d: Date | string | null | undefined): string | null => {
  if (d == null) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/** Sous-ensemble structuré d'une ligne `mail` : AUCUN texte libre (title, description, reference…). */
export interface MailEventSource {
  mailId: number;
  mailType: number;
  status: number;
  mailNatureId?: number | null;
  confidentialiteId?: number | null;
  externalEntityId?: number | null;
  destinataireRoleId?: number | null;
  destinataireExpediteur?: number | null;
  organigrammeId?: number | null;
  mailObjetId?: number | null;
  dateButoire?: Date | string | null;
}

export function mailArrivedEvent(mail: MailEventSource, opts: { hasDocument?: boolean; now?: Date } = {}): WfDomainEvent {
  const dateButoire = isoOrNull(mail.dateButoire);
  return {
    type: 'mail.arrived',
    subjectType: 'mail',
    subjectId: String(mail.mailId),
    occurredAt: (opts.now ?? new Date()).toISOString(),
    fields: {
      mailType: mail.mailType,
      status: mail.status,
      mailNatureId: mail.mailNatureId ?? null,
      confidentialiteId: mail.confidentialiteId ?? null,
      externalEntityId: mail.externalEntityId ?? null,
      destinataireRoleId: mail.destinataireRoleId ?? null,
      destinataireUserGroupId: mail.destinataireExpediteur ?? null,
      organigrammeId: mail.organigrammeId ?? null,
      mailObjetId: mail.mailObjetId ?? null,
      hasDocument: opts.hasDocument ?? false,
      hasDeadline: dateButoire != null,
      dateButoire,
    },
  };
}

/** Sous-ensemble structuré d'une ligne `document` : AUCUN texte libre (label, overview, ocr…). */
export interface DocumentEventSource {
  documentId: number;
  documentTypeId?: number | null;
  planId?: number | null;
  locationId?: number | null;
  dossierId?: number | null;
  confidentialiteId?: number | null;
  batchId?: number | null;
  createdBy?: number | null;
}

export function documentDepositedEvent(
  doc: DocumentEventSource,
  opts: { source: 'acquisition' | 'fusion' | 'externe' | 'editeur' | 'scan'; pageCount?: number | null; now?: Date },
): WfDomainEvent {
  return {
    type: 'document.deposited',
    subjectType: 'document',
    subjectId: String(doc.documentId),
    occurredAt: (opts.now ?? new Date()).toISOString(),
    fields: {
      documentTypeId: doc.documentTypeId ?? null,
      planId: doc.planId ?? null,
      locationId: doc.locationId ?? null,
      dossierId: doc.dossierId ?? null,
      confidentialiteId: doc.confidentialiteId ?? null,
      batchId: doc.batchId ?? null,
      createdBy: doc.createdBy ?? null,
      pageCount: opts.pageCount ?? null,
      source: opts.source,
    },
  };
}
