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
  /** Lot 2b — présent si la source s'autorise par OAuth 2.0 (bouton « Autoriser avec … »). */
  oauth?: GedConnectorOAuthInfo;
}

/** Lot 2b — autorisation OAuth 2.0 d'un type de connecteur (périmètres minimaux, lecture seule). */
export interface GedConnectorOAuthInfo {
  provider: 'google' | 'microsoft';
  scopes: string[];
}

/** Lot 2b — POST /ged/connectors/:id/oauth/start. */
export interface GedOAuthStartRequest {
  /** URI de retour (page web) : doit figurer dans la liste blanche GED_OAUTH_REDIRECT_URIS. */
  redirectUri: string;
}
export interface GedOAuthStartResponse {
  authorizationUrl: string;
  expiresInSeconds: number;
}
/** Lot 2b — POST /ged/connectors/oauth/callback (appelé par la page web de retour, avec le JWT de l'administrateur). */
export interface GedOAuthCallbackRequest {
  code: string;
  state: string;
}
export interface GedOAuthCallbackResponse {
  connectorId: number;
  authorized: true;
  /** Fin de validité de l'autorisation si le fournisseur la communique, sinon `null`. */
  expiresAt: string | null;
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

// ---------------------------------------------------------------------------
// Lot 2c — connecteur WhatsApp Business (API WhatsApp Cloud de Meta). Ajouts non cassants.
// Connecteur « push » : Meta appelle le webhook public de l'API ; l'API enregistre un élément
// (`ged_source_item`, `external_id` = identifiant de message `wamid…`, unique par connecteur =
// idempotence) puis enfile un job ; le worker télécharge le média et l'ingère en mode copie.
// ---------------------------------------------------------------------------

/** Clé de type du connecteur dans le registre (`ged_source_connector.connector_type`). */
export const GED_WHATSAPP_CONNECTOR_TYPE = 'whatsapp';

/** File BullMQ des messages WhatsApp entrants (producteur api, consommateur worker). */
export const GED_WHATSAPP_QUEUE = 'ged-whatsapp-inbound';

/** Noms de jobs de la file `ged-whatsapp-inbound`. */
export const GED_WHATSAPP_JOB = {
  /** Télécharger le média d'un élément déjà enregistré, l'ingérer, envoyer l'accusé. */
  inbound: 'inbound',
  /** Envoyer un message poli de refus (expéditeur inconnu, type non pris en charge). */
  refuse: 'refuse',
} as const;

/** Job `inbound` : seul l'identifiant de l'élément voyage (le reste est relu en base). */
export interface GedWhatsappInboundJobData {
  connectorId: number;
  /** `ged_source_item_id` (bigint) en chaîne décimale. */
  itemId: string;
}

/**
 * Job `refuse`. `to` = numéro de l'expéditeur en chiffres (format international sans `+`) : donnée
 * personnelle de courte durée de vie (le job est supprimé après exécution), jamais journalisée en clair.
 */
export interface GedWhatsappRefuseJobData {
  connectorId: number;
  to: string;
  reason: 'unknown_sender' | 'unsupported_type';
}

/**
 * Contenu de `ged_source_item.origin_metadata` d'un message WhatsApp (non exposé par l'API :
 * contient le numéro de l'expéditeur, nécessaire pour répondre).
 */
export interface GedWhatsappItemMetadata {
  messageType: 'document' | 'image';
  mediaId: string;
  mimeType?: string;
  /** Nom annoncé par l'expéditeur (document) — assaini avant tout usage. */
  declaredFilename?: string;
  /** Empreinte SHA-256 annoncée par Meta pour le média (hex), vérifiée au téléchargement. */
  declaredSha256?: string;
  /** Numéro de l'expéditeur, chiffres seulement (E.164 sans `+`). */
  senderPhone: string;
  /** Pseudonyme stable du numéro (HMAC-SHA256 tronqué) : seule forme admise dans les logs. */
  senderHash: string;
  /** Horodatage du message annoncé par Meta (secondes Unix). */
  messageTimestamp: number;
  /** Horodatage de réception par l'API (ISO 8601 UTC). */
  receivedAt: string;
}

/** Préfixe du principal d'un expéditeur WhatsApp dans `rights.principalMap` : `wa:<chiffres>`. */
export const GED_WHATSAPP_PRINCIPAL_PREFIX = 'wa:';

/** Identifiants chiffrés du connecteur (clés de `credentials`). Jamais renvoyés par l'API. */
export const GED_WHATSAPP_CREDENTIAL_KEYS = ['accessToken', 'appSecret', 'verifyToken'] as const;

/** Un expéditeur autorisé (liste blanche) dans `config.senders`. Numéro : 8 à 15 chiffres, sans `+`. */
export interface GedWhatsappSender {
  phone: string;
  /** Libellé libre pour l'administrateur (ex. nom de la personne). */
  label?: string;
}

/**
 * Configuration non secrète du connecteur `whatsapp` (`ged_source_connector.config`, hors clé réservée
 * `rights`). Le groupe DocuPro d'un expéditeur se déclare dans `rights.principalMap`
 * (`"wa:<chiffres>": user_group_id`) ; un expéditeur sans entrée reçoit les groupes de repli
 * `rights.fallbackUserGroupIds` (jamais vide).
 */
export interface GedWhatsappConfig {
  /** Identifiant du numéro WhatsApp Business (Phone Number ID de Meta), chiffres seulement. */
  phoneNumberId: string;
  /** Version de l'API Graph, ex. `v21.0`. */
  graphApiVersion?: string;
  senders: GedWhatsappSender[];
  /** Taille maximale d'un média (octets) ; ne peut que résserrer `GED_CONNECTOR_LIMITS.maxFileBytes`. */
  maxFileBytes?: number;
  /** Envoyer l'accusé de réception « Document reçu » (défaut : oui). */
  ackEnabled?: boolean;
  /** Envoyer un message de refus aux expéditeurs inconnus (défaut : non — aucun message). */
  refuseUnknownSenders?: boolean;
}

/** Chemin public du webhook d'un connecteur (préfixe global `/api` inclus). */
export function gedWhatsappWebhookPath(connectorId: number): string {
  return `/api/ged/webhooks/whatsapp/${connectorId}`;
}
