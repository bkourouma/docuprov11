// Docu-Flow W3 - balayages périodiques qui PRODUISENT des événements (échéances, seuils) pour l'API.
//
// Le worker ne lance jamais de workflow : il émet un événement par objet concerné, avec le `triggerId` du
// déclencheur évalué (seul ce déclencheur est évalué côté API, qui reste l'arbitre final des conditions `match`).
// Pour ne pas réémettre sans fin des objets non conformes et ne pas affamer les conformes, le balayage :
//  - reporte en SQL (paramétré) les conditions `match` portant sur une colonne connue (table blanche). Le filtre est
//    un SUR-ENSEMBLE de ce que l'API acceptera : une condition douteuse n'est jamais reportée (laissée à l'API) ;
//  - parcourt les objets par curseur keyset conservé en mémoire entre les ticks (tout objet finit par être vu, même
//    si plus de `maxRowsPerTrigger` objets sont refusés par l'API) ; un redémarrage repart du début ;
//  - exclut en SQL les objets dont une instance de la même définition porte déjà la clé d'idempotence (NOT EXISTS).
// Tout est tolérant aux pannes : une erreur sur un déclencheur est journalisée et n'empêche pas les autres ;
// un balayage ne lève jamais. Journalisation : compteurs et identifiants, jamais de donnée métier.
// SQL : valeurs toujours en paramètres ; seuls l'opérateur et les colonnes sont composés, depuis des TABLES BLANCHES.
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  emitWorkflowEvent,
  mailDeadlinePayload,
  thresholdPayload,
  type MailDeadlineRow,
  type ThresholdRow,
  type WfEventPayload,
} from './workflow-deadlines.events';

export const WF_SWEEP_LIMITS = {
  /** Déclencheurs évalués par balayage et par type. */
  maxTriggers: 50,
  /** Objets sélectionnés par déclencheur et par passage. */
  maxRowsPerTrigger: 200,
  /** Une échéance dépassée de plus de cette durée n'est plus relancée. */
  deadlineLookbackDays: 30,
  /** Plafond de `leadHours` (un an). */
  maxLeadHours: 8760,
} as const;

/**
 * État de document exclu des seuils (`document.document_state`) : 3 Épuré (DUA expirée), seul état terminal. L'état 1
 * (Archivé) correspond aux documents validés (QA) et reste évalué.
 */
const PURGED_DOCUMENT_STATE = 3;

/** Type de métadonnée « Entier » (`metadata.data_type`). */
const META_DATA_TYPE_INTEGER = 2;
const INT4_MAX = 2147483647;
/** Plus grand seuil accepté (15 chiffres : tient dans un entier JavaScript exact et dans un bigint). */
const THRESHOLD_ABS_MAX = 999_999_999_999_999;

/** Opérateurs de seuil autorisés -> fragment SQL (liste blanche : jamais de concaténation d'une valeur reçue). */
const THRESHOLD_OPERATORS: Readonly<Record<'gt' | 'gte', '>' | '>='>> = { gt: '>', gte: '>=' };

export interface WorkflowSweepLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const silentLog: WorkflowSweepLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface SweepResult {
  /** Déclencheurs dont la configuration était valable. */
  triggers: number;
  /** Objets sélectionnés (avant émission). */
  scanned: number;
  emitted: number;
  errors: number;
}

export type EmitFn = (event: WfEventPayload) => void;

type PrismaLike = Pick<PrismaClient, 'wfTrigger' | '$queryRaw'>;

interface TriggerRow {
  wfTriggerId: number;
  definitionId: number;
  conditions: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

async function loadTriggers(prisma: PrismaLike, eventType: string): Promise<TriggerRow[]> {
  return prisma.wfTrigger.findMany({
    where: { eventType, isActive: true },
    orderBy: { wfTriggerId: 'asc' },
    take: WF_SWEEP_LIMITS.maxTriggers,
    select: { wfTriggerId: true, definitionId: true, conditions: true },
  });
}

// ---------------------------------------------------------------------------
// Configuration d'un déclencheur
// ---------------------------------------------------------------------------

/** `conditions.deadline.leadHours` : entier >= 0 (défaut 0). `null` si la configuration est invalide. */
export function readLeadHours(conditions: unknown): number | null {
  if (!isRecord(conditions) || conditions.deadline === undefined) return 0;
  const deadline = conditions.deadline;
  if (!isRecord(deadline)) return null;
  const lead = deadline.leadHours;
  if (lead === undefined) return 0;
  if (typeof lead !== 'number' || !Number.isInteger(lead) || lead < 0 || lead > WF_SWEEP_LIMITS.maxLeadHours) {
    return null;
  }
  return lead;
}

export interface ThresholdConfig {
  metaDataId: number;
  op: 'gt' | 'gte';
  value: number;
}

/** `conditions.threshold` : validation STRICTE ; `null` si absent ou invalide. */
export function readThreshold(conditions: unknown): ThresholdConfig | null {
  if (!isRecord(conditions) || !isRecord(conditions.threshold)) return null;
  const { metaDataId, op, value } = conditions.threshold;
  if (typeof metaDataId !== 'number' || !Number.isInteger(metaDataId) || metaDataId < 1 || metaDataId > INT4_MAX) {
    return null;
  }
  if (op !== 'gt' && op !== 'gte') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > THRESHOLD_ABS_MAX) return null;
  return { metaDataId, op, value };
}

// ---------------------------------------------------------------------------
// Conditions `match` reportées en SQL (sur-ensemble de ce que l'API acceptera)
// ---------------------------------------------------------------------------

const MATCH_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'] as const;
type MatchOp = (typeof MATCH_OPS)[number];
const ORDER_SQL: Readonly<Record<string, string>> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
const MAX_IN_VALUES = 50;
const MAX_MATCH_CONDITIONS = 20;
/** Borne des valeurs numériques reportées (au-delà : laissé à l'API, évite tout débordement de type). */
const MATCH_NUMBER_MAX = 1e15;

/** Champ `subject.<nom>` -> expression SQL (TABLE BLANCHE ; les champs absents ne sont pas reportés). */
type ColumnMap = Readonly<Record<string, Prisma.Sql>>;

const DEADLINE_COLUMNS: ColumnMap = {
  mailType: Prisma.raw('m.mail_type'),
  status: Prisma.raw('m.status'),
  mailNatureId: Prisma.raw('m.mail_nature_id'),
  confidentialiteId: Prisma.raw('m.confidentialite_id'),
  externalEntityId: Prisma.raw('m.external_entity_id'),
  destinataireRoleId: Prisma.raw('m.destinataire_role_id'),
  destinataireUserGroupId: Prisma.raw('m.destinataire_expediteur'),
};

/** Colonnes des échéances, avec `hoursOverdue` calculé comme `mailDeadlinePayload` (heures entières, au `now` du balayage). */
const deadlineColumns = (now: Date): ColumnMap => ({
  ...DEADLINE_COLUMNS,
  hoursOverdue: Prisma.sql`floor(extract(epoch from (CAST(${now} AS timestamptz) - m.date_butoire)) / 3600)`,
});

const THRESHOLD_COLUMNS: ColumnMap = {
  documentTypeId: Prisma.raw('d.document_type_id'),
  dossierId: Prisma.raw('d.dossier_id'),
  value: Prisma.raw("(CASE WHEN v.value ~ '^-?[0-9]{1,15}$' THEN CAST(v.value AS bigint) END)"),
};

const isMatchOp = (op: unknown): op is MatchOp =>
  typeof op === 'string' && (MATCH_OPS as readonly string[]).includes(op);
const isSafeNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MATCH_NUMBER_MAX;
const num = (v: number): Prisma.Sql => Prisma.sql`CAST(${v} AS numeric)`;

/**
 * Fragment SQL d'UNE condition, ou `null` si elle ne doit pas être reportée (mal formée, champ non mappable, valeur
 * non numérique...). Sémantique alignée sur `evaluateCondition` de l'API, où NULL = champ présent mais vide :
 * `neq` inclut NULL, `exists` exclut NULL, les autres comparaisons excluent NULL.
 */
function conditionToSql(raw: unknown, columns: ColumnMap): Prisma.Sql | null {
  if (!isRecord(raw)) return null;
  const { field, op, value } = raw;
  if (typeof field !== 'string' || !field.startsWith('subject.') || !isMatchOp(op)) return null;
  const name = field.slice('subject.'.length);
  if (!Object.prototype.hasOwnProperty.call(columns, name)) return null;
  const col = columns[name] as Prisma.Sql;
  switch (op) {
    case 'exists':
      return Prisma.sql`${col} IS NOT NULL`;
    case 'in': {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) return null;
      if (!value.every(isSafeNumber)) return null;
      return Prisma.sql`${col} IN (${Prisma.join(value.map((v) => num(v as number)))})`;
    }
    case 'neq':
      return isSafeNumber(value) ? Prisma.sql`(${col} IS NULL OR ${col} <> ${num(value)})` : null;
    case 'eq':
      return isSafeNumber(value) ? Prisma.sql`${col} = ${num(value)}` : null;
    default: {
      const sqlOp = ORDER_SQL[op];
      return sqlOp && isSafeNumber(value) ? Prisma.sql`${col} ${Prisma.raw(sqlOp)} ${num(value)}` : null;
    }
  }
}

/** Fragments des conditions `match` reportables ; toute condition ignorée l'est silencieusement. */
export function matchSqlFragments(conditions: unknown, columns: ColumnMap): Prisma.Sql[] {
  if (!isRecord(conditions) || !Array.isArray(conditions.match)) return [];
  const out: Prisma.Sql[] = [];
  for (const raw of conditions.match.slice(0, MAX_MATCH_CONDITIONS)) {
    try {
      const frag = conditionToSql(raw, columns);
      if (frag) out.push(frag);
    } catch {
      /* condition mal formée : non reportée */
    }
  }
  return out;
}

const andAll = (frags: readonly Prisma.Sql[]): Prisma.Sql =>
  frags.length === 0 ? Prisma.empty : Prisma.sql`AND ${Prisma.join(frags, ' AND ')}`;

// ---------------------------------------------------------------------------
// Curseurs de parcours (en mémoire, par déclencheur)
// ---------------------------------------------------------------------------

export interface DeadlineCursor {
  dateButoire: Date;
  mailId: number;
}

export interface SweepCursors {
  deadlines: Map<number, DeadlineCursor>;
  thresholds: Map<number, number>;
}

export const createSweepCursors = (): SweepCursors => ({ deadlines: new Map(), thresholds: new Map() });
const defaultCursors: SweepCursors = createSweepCursors();

/** Remet à zéro les curseurs (tests, ou après un changement de configuration). */
export function resetSweepCursors(cursors: SweepCursors = defaultCursors): void {
  cursors.deadlines.clear();
  cursors.thresholds.clear();
}

/** Oublie les curseurs des déclencheurs qui ne sont plus actifs. */
function pruneCursors(map: Map<number, unknown>, active: readonly TriggerRow[]): void {
  const ids = new Set(active.map((t) => t.wfTriggerId));
  for (const key of [...map.keys()]) if (!ids.has(key)) map.delete(key);
}

// ---------------------------------------------------------------------------
// Échéances
// ---------------------------------------------------------------------------

/**
 * Courriers dont la date butoir est atteinte (ou le sera dans `leadHours` heures) : non supprimés, non traités,
 * dont la date butoir date de 30 jours au plus. Un événement par courrier, `occurrenceKey` = jour UTC de la date
 * butoir (une échéance déplacée peut donc relancer).
 */
export async function runDeadlineSweep(
  prisma: PrismaLike,
  now: Date,
  emit: EmitFn = emitWorkflowEvent,
  log: WorkflowSweepLog = silentLog,
  cursors: SweepCursors = defaultCursors,
): Promise<SweepResult> {
  const result: SweepResult = { triggers: 0, scanned: 0, emitted: 0, errors: 0 };
  let triggers: TriggerRow[];
  try {
    triggers = await loadTriggers(prisma, 'deadline.reached');
    pruneCursors(cursors.deadlines, triggers);
  } catch (err) {
    log.error({ err: errName(err) }, 'balayage des échéances : lecture des déclencheurs impossible');
    result.errors += 1;
    return result;
  }

  const floor = new Date(now.getTime() - WF_SWEEP_LIMITS.deadlineLookbackDays * 86_400_000);
  for (const trigger of triggers) {
    const triggerId = trigger.wfTriggerId;
    try {
      const leadHours = readLeadHours(trigger.conditions);
      if (leadHours === null) {
        log.warn({ triggerId }, 'balayage des échéances : configuration invalide, déclencheur ignoré');
        result.errors += 1;
        continue;
      }
      result.triggers += 1;
      const horizon = new Date(now.getTime() + leadHours * 3_600_000);
      const matchSql = andAll(matchSqlFragments(trigger.conditions, deadlineColumns(now)));
      const cursor = cursors.deadlines.get(triggerId);
      const cursorSql = cursor
        ? Prisma.sql`AND (m.date_butoire, m.mail_id) > (CAST(${cursor.dateButoire} AS timestamptz), CAST(${cursor.mailId} AS bigint))`
        : Prisma.empty;
      const rows = await prisma.$queryRaw<MailDeadlineRow[]>(Prisma.sql`
        SELECT m.mail_id AS "mailId",
               m.mail_type AS "mailType",
               m.status AS "status",
               m.mail_nature_id AS "mailNatureId",
               m.confidentialite_id AS "confidentialiteId",
               m.external_entity_id AS "externalEntityId",
               m.destinataire_role_id AS "destinataireRoleId",
               m.destinataire_expediteur AS "destinataireUserGroupId",
               m.date_butoire AS "dateButoire"
          FROM mail m
         WHERE m.is_deleted = false
           AND m.date_traited IS NULL
           AND m.date_butoire IS NOT NULL
           AND m.date_butoire <= ${horizon}
           AND m.date_butoire >= ${floor}
           ${matchSql}
           ${cursorSql}
           AND NOT EXISTS (
             SELECT 1 FROM wf_instance i
              WHERE i.definition_id = ${trigger.definitionId}
                AND i.idempotency_key = 'trg:' || ${String(triggerId)}::text || ':deadline.reached:mail:'
                    || m.mail_id::text || ':' || to_char(m.date_butoire AT TIME ZONE 'UTC', 'YYYY-MM-DD')
           )
         ORDER BY m.date_butoire ASC, m.mail_id ASC
         LIMIT ${WF_SWEEP_LIMITS.maxRowsPerTrigger}`);
      const batch = rows.slice(0, WF_SWEEP_LIMITS.maxRowsPerTrigger);
      // Page incomplète : cycle terminé, le prochain tick repart du début ; sinon on reprend après la dernière ligne.
      const last = batch[batch.length - 1];
      if (batch.length < WF_SWEEP_LIMITS.maxRowsPerTrigger || !last) cursors.deadlines.delete(triggerId);
      else cursors.deadlines.set(triggerId, { dateButoire: last.dateButoire, mailId: last.mailId });
      result.scanned += batch.length;
      for (const row of batch) {
        try {
          emit(mailDeadlinePayload(row, now, triggerId));
          result.emitted += 1;
        } catch (err) {
          result.errors += 1;
          log.error({ triggerId, mailId: row.mailId, err: errName(err) }, 'balayage des échéances : émission en échec');
        }
      }
    } catch (err) {
      result.errors += 1;
      log.error({ triggerId, err: errName(err) }, 'balayage des échéances : déclencheur en échec');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Seuils
// ---------------------------------------------------------------------------

interface RawThresholdRow {
  documentId: number;
  documentTypeId: number | null;
  dossierId: number | null;
  metaDataId: number;
  value: bigint | number;
}

/**
 * Documents dont une métadonnée ENTIÈRE franchit le seuil du déclencheur. Seules les valeurs strictement
 * numériques (`^-?[0-9]{1,15}$`) sont comparées ; le CAST n'est évalué que sur elles (CASE). Un événement par
 * document (une seule fois : l'instance créée porte la clé du déclencheur).
 */
export async function runThresholdSweep(
  prisma: PrismaLike,
  now: Date,
  emit: EmitFn = emitWorkflowEvent,
  log: WorkflowSweepLog = silentLog,
  cursors: SweepCursors = defaultCursors,
): Promise<SweepResult> {
  const result: SweepResult = { triggers: 0, scanned: 0, emitted: 0, errors: 0 };
  let triggers: TriggerRow[];
  try {
    triggers = await loadTriggers(prisma, 'threshold.crossed');
    pruneCursors(cursors.thresholds, triggers);
  } catch (err) {
    log.error({ err: errName(err) }, 'balayage des seuils : lecture des déclencheurs impossible');
    result.errors += 1;
    return result;
  }

  for (const trigger of triggers) {
    const triggerId = trigger.wfTriggerId;
    try {
      const config = readThreshold(trigger.conditions);
      if (!config) {
        log.warn({ triggerId }, 'balayage des seuils : configuration invalide, déclencheur ignoré');
        result.errors += 1;
        continue;
      }
      // Liste blanche : l'opérateur SQL ne vient jamais directement de la configuration.
      const sqlOp = THRESHOLD_OPERATORS[config.op];
      if (!sqlOp) {
        log.warn({ triggerId }, 'balayage des seuils : opérateur refusé, déclencheur ignoré');
        result.errors += 1;
        continue;
      }
      result.triggers += 1;
      const matchSql = andAll(matchSqlFragments(trigger.conditions, THRESHOLD_COLUMNS));
      const cursor = cursors.thresholds.get(triggerId);
      const cursorSql = cursor !== undefined ? Prisma.sql`AND d.document_id > ${cursor}` : Prisma.empty;
      const rows = await prisma.$queryRaw<RawThresholdRow[]>(Prisma.sql`
        SELECT d.document_id AS "documentId",
               d.document_type_id AS "documentTypeId",
               d.dossier_id AS "dossierId",
               v.metadata_id AS "metaDataId",
               CAST(v.value AS bigint) AS "value"
          FROM document_metadata_value v
          JOIN metadata md ON md.metadata_id = v.metadata_id AND md.data_type = ${META_DATA_TYPE_INTEGER}
          JOIN document d ON d.document_id = v.document_id
         WHERE v.metadata_id = ${config.metaDataId}
           AND v.value ~ '^-?[0-9]{1,15}$'
           AND (CASE WHEN v.value ~ '^-?[0-9]{1,15}$' THEN CAST(v.value AS bigint) END) ${Prisma.raw(sqlOp)} CAST(${config.value} AS bigint)
           AND d.document_state <> ${PURGED_DOCUMENT_STATE}
           ${matchSql}
           ${cursorSql}
           AND NOT EXISTS (
             SELECT 1 FROM wf_instance i
              WHERE i.definition_id = ${trigger.definitionId}
                AND i.idempotency_key = 'trg:' || ${String(triggerId)}::text || ':threshold.crossed:document:'
                    || d.document_id::text
           )
         ORDER BY d.document_id ASC
         LIMIT ${WF_SWEEP_LIMITS.maxRowsPerTrigger}`);
      const batch = rows.slice(0, WF_SWEEP_LIMITS.maxRowsPerTrigger);
      const last = batch[batch.length - 1];
      if (batch.length < WF_SWEEP_LIMITS.maxRowsPerTrigger || !last) cursors.thresholds.delete(triggerId);
      else cursors.thresholds.set(triggerId, last.documentId);
      result.scanned += batch.length;
      for (const raw of batch) {
        try {
          const row: ThresholdRow = { ...raw, value: Number(raw.value) };
          emit(thresholdPayload(row, config.value, triggerId, now));
          result.emitted += 1;
        } catch (err) {
          result.errors += 1;
          log.error({ triggerId, documentId: raw.documentId, err: errName(err) }, 'balayage des seuils : émission en échec');
        }
      }
    } catch (err) {
      result.errors += 1;
      log.error({ triggerId, err: errName(err) }, 'balayage des seuils : déclencheur en échec');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Passage complet
// ---------------------------------------------------------------------------

export interface WorkflowSweepsResult {
  deadlines: SweepResult;
  thresholds: SweepResult;
}

/** Exécute les deux balayages l'un après l'autre. Ne lève jamais. */
export async function runWorkflowSweeps(
  prisma: PrismaLike,
  now: Date,
  emit: EmitFn = emitWorkflowEvent,
  log: WorkflowSweepLog = silentLog,
  cursors: SweepCursors = defaultCursors,
): Promise<WorkflowSweepsResult> {
  const deadlines = await runDeadlineSweep(prisma, now, emit, log, cursors).catch(() => failed());
  const thresholds = await runThresholdSweep(prisma, now, emit, log, cursors).catch(() => failed());
  return { deadlines, thresholds };
}

const failed = (): SweepResult => ({ triggers: 0, scanned: 0, emitted: 0, errors: 1 });
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'inconnue');
