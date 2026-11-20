// Docu-GED lot 2a — contrat partagé api / worker / web du cadre de connecteurs de sources.
// Miroir TS des états stockés en `smallint` + CHECK (cf. packages/db/prisma/models/ged.prisma).
// Les énumérations (mode, statut, état d'élément, statut de passe) vivent dans ./ged.ts :
// GedSourceMode, GedSourceConnectorStatus, GedSourceItemState, GedSyncRunStatus.
import type {
  GedSourceConnectorStatus,
  GedSourceItemState,
  GedSourceMode,
  GedSyncRunStatus,
} from './ged';

/** File BullMQ des synchronisations (producteur api, consommateur worker). */
export const GED_CONNECTOR_SYNC_QUEUE = 'ged-connector-sync';

/** Travail de la file `ged-connector-sync` (job `sync`). Le job `tick` n'a pas de données utiles. */
export interface GedConnectorSyncJobData {
  connectorId: number;
  trigger: 'manual' | 'schedule';
  /** `user_group_id` de l'administrateur à l'origine ; `null`/absent = déclenchement système. */
  requestedBy?: number | null;
}

/** Noms de jobs de la file. `tick` : planificateur répétable (une fois par minute). */
export const GED_CONNECTOR_JOB = { sync: 'sync', tick: 'tick' } as const;

/** Bornes de sécurité communes à tous les connecteurs (surchargeables à la baisse par la config). */
export const GED_CONNECTOR_LIMITS = {
  /** Taille maximale d'un fichier ingéré (octets). */
  maxFileBytes: 50 * 1024 * 1024,
  /** Éléments traités par page de synchronisation (et par reprise de jeton). */
  pageSize: 100,
  /** Éléments maximum par passe : au-delà, la passe s'arrête proprement et reprend à la suivante. */
  maxItemsPerRun: 2000,
  /** Texte maximal conservé pour un élément indexé en place (caractères). */
  maxIndexedTextChars: 200_000,
} as const;

/**
 * Extensions de fichiers acceptées à l'ingestion (minuscules, point inclus). Alignée sur le scan-agent
 * et `ACCEPTED_EXTENSIONS` de `courriers/mail-scanned.service.ts` pour les formats image/PDF, étendue
 * aux formats bureautiques/texte courants. Tout autre type est refusé (état « en erreur », motif).
 */
export const GED_CONNECTOR_ALLOWED_EXTENSIONS = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.txt',
  '.csv',
  '.md',
  '.html',
  '.htm',
  '.rtf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.eml',
  '.msg',
] as const;

/** Vue d'un connecteur renvoyée par l'API admin — JAMAIS de secret ni de `credentialsEnc`. */
export interface GedConnectorView {
  gedSourceConnectorId: number;
  label: string;
  connectorType: string;
  mode: GedSourceMode;
  status: GedSourceConnectorStatus;
  /** Configuration non secrète. */
  config: Record<string, unknown> | null;
  /** `true` si des identifiants sont enregistrés (chiffrés ou par référence) — jamais leur valeur. */
  hasCredentials: boolean;
  credentialsRef: string | null;
  credentialsExpiresAt: string | null;
  syncIntervalMinutes: number | null;
  targetDossierId: number | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Type de connecteur disponible (registre), pour le formulaire d'administration. */
export interface GedConnectorFieldDescriptor {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'password' | 'textarea';
  required: boolean;
  help?: string;
  placeholder?: string;
}

export interface GedConnectorTypeInfo {
  type: string;
  label: string;
  description: string;
  supportedModes: GedSourceMode[];
  configFields: GedConnectorFieldDescriptor[];
  credentialFields: GedConnectorFieldDescriptor[];
}

export interface GedSourceSyncRunView {
  gedSourceSyncRunId: number;
  connectorId: number;
  status: GedSyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  itemsSeen: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsDeleted: number;
  itemsDuplicate: number;
  itemsFailed: number;
  errorMessage: string | null;
}

/** Provenance d'un élément (liste admin). */
export interface GedSourceItemView {
  gedSourceItemId: number;
  connectorId: number;
  externalId: string;
  name: string;
  originUrl: string | null;
  originPath: string | null;
  mimeType: string | null;
  byteLength: number | null;
  originAuthor: string | null;
  originCreatedAt: string | null;
  originModifiedAt: string | null;
  contentHash: string | null;
  originAcl: unknown;
  state: GedSourceItemState;
  documentId: number | null;
  duplicateOfId: number | null;
  errorMessage: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}
