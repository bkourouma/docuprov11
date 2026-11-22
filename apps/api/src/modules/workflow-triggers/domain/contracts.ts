import type { WfTriggerEventType } from '@archivage/types';

// Docu-Flow W3 — CONTRAT des déclencheurs par événement. Types seulement.
//
// Règle de sécurité centrale : un événement ne transporte que des champs STRUCTURÉS (identifiants, codes,
// nombres, booléens, dates ISO). Jamais de texte libre (objet, description, expéditeur, contenu OCR…) : un
// courrier entrant externe est de la DONNÉE, jamais du code ni une instruction. Les conditions n'évaluent
// que ces champs, avec des opérateurs fermés.

/** Valeur d'un champ d'événement : scalaire uniquement. */
export type WfFieldValue = string | number | boolean | null;

/** Types d'objet liés aux événements W3 (sous-ensemble de `WF_SUBJECT_TYPES`). */
export type WfSubjectKind = 'mail' | 'document';

/**
 * Événement métier interne. Produit par les modules existants (courriers…), le worker (ingestion, échéances)
 * ou le balayage de seuils ; consommé par le répartiteur de déclencheurs.
 */
export interface WfDomainEvent {
  type: WfTriggerEventType;
  subjectType: WfSubjectKind;
  /** Identifiant décimal de l'objet (`/^\d{1,18}$/`). */
  subjectId: string;
  /** Champs structurés autorisés par le catalogue (`event-catalog.ts`) pour ce type d'événement. */
  fields: Readonly<Record<string, WfFieldValue>>;
  /** Horodatage ISO UTC de l'événement. */
  occurredAt: string;
  /**
   * Distingue plusieurs occurrences du même événement sur le même objet (ex. la date d'échéance, pour qu'une
   * échéance déplacée puisse relancer). `[A-Za-z0-9_.:-]{1,60}`. Absent = une seule occurrence.
   */
  occurrenceKey?: string;
  /** Si présent, seul ce déclencheur est évalué (balayages par déclencheur du worker). */
  triggerId?: number;
}

/** Nom de la file BullMQ qui transporte les événements produits par le worker vers l'api. */
export const WF_EVENTS_QUEUE = 'wf-events';

export type WfTriggerOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'exists';
export const WF_TRIGGER_OPS: readonly WfTriggerOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'];

/** Condition : `field` est TOUJOURS `subject.<champ du catalogue>`. */
export interface WfTriggerCondition {
  field: string;
  op: WfTriggerOp;
  value?: string | number | boolean | Array<string | number | boolean>;
}

/**
 * Contenu de `wf_trigger.conditions` (JSON). `{}` est valide : aucune condition, tout événement du type convient.
 */
export interface WfTriggerConditions {
  /** Toutes doivent être vraies (ET). Évaluées par `evaluateCondition` du moteur. */
  match: WfTriggerCondition[];
  /** `deadline.reached` : l'échéance (`dateButoire`) est atteinte dans `leadHours` heures (0 = échue). */
  deadline?: { leadHours: number };
  /** `threshold.crossed` : métadonnée entière d'un document qui franchit un seuil. */
  threshold?: { metaDataId: number; op: 'gt' | 'gte'; value: number };
  /** Plafond de lancements par fenêtre glissante (protection contre une boucle d'événements). */
  limits?: { maxLaunches: number; windowMinutes: number };
}

export const WF_TRIGGER_DEFAULT_LIMITS = { maxLaunches: 60, windowMinutes: 60 } as const;
export const WF_TRIGGER_LIMIT_CEILING = { maxLaunches: 1000, windowMinutes: 1440 } as const;
/** Échecs consécutifs (hors refus par objet) au-delà desquels un déclencheur est désactivé automatiquement. */
export const WF_TRIGGER_MAX_CONSECUTIVE_FAILURES = 5;
/** Taille maximale de la file d'événements en attente dans un processus (au-delà : rejet journalisé). */
export const WF_EVENT_BUS_MAX_PENDING = 5000;

export type WfParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };
