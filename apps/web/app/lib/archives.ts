// Client API + types du portage Docu-Archives (cycle de vie, métadonnées, prêts).
// Réutilise les constantes partagées de @archivage/types plutôt que de redéclarer les états.
import {
  DocumentState,
  DOCUMENT_STATE_LABELS,
  MetaDataType,
  METADATA_TYPE_LABELS,
  METADATA_TYPE_OPTIONS,
} from '@archivage/types';
import { apiJson } from './api';

export {
  DocumentState,
  DOCUMENT_STATE_LABELS,
  MetaDataType,
  METADATA_TYPE_LABELS,
  METADATA_TYPE_OPTIONS,
};

const SETTINGS = '/archives/settings';

/** Réponse commune des créations en masse (le back crée ce qu'il peut et dit ce qu'il a ignoré). */
export interface BulkCreateResult {
  created: number;
  skipped: string[];
}

/** Message d'issue d'une création en masse, prêt à afficher. */
export function bulkMessage(result: BulkCreateResult, singular: string, plural: string): string {
  const parts: string[] = [];
  if (result.created > 0) parts.push(`${result.created} ${result.created > 1 ? plural : singular}`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} ignoré(s) (doublon)`);
  return parts.length ? parts.join(' — ') : 'Rien à créer';
}

// ---------------------------------------------------------------------------
// Référentiels plats (modes de destruction, sorts finaux, motifs de prêt)
// ---------------------------------------------------------------------------

export interface DestructionModeRow {
  destructionModeId: number;
  label: string;
}
export interface FinalFateRow {
  finalFateId: number;
  label: string;
}
export interface LendingMotiveRow {
  lendingMotiveId: number;
  label: string;
}

/** Fabrique du client CRUD des référentiels plats : même contrat, trois chemins. */
function refApi<T>(path: string) {
  return {
    list: () => apiJson<T[]>(`${SETTINGS}/${path}`),
    create: (labels: string[]) =>
      apiJson<BulkCreateResult>(`${SETTINGS}/${path}`, {
        method: 'POST',
        body: JSON.stringify({ labels }),
      }),
    update: (id: number, label: string) =>
      apiJson<T>(`${SETTINGS}/${path}/${id}`, { method: 'PATCH', body: JSON.stringify({ label }) }),
    remove: (ids: number[]) =>
      apiJson<{ deactivated: number }>(`${SETTINGS}/${path}`, {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      }),
  };
}

export const destructionModesApi = refApi<DestructionModeRow>('destruction-modes');
export const finalFatesApi = refApi<FinalFateRow>('final-fates');
export const lendingMotivesApi = refApi<LendingMotiveRow>('lending-motives');

// ---------------------------------------------------------------------------
// §1 Paramétrage des types de documents
// ---------------------------------------------------------------------------

/** Rangement par défaut d'un type : où la pièce va (dossier) et de quoi elle relève (plan). */
/**
 * Consigne de numérisation d'un type — DOCUMENTAIRE : V6 ne pilote aucun scanner. L'OCR
 * réellement exécuté dépend du mode du lot d'acquisition, pas de ces champs.
 */
export interface ScanningSettings {
  ocr: boolean;
  cryptage: boolean;
  /** Pourcentage 1..100. */
  tauxCompression: number | null;
  profilScanner: string | null;
  routines: string | null;
}

export interface DocumentTypeSettingRow extends ScanningSettings {
  documentTypeSettingId: number;
  documentTypeId: number;
  dossierId: number | null;
  planId: number | null;
  confidentialiteId: number | null;
  documentType: { documentTypeId: number; label: string };
  dossier: { label: string; code: string | null } | null;
  plan: { label: string; code: string | null } | null;
  confidentialite: { label: string } | null;
}

export interface DocumentTypeSettingInput extends Partial<ScanningSettings> {
  documentTypeId: number;
  dossierId?: number | null;
  planId?: number | null;
  confidentialiteId?: number | null;
}

/** Niveau de confidentialité — référentiel ORDONNÉ : `rank` porte la règle d'accès. */
export interface ConfidentialiteOption {
  confidentialiteId: number;
  label: string;
  rank: number;
}

export const documentTypeSettingsApi = {
  list: () => apiJson<DocumentTypeSettingRow[]>(`${SETTINGS}/document-types`),
  /** Crée OU met à jour : la clé métier est le type de document lui-même. */
  save: (body: DocumentTypeSettingInput) =>
    apiJson<DocumentTypeSettingRow>(`${SETTINGS}/document-types`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  remove: (ids: number[]) =>
    apiJson<{ deleted: number }>(`${SETTINGS}/document-types`, {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
  /** Défauts d'archivage d'un type — à consommer par le formulaire d'indexation. */
  defaults: (documentTypeId: number) =>
    apiJson<DocumentTypeSettingRow | null>(
      `${SETTINGS}/document-types/${documentTypeId}/defaults`,
    ),
};

// ---------------------------------------------------------------------------
// §3 Cycles de vie
// ---------------------------------------------------------------------------

/** Durées en MOIS (contrat serveur, inchangé) — l'écran les convertit en années à l'affichage. */
export interface DocumentTypeLifeCycleRow {
  documentTypeLifeCycleId: number;
  documentTypeId: number;
  usefulnessLifespan: number;
  complianceLifespan: number;
  finalFateId: number | null;
  destructionModeId: number | null;
  documentType: { documentTypeId: number; label: string };
  finalFate: { label: string } | null;
  destructionMode: { label: string } | null;
}

/** Idem : `usefulnessLifespan`/`complianceLifespan` attendus en MOIS par le serveur. */
export interface DocumentTypeLifeCycleInput {
  documentTypeId: number;
  usefulnessLifespan: number;
  complianceLifespan: number;
  finalFateId?: number | null;
  destructionModeId?: number | null;
}

export const lifeCyclesApi = {
  list: () => apiJson<DocumentTypeLifeCycleRow[]>(`${SETTINGS}/life-cycles`),
  save: (body: DocumentTypeLifeCycleInput) =>
    apiJson<DocumentTypeLifeCycleRow>(`${SETTINGS}/life-cycles`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  remove: (ids: number[]) =>
    apiJson<{ deleted: number }>(`${SETTINGS}/life-cycles`, {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
};

// ---------------------------------------------------------------------------
// §8 / §9 Métadonnées et valeurs de liste
// ---------------------------------------------------------------------------

export interface MetaDataRow {
  metaDataId: number;
  label: string;
  dataType: number;
  /** Nombre de valeurs de liste actives — nul hors métadonnées de type Liste. */
  listItemCount: number;
}

export interface MetaDataListItemRow {
  metaDataListItemId: number;
  metaDataId: number;
  label: string;
  metaData: { metaDataId: number; label: string; dataType: number };
}

export const metaDatasApi = {
  list: () => apiJson<MetaDataRow[]>(`${SETTINGS}/metadatas`),
  create: (metaDatas: Array<{ label: string; dataType: number }>) =>
    apiJson<BulkCreateResult>(`${SETTINGS}/metadatas`, {
      method: 'POST',
      body: JSON.stringify({ metaDatas }),
    }),
  update: (id: number, body: { label?: string; dataType?: number }) =>
    apiJson<MetaDataRow>(`${SETTINGS}/metadatas/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (ids: number[]) =>
    apiJson<{ deactivated: number }>(`${SETTINGS}/metadatas`, {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
};

export const metaDataListItemsApi = {
  list: (metaDataId?: number) =>
    apiJson<MetaDataListItemRow[]>(
      `${SETTINGS}/metadata-list-items${metaDataId ? `?metaDataId=${metaDataId}` : ''}`,
    ),
  create: (metaDataId: number, labels: string[]) =>
    apiJson<BulkCreateResult>(`${SETTINGS}/metadata-list-items`, {
      method: 'POST',
      body: JSON.stringify({ metaDataId, labels }),
    }),
  update: (id: number, body: { label?: string; metaDataId?: number }) =>
    apiJson<MetaDataListItemRow>(`${SETTINGS}/metadata-list-items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (ids: number[]) =>
    apiJson<{ deactivated: number }>(`${SETTINGS}/metadata-list-items`, {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
};

// ---------------------------------------------------------------------------
// §7 Métadonnées par type de document
// ---------------------------------------------------------------------------

export interface MetaDataDocumentTypeRow {
  metaDataDocumentTypeId: number;
  documentTypeId: number;
  metaDataId: number;
  documentType: { documentTypeId: number; label: string };
  metaData: { metaDataId: number; label: string; dataType: number };
}

export interface MetaDataTypeSummary {
  documentTypeId: number;
  documentType: string;
  metaDatas: Array<{ metaDataId: number; label: string; dataType: number }>;
}

export const metaDataDocumentTypesApi = {
  list: () => apiJson<MetaDataDocumentTypeRow[]>(`${SETTINGS}/metadata-document-types`),
  summary: () => apiJson<MetaDataTypeSummary[]>(`${SETTINGS}/metadata-document-types/summary`),
  /** Produit cartésien types × métadonnées ; les couples déjà en place sont simplement comptés. */
  link: (documentTypeIds: number[], metaDataIds: number[]) =>
    apiJson<{ created: number; alreadyLinked: number }>(`${SETTINGS}/metadata-document-types`, {
      method: 'POST',
      body: JSON.stringify({ documentTypeIds, metaDataIds }),
    }),
  /** Remplace la liste des métadonnées d'UN type (ce qui n'est plus listé est délié). */
  setForType: (documentTypeId: number, metaDataIds: number[]) =>
    apiJson<{ linked: number; created: number }>(`${SETTINGS}/metadata-document-types`, {
      method: 'PUT',
      body: JSON.stringify({ documentTypeId, metaDataIds }),
    }),
  unlink: (ids: number[]) =>
    apiJson<{ deleted: number }>(`${SETTINGS}/metadata-document-types`, {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
  /** Champs du formulaire dynamique d'indexation d'un type (usage aval). */
  fields: (documentTypeId: number) =>
    apiJson<MetaDataField[]>(`${SETTINGS}/metadata-document-types/${documentTypeId}/fields`),
};

/** Un champ du formulaire dynamique d'indexation : quoi afficher, et avec quelles valeurs. */
export interface MetaDataField {
  metaDataId: number;
  label: string;
  dataType: number;
  /** Renseigné uniquement pour `MetaDataType.Liste`. */
  options: Array<{ metaDataListItemId: number; label: string }>;
}

/**
 * Valeur saisie d'un champ, telle qu'échangée avec le serveur (PATCH indexation / lecture du lot).
 * `value` porte toutes les saisies sauf les listes, identifiées par `metaDataListItemId` ;
 * les deux à `null` signifient « champ vidé ».
 */
export interface MetaDataValue {
  metaDataId: number;
  value?: string | null;
  metaDataListItemId?: number | null;
}

// ---------------------------------------------------------------------------
// Détail d'un document archivé (page `/documents/:id`)
// ---------------------------------------------------------------------------

/**
 * Détail complet d'un document — labels de classement RÉSOLUS (pas seulement les IDs) : à la
 * différence d'une liste déjà chargée (recherche, lot d'acquisition), une page ouverte en direct
 * (favori, lien partagé) ne dispose d'aucun référentiel préchargé pour les traduire elle-même.
 */
export interface DocumentDetail {
  documentId: number;
  label: string;
  cote: string | null;
  documentDate: string | null;
  /** Date d'enregistrement système (`created_at`) — toujours renseignée, à la différence de `documentDate`. */
  createdAt: string;
  documentTypeId: number | null;
  documentType: { documentTypeId: number; label: string } | null;
  planId: number | null;
  plan: { planId: number; label: string; code: string | null } | null;
  dossierId: number | null;
  dossier: { dossierId: number; label: string } | null;
  confidentialiteId: number | null;
  confidentialite: { confidentialiteId: number; label: string; rank: number } | null;
  isArchived: boolean;
  isFrozen: boolean;
  metadataValues: MetaDataValue[];
  currentVersion: {
    files: Array<{ fileId: number; originalName: string; fileExtension: string; pageCount: number | null }>;
  } | null;
  /**
   * Niveau de permission EFFECTIF de l'utilisateur courant sur CE document (2026-08-04) : 2
   * Consultation, 3 Modification, 4 Administration, 5 Archivistique — jamais 1 (Denied), qui
   * signifierait qu'on n'aurait pas dû atteindre cette page. `null` seulement si le document a
   * disparu entre la vérification d'accès et le calcul (cas limite, à traiter comme Consultation).
   */
  effectivePermissionLevel: number | null;
}

/** Corps du PATCH d'indexation — le classement ET les métadonnées, en un seul envoi. */
export interface IndexationInput {
  label?: string;
  documentTypeId?: number | null;
  planId?: number | null;
  dossierId?: number | null;
  documentDate?: string | null;
  metadataValues?: MetaDataValue[];
}

/**
 * Cycle de vie d'un document sur DEUX plans : la règle de son type (en mois, avec les échéances
 * qu'elle implique) et la dérogation propre au document (des dates), qui l'emporte quand elle
 * existe. Les deux sont fournis côte à côte pour que l'écran montre l'écart.
 */
export interface DocumentLifeCycleView {
  /** Point de départ du décompte : date métier, à défaut date d'enregistrement. */
  startDate: string;
  typeRule: {
    usefulnessLifespanMonths: number;
    complianceLifespanMonths: number;
    finalFate: { finalFateId: number; label: string } | null;
    destructionMode: { destructionModeId: number; label: string } | null;
    projectedUsefulness: string;
    projectedCompliance: string;
  } | null;
  documentLifeCycle: {
    documentLifeCycleId: number;
    usefulnessLifespan: string;
    complianceLifespan: string;
    observations: string | null;
    finalFateId: number | null;
    destructionModeId: number | null;
    finalFate: { label: string } | null;
    destructionMode: { label: string } | null;
  } | null;
}

export interface DocumentLifeCycleInput {
  usefulnessLifespan: string;
  complianceLifespan: string;
  observations?: string;
  finalFateId?: number | null;
  destructionModeId?: number | null;
}

export interface DocumentPermissionRow {
  documentPermissionId: number;
  permissionLevelId: number;
  permissionLevelName: string;
  /** `user` = acteur nommé, `group` = profil entier — les deux vivent dans la même table. */
  scope: 'user' | 'group';
  userGroupId: number | null;
  label: string;
  groupName: string | null;
  grantedAt: string;
  startDate: string | null;
  endDate: string | null;
}

/**
 * État du cachet serveur (signature Ed25519 + horodatage).
 *
 * `signatureValid` et `contentMatches` sont VOLONTAIREMENT distincts : une signature authentique
 * sur un contenu qui a changé n'est pas une falsification du cachet, c'est un document modifié
 * depuis son scellement. `null` sur les deux = clé inconnue, donc rien de vérifiable.
 */
export interface DocumentSealView {
  sealed: boolean;
  algorithm?: string;
  /** Date SIGNÉE (celle de la charge), pas celle de la colonne — c'est elle qui fait foi. */
  sealedAt?: string;
  keyFingerprint?: string;
  knownKey?: boolean;
  signatureValid?: boolean | null;
  contentMatches?: boolean | null;
  /** `false` = la date stockée diverge de la date signée : horodatage retouché en base. */
  timestampMatches?: boolean | null;
}

/** État d'intégrité d'un document : ce que la dernière vérification a conclu. */
export interface DocumentIntegrityView {
  dateLastVerified: string | null;
  /** `null` = jamais vérifié, ou document sans fichier (rien à vérifier). */
  integrityOk: boolean | null;
  seal: { algorithm: string; keyFingerprint: string; sealedAt: string } | null;
  files: Array<{
    fileId: number;
    originalName: string | null;
    vaultName: string;
    byteLength: number | null;
    hash: string | null;
    hashComputedAt: string | null;
  }>;
}

export interface DocumentIntegrityResult {
  dateLastVerified: string;
  integrityOk: boolean | null;
  files: Array<{
    fileId: number;
    originalName: string | null;
    vaultName: string;
    exists: boolean;
    /** `imprinted` = empreinte de référence posée à ce passage (fonds antérieur). */
    status: 'ok' | 'mismatch' | 'missing' | 'imprinted';
  }>;
}

export interface DocumentHistoryRow {
  key: string;
  at: string;
  kind: 'change' | 'visit';
  action: string;
  details: string | null;
  actor: string | null;
}

/**
 * Couverture d'intégrité du FONDS (et non d'un document) — écran « Intégrité du fonds ».
 *
 * `fichiersAvecEmpreinte` et `verifies` ne disent pas la même chose : une empreinte rend la pièce
 * mesurable (elle est posée à l'ingestion depuis le 2026-09-15), une vérification constate qu'elle
 * est encore conforme. Un fonds peut être entièrement mesurable sans avoir jamais été mesuré.
 */
export interface IntegrityCoverage {
  documents: number;
  fichiers: number;
  fichiersAvecEmpreinte: number;
  jamaisVerifies: number;
  verifies: number;
  conformes: number;
  nonConformes: number;
  scelles: number;
}

export interface IntegritySweepResult {
  traites: number;
  conformes: number;
  nonConformes: number;
  empreintesPosees: number;
  echecs: { documentId: number; erreur: string }[];
  /** Documents encore jamais vérifiés après ce passage — de quoi savoir s'il faut relancer. */
  restants: number;
}

/**
 * Résultat d'une tranche de scellement en lot. `examines` peut dépasser `scelles` en cas d'échec
 * sur une pièce — un document sans binaire lisible, par exemple — sans que le lot s'interrompe.
 */
export interface SealFondsResult {
  examines: number;
  scelles: number;
  echecs: { documentId: number; erreur: string }[];
  /** Documents encore jamais scellés après cette tranche. */
  restants: number;
}

export interface NonCompliantRow {
  documentId: number;
  label: string;
  dateLastVerified: string | null;
}

export const documentsApi = {
  detail: (documentId: number) => apiJson<DocumentDetail>(`/documents/${documentId}`),
  /** Réindexation complète : classement + métadonnées (onglet « Indexation »). */
  index: (documentId: number, body: IndexationInput) =>
    apiJson<{ documentId: number; isArchived: boolean }>(`/documents/${documentId}/indexation`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /** Suppression définitive (base + binaire disque) — réservée à l'administrateur. */
  remove: (documentId: number) =>
    apiJson<{ deleted: boolean }>(`/documents/${documentId}`, { method: 'DELETE' }),

  /**
   * Niveau de confidentialité du document. Endpoint DÉDIÉ et non le PATCH d'indexation : le
   * contrat de `indexationSchema` est `.strict()` côté serveur et n'accepte pas ce champ — la
   * confidentialité relève de la sécurité, elle a sa propre route (`PUT /documents/:id/confidentialite`).
   */
  setConfidentialite: (documentId: number, confidentialiteId: number | null) =>
    apiJson<{ confidentialiteId: number | null }>(`/documents/${documentId}/confidentialite`, {
      method: 'PUT',
      body: JSON.stringify({ confidentialiteId }),
    }),

  lifeCycle: (documentId: number) =>
    apiJson<DocumentLifeCycleView>(`/documents/${documentId}/life-cycle`),
  saveLifeCycle: (documentId: number, body: DocumentLifeCycleInput) =>
    apiJson(`/documents/${documentId}/life-cycle`, { method: 'PUT', body: JSON.stringify(body) }),

  permissions: (documentId: number) =>
    apiJson<DocumentPermissionRow[]>(`/documents/${documentId}/permissions`),
  /** Un bénéficiaire OU l'autre : le serveur refuse les deux à la fois (CHECK `ck_dp_grantee`). */
  grantPermission: (
    documentId: number,
    body: {
      userGroupId?: number;
      groupId?: number;
      permissionLevelId: number;
      startDate?: string;
      endDate?: string;
    },
  ) => apiJson(`/documents/${documentId}/permissions`, { method: 'POST', body: JSON.stringify(body) }),
  revokePermission: (documentId: number, permissionId: number) =>
    apiJson(`/documents/${documentId}/permissions/${permissionId}`, { method: 'DELETE' }),

  integrity: (documentId: number) =>
    apiJson<DocumentIntegrityView>(`/documents/${documentId}/integrity`),
  verifyIntegrity: (documentId: number) =>
    apiJson<DocumentIntegrityResult>(`/documents/${documentId}/integrity/verify`, { method: 'POST' }),

  seal: (documentId: number) => apiJson<DocumentSealView>(`/documents/${documentId}/seal`),
  applySeal: (documentId: number) =>
    apiJson<{ algorithm: string; keyFingerprint: string; sealedAt: string }>(
      `/documents/${documentId}/seal`,
      { method: 'POST' },
    ),
  /** Clé publique de l'installation — de quoi vérifier un cachet hors de l'application. */
  sealingPublicKey: () =>
    apiJson<{ algorithm: string; fingerprint: string; publicKeyPem: string }>(
      '/documents/sealing/public-key',
    ),

  // --- Écran « Intégrité du fonds » : contrôle en lot (2026-09-15) ---
  integrityCoverage: () => apiJson<IntegrityCoverage>('/documents/integrity/coverage'),
  integrityNonCompliant: () =>
    apiJson<NonCompliantRow[]>('/documents/integrity/non-compliant'),
  /** Balaie une tranche du fonds. Relancer reprend là où le passage précédent s'est arrêté. */
  sweepIntegrity: (limit: number) =>
    apiJson<IntegritySweepResult>('/documents/integrity/sweep', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  /** Scelle une tranche des documents jamais scellés (rattrapage du fonds antérieur). */
  sealFonds: (limit: number) =>
    apiJson<SealFondsResult>('/documents/integrity/seal-fonds', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),

  history: (documentId: number) => apiJson<DocumentHistoryRow[]>(`/documents/${documentId}/history`),
};

// ---------------------------------------------------------------------------
// DUA expirés / documents épurés
// ---------------------------------------------------------------------------

export interface ComplianceRow {
  documentId: number;
  label: string;
  cote: string | null;
  documentDate: string | null;
  documentTypeName: string | null;
  dossierName: string | null;
  finalFateName: string | null;
  destructionModeName: string | null;
  startDate: string | null;
  usefulnessLifespan: string | null;
  complianceLifespan: string | null;
  documentState: number;
}

export interface ComplianceResult {
  total: number;
  page: number;
  pageSize: number;
  /** Date de coupure appliquée par le serveur — affichée pour rendre le périmètre explicite. */
  cutoff: string;
  rows: ComplianceRow[];
}

export interface ListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  sorting?: string;
  sortDirection?: 'asc' | 'desc';
}

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const complianceApi = {
  /** `monthsAhead` ouvre une fenêtre d'anticipation (0 = strictement échu). */
  expired: (p: ListQuery & { monthsAhead?: number } = {}) =>
    apiJson<ComplianceResult>(`/archives/dua-expired${query({ ...p })}`),
  purged: (p: ListQuery = {}) => apiJson<ComplianceResult>(`/archives/purged${query({ ...p })}`),
  /** Bascule les documents à l'état « Épuré ». Les documents encore prêtés sont refusés. */
  purge: (documentIds: number[]) =>
    apiJson<{ purged: number; blocked: Array<{ documentId: number; label: string }> }>(
      '/archives/dua-expired/purge',
      { method: 'POST', body: JSON.stringify({ documentIds }) },
    ),
};

// ---------------------------------------------------------------------------
// Prêts / communications
// ---------------------------------------------------------------------------

export interface LendableDocument {
  documentId: number;
  label: string;
  cote: string | null;
  documentDate: string | null;
  documentTypeName: string | null;
}

export interface LendingRow {
  lendingDocumentId: number;
  lendingDocumentDetailId: number;
  documentId: number;
  documentLabel: string;
  documentCote: string | null;
  fullName: string;
  lendingMotiveName: string | null;
  startDate: string;
  projectedReturnDate: string | null;
  returnedDate: string | null;
  /** Non rendu et date de retour prévue dépassée. */
  isOverdue: boolean;
}

export interface LendingResult {
  total: number;
  page: number;
  pageSize: number;
  rows: LendingRow[];
}

export interface CreateLendingInput {
  documentIds: number[];
  userGroupId: number;
  lendingMotiveId: number;
  startDate: string;
  projectedReturnDate: string;
}

export const lendingsApi = {
  /** Documents communicables d'un dossier (déjà prêtés, épurés et gelés exclus). */
  lendableDocuments: (dossierId: number) =>
    apiJson<LendableDocument[]>(`/archives/lendings/dossiers/${dossierId}/documents`),
  create: (body: CreateLendingInput) =>
    apiJson<{ lendingDocumentId: number }>('/archives/lendings', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  out: (p: ListQuery = {}) => apiJson<LendingResult>(`/archives/lendings/out${query({ ...p })}`),
  mine: (p: ListQuery = {}) => apiJson<LendingResult>(`/archives/lendings/mine${query({ ...p })}`),
  history: (p: ListQuery = {}) =>
    apiJson<LendingResult>(`/archives/lendings/history${query({ ...p })}`),
  returnDetail: (lendingDocumentDetailId: number) =>
    apiJson<{ lendingClosed: boolean }>(
      `/archives/lendings/details/${lendingDocumentDetailId}/return`,
      { method: 'POST' },
    ),
};

// ---------------------------------------------------------------------------
// Lookups partagés (référentiels V6 existants)
// ---------------------------------------------------------------------------

export interface DocumentTypeOption {
  documentTypeId: number;
  label: string;
}
export interface DossierOption {
  dossierId: number;
  parentId: number | null;
  label: string;
  /** Cote du dossier — affichée devant le libellé et servant de clé de tri. */
  code: string | null;
  depth: number;
}
export interface PlanOption {
  planId: number;
  parentId: number | null;
  label: string;
  /** Cote décimale de la rubrique (« 2.1 ») : c'est elle qui porte l'ordre du plan. */
  code: string | null;
}
export interface LocationOption {
  locationId: number;
  parentId: number | null;
  label: string;
}
/** Acteur (compte + groupe) : bénéficiaire possible d'un prêt. Lookup partagé avec Docu-Courriers. */
export interface ActorOption {
  userGroupId: number;
  label: string;
}

export const lookups = {
  documentTypes: () => apiJson<DocumentTypeOption[]>('/referentials/document-types'),
  dossiers: () => apiJson<DossierOption[]>('/referentials/dossiers'),
  plans: () => apiJson<PlanOption[]>('/referentials/plans'),
  /** Niveaux de confidentialité actifs, du plus ouvert au plus restreint (`rank` croissant). */
  confidentialites: () => apiJson<ConfidentialiteOption[]>('/referentials/confidentialites'),
  locations: () => apiJson<LocationOption[]>('/referentials/locations'),
  actors: () => apiJson<ActorOption[]>('/courriers/actors'),
};
