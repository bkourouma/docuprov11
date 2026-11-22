// Docu-Flow W3 - émetteur d'événements métier du worker vers l'API.
//
// Le worker ne lance JAMAIS de workflow : il PRODUIT des événements dans la file BullMQ `wf-events`, que l'API
// consomme (validation contre un catalogue FERMÉ de champs structurés, puis répartition vers les déclencheurs).
// Règle de sécurité : aucun texte libre dans un événement (jamais de titre, description, libellé ni contenu OCR).
// Les constructeurs ci-dessous n'acceptent que des champs structurés.
//
// L'émission est « tire et oublie » : elle ne lève jamais et ne bloque jamais le traitement appelant. Tant que
// l'émetteur n'est pas initialisé (tests, scripts), `emitWorkflowEvent` ne fait rien et n'ouvre aucune connexion.

/** Valeur d'un champ d'événement : scalaire uniquement. */
export type WfFieldValue = string | number | boolean | null;

/**
 * Copie fidèle de `WfDomainEvent` (apps/api/src/modules/workflow-triggers/domain/contracts.ts). Le worker
 * n'importe pas l'API : le catalogue (`event-catalog.ts`) FAIT FOI côté API, qui rejette tout champ inconnu.
 */
export interface WfEventPayload {
  type: 'mail.arrived' | 'document.deposited' | 'deadline.reached' | 'threshold.crossed';
  subjectType: 'mail' | 'document';
  /** Identifiant décimal de l'objet. */
  subjectId: string;
  fields: Readonly<Record<string, WfFieldValue>>;
  /** Horodatage ISO UTC. */
  occurredAt: string;
  occurrenceKey?: string;
  /** Si présent, seul ce déclencheur est évalué côté API. */
  triggerId?: number;
}

export interface WfEventsQueueLike {
  add(name: string, data: unknown, opts?: object): Promise<unknown>;
}

export interface WfEmitterLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Nom du job posé dans la file `wf-events`. */
export const WF_EVENT_JOB_NAME = 'wf-event';

/** Options des jobs d'événement (exportées pour les tests). */
export const WF_EVENT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
} as const;

let emitterQueue: WfEventsQueueLike | null = null;
let emitterLog: WfEmitterLog | null = null;

/** Branche (ou débranche avec `null`) la file de production. À appeler une fois au démarrage du worker. */
export function initWorkflowEventEmitter(queue: WfEventsQueueLike | null, log?: WfEmitterLog): void {
  emitterQueue = queue;
  emitterLog = log ?? null;
}

/**
 * Identifiant de job déterministe (dédoublonnage par BullMQ tant que le job est conservé). BullMQ refuse le
 * caractère ':' dans un identifiant : remplacé par '_'.
 */
export function workflowEventJobId(event: WfEventPayload): string {
  const raw = [
    'wfe',
    event.type,
    event.subjectType,
    event.subjectId,
    event.occurrenceKey ?? '-',
    event.triggerId != null ? `t${event.triggerId}` : '-',
  ].join('_');
  return raw.replace(/:/g, '_');
}

/** Émet un événement. Ne lève JAMAIS, ne bloque jamais ; sans émetteur initialisé, ne fait rien. */
export function emitWorkflowEvent(event: WfEventPayload): void {
  const queue = emitterQueue;
  if (!queue) return;
  try {
    const pending = queue.add(WF_EVENT_JOB_NAME, event, {
      ...WF_EVENT_JOB_OPTIONS,
      jobId: workflowEventJobId(event),
    });
    void Promise.resolve(pending).catch((err: unknown) => logFailure(event, err));
  } catch (err) {
    logFailure(event, err);
  }
}

function logFailure(event: WfEventPayload, err: unknown): void {
  try {
    // Identifiants seulement : jamais le contenu de l'événement.
    emitterLog?.warn(
      { type: event.type, subjectId: event.subjectId, err: err instanceof Error ? err.name : 'inconnue' },
      "émission d'un événement workflow impossible",
    );
  } catch {
    /* la journalisation ne doit jamais faire échouer l'appelant */
  }
}

// ---------------------------------------------------------------------------
// Constructeurs (champs du catalogue de l'API, valeurs absentes = null)
// ---------------------------------------------------------------------------

const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Sous-ensemble structuré d'une ligne `document` : AUCUN texte libre (label, overview, ocr...). */
export interface DocumentPayloadSource {
  documentId: number;
  documentTypeId?: number | null;
  planId?: number | null;
  locationId?: number | null;
  dossierId?: number | null;
  confidentialiteId?: number | null;
  batchId?: number | null;
  createdBy?: number | null;
}

/** Catalogue `document.deposited`. */
export function documentDepositedPayload(
  doc: DocumentPayloadSource,
  opts: { source: 'acquisition' | 'fusion' | 'externe'; pageCount?: number | null },
  now: Date = new Date(),
): WfEventPayload {
  return {
    type: 'document.deposited',
    subjectType: 'document',
    subjectId: String(doc.documentId),
    occurredAt: now.toISOString(),
    fields: {
      documentTypeId: intOrNull(doc.documentTypeId),
      planId: intOrNull(doc.planId),
      locationId: intOrNull(doc.locationId),
      dossierId: intOrNull(doc.dossierId),
      confidentialiteId: intOrNull(doc.confidentialiteId),
      batchId: intOrNull(doc.batchId),
      createdBy: intOrNull(doc.createdBy),
      pageCount: intOrNull(opts.pageCount),
      source: opts.source,
    },
  };
}

/**
 * Construit ET émet l'événement `document.deposited` ; ne lève JAMAIS (un document invalide ou une file en panne
 * ne doit pas casser l'ingestion). L'échec est journalisé (identifiant du document et nom de l'erreur seulement).
 */
export function safeEmitDocumentDeposited(
  doc: DocumentPayloadSource,
  opts: { source: 'acquisition' | 'fusion' | 'externe'; pageCount?: number | null },
  emit: (event: WfEventPayload) => void = emitWorkflowEvent,
): void {
  try {
    emit(documentDepositedPayload(doc, opts));
  } catch (err) {
    try {
      emitterLog?.warn(
        { documentId: doc?.documentId, source: opts?.source, err: err instanceof Error ? err.name : 'inconnue' },
        "événement workflow « document déposé » non émis",
      );
    } catch {
      /* la journalisation ne doit jamais faire échouer l'appelant */
    }
  }
}

/** Ligne de courrier lue par le balayage des échéances (colonnes structurées uniquement). */
export interface MailDeadlineRow {
  mailId: number;
  mailType: number;
  status: number;
  mailNatureId: number | null;
  confidentialiteId: number | null;
  externalEntityId: number | null;
  destinataireRoleId: number | null;
  destinataireUserGroupId: number | null;
  dateButoire: Date;
}

const HOUR_MS = 3_600_000;

/** Catalogue `deadline.reached`. `occurrenceKey` = date UTC (AAAA-MM-JJ) de la date butoir. */
export function mailDeadlinePayload(row: MailDeadlineRow, now: Date, triggerId: number): WfEventPayload {
  const due = row.dateButoire;
  return {
    type: 'deadline.reached',
    subjectType: 'mail',
    subjectId: String(row.mailId),
    occurredAt: now.toISOString(),
    occurrenceKey: due.toISOString().slice(0, 10),
    triggerId,
    fields: {
      mailType: intOrNull(row.mailType),
      status: intOrNull(row.status),
      mailNatureId: intOrNull(row.mailNatureId),
      confidentialiteId: intOrNull(row.confidentialiteId),
      externalEntityId: intOrNull(row.externalEntityId),
      destinataireRoleId: intOrNull(row.destinataireRoleId),
      destinataireUserGroupId: intOrNull(row.destinataireUserGroupId),
      dateButoire: due.toISOString(),
      hoursOverdue: Math.floor((now.getTime() - due.getTime()) / HOUR_MS),
    },
  };
}

/** Ligne de valeur de métadonnée lue par le balayage des seuils. */
export interface ThresholdRow {
  documentId: number;
  documentTypeId: number | null;
  dossierId: number | null;
  metaDataId: number;
  value: number;
}

/** Catalogue `threshold.crossed`. Pas d'`occurrenceKey` : un seul lancement par document et déclencheur. */
export function thresholdPayload(
  row: ThresholdRow,
  thresholdValue: number,
  triggerId: number,
  now: Date = new Date(),
): WfEventPayload {
  return {
    type: 'threshold.crossed',
    subjectType: 'document',
    subjectId: String(row.documentId),
    occurredAt: now.toISOString(),
    triggerId,
    fields: {
      documentTypeId: intOrNull(row.documentTypeId),
      dossierId: intOrNull(row.dossierId),
      metaDataId: intOrNull(row.metaDataId),
      value: intOrNull(row.value),
      thresholdValue: intOrNull(thresholdValue),
    },
  };
}
