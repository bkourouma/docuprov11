import type {
  GedAiDecisionStatus,
  GedAiMode,
  GedAiProviderKind,
  GedAiTask,
} from '@archivage/types';

/**
 * Contrat de la couche IA de l'API (lot 1). Les fournisseurs (`local`, `cloud`, `disabled`) et le
 * service (`AiService`) s'écrivent contre ces types ; les appelants (extraction courrier, futurs
 * lots GED) n'importent QUE `AiService` et ces types, jamais un fournisseur.
 */

/** Pièce jointe binaire d'une requête (image ou PDF). Un binaire ne peut PAS être masqué. */
export interface AiAttachment {
  kind: 'image' | 'pdf';
  filename?: string;
  /** `image/png`, `application/pdf`, … */
  mediaType: string;
  data: Buffer;
}

export interface AiCompletionRequest {
  /** Consigne système, rédigée par l'application : jamais masquée. */
  system: string;
  /** Texte utilisateur : c'est LUI qui est masqué avant envoi cloud. */
  text: string;
  attachments?: AiAttachment[];
  /** Sortie structurée stricte (JSON Schema). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
}

export interface AiCompletionResult {
  /** Texte brut renvoyé par le modèle (JSON sérialisé si `jsonSchema`). */
  text: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Interface UNIQUE de tous les fournisseurs. Aucun ne lit la base : tout est injecté à la création. */
export interface AiModelProvider {
  readonly kind: GedAiProviderKind;
  /** `ollama`, `vllm`, `openai`, … ou `disabled`. */
  readonly name: string;
  /** Modèle génératif. */
  readonly model: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
  /** Vecteurs de dimension `GED_EMBEDDING_DIMENSION` (1024), dans l'ordre de `texts`. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Fournisseur « désactivé » : toute opération lève `AiDisabledError`. */
export class AiDisabledError extends Error {
  readonly code = 'AI_DISABLED';
  constructor(message = 'IA désactivée') {
    super(message);
    this.name = 'AiDisabledError';
  }
}

/** Cloud sans masquage possible (masquage coupé, ou binaire joint) : l'envoi est REFUSÉ. */
export class AiMaskingRequiredError extends Error {
  readonly code = 'AI_MASKING_REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'AiMaskingRequiredError';
  }
}

/** Entrée que le fournisseur ne sait pas traiter (ex. PDF vers un modèle local). */
export class AiUnsupportedInputError extends Error {
  readonly code = 'AI_UNSUPPORTED_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'AiUnsupportedInputError';
  }
}

/** Échec d'appel (réseau, quota, réponse invalide). Le message ne contient JAMAIS de clé. */
export class AiProviderError extends Error {
  readonly code = 'AI_PROVIDER_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** Configuration IA effective, lue dans `ged_ai_setting` (ligne absente ou mode 0 = IA désactivée). */
export interface AiEffectiveConfig {
  mode: GedAiMode;
  provider: string | null;
  model: string | null;
  embeddingModel: string | null;
  embeddingDimension: number;
  endpoint: string | null;
  apiKeyRef: string | null;
  maskingEnabled: boolean;
  /** 0..1 ou `null` (= toute décision attend une validation humaine). */
  autoApplyThreshold: number | null;
  timeoutSeconds: number;
}

export interface AiRunOptions<T> {
  task: GedAiTask;
  request: AiCompletionRequest;
  /** Parse + valide `AiCompletionResult.text` ; lève si inexploitable. */
  parse: (raw: string) => T;
  /** Score 0..1 déduit de la sortie ; absent/`null` = pas de score (jamais d'application auto). */
  confidence?: (parsed: T) => number | null;
  documentId?: number | null;
  sourceItemId?: number | null;
  /** `user_group_id` de l'auteur. */
  requestedBy?: number | null;
  promptVersion?: string;
  /** `false` : la décision reste « proposée » quel que soit le score (ex. pré-remplissage courrier). */
  autoApply?: boolean;
  /**
   * Mode LOCAL uniquement : autorise explicitement l'envoi des pièces jointes (images) au modèle
   * local, même si le masquage est actif (un binaire ne peut pas être masqué). Sans cette option,
   * une pièce jointe est refusée (`AiMaskingRequiredError`) quand le masquage est activé. En cloud,
   * toute pièce jointe est TOUJOURS refusée : l'option est ignorée.
   */
  allowLocalAttachments?: boolean;
  /**
   * Délai plancher (secondes) : le délai d'appel effectif est `max(timeoutSeconds, minTimeoutSeconds)`,
   * par exemple pour une extraction courrier avec pièce jointe volumineuse.
   */
  minTimeoutSeconds?: number;
}

export type AiRunResult<T> =
  | { disabled: true; message: string }
  | {
      disabled: false;
      data: T;
      /** `null` si l'écriture du journal a échoué (l'appel, lui, a réussi). */
      decisionId: bigint | null;
      status: GedAiDecisionStatus;
      confidence: number | null;
      provider: string;
      model: string;
    };

export type AiEmbedResult =
  | { disabled: true; message: string }
  | { disabled: false; vectors: number[][]; model: string; dimension: number };

export interface AiStatus {
  enabled: boolean;
  mode: GedAiMode;
  message?: string;
}

/**
 * Entrée de `AiDecisionService.record` — une ligne de `ged_ai_decision`. `inputText` est le texte
 * RÉELLEMENT envoyé (déjà masqué) : le service en tire l'extrait tronqué et le SHA-256.
 */
export interface AiDecisionRecordInput {
  task: GedAiTask;
  /** Mode en vigueur : 1 locale, 2 cloud (jamais 0 : le CHECK SQL l'interdit). */
  mode: 1 | 2;
  provider: string | null;
  model: string;
  promptVersion?: string | null;
  inputText: string;
  /** Empreintes SHA-256 hex des binaires joints, intégrées au hash d'entrée. */
  attachmentHashes?: string[];
  inputMasked: boolean;
  output: unknown;
  confidence: number | null;
  status: GedAiDecisionStatus;
  documentId?: number | null;
  sourceItemId?: number | null;
  requestedBy?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  durationMs?: number | null;
  errorMessage?: string | null;
}
