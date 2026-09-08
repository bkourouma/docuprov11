// Client API + types du module Docu-Courriers. Réutilise les constantes partagées de @archivage/types.
import { MailStatus, MailType, MAIL_STATUS_LABELS, MAIL_TYPE_LABELS } from '@archivage/types';
import { API_BASE, apiJson } from './api';

export { MailStatus, MailType, MAIL_STATUS_LABELS, MAIL_TYPE_LABELS };

export interface MailSummary {
  mailId: number;
  title: string;
  date: string | null;
  nReference: string | null;
  reference: string | null;
  mailType: number;
  status: number;
  valider: boolean;
  validationDirection: boolean;
  validationDG: boolean;
  decharge: boolean;
  dateTraited: string | null;
  dateButoire: string | null;
  createdAt: string;
  // Le détail (GET /courriers/:id) renvoie aussi l'id ; les worklists ne projettent que le libellé.
  externalEntity: { externalEntityId?: number; label: string } | null;
  // Destinataire : un acteur nommé (Départ §12) OU un rôle (Arrivée §05) — jamais les deux.
  destinataire: { user: { fullName: string | null; username: string } } | null;
  destinataireRole: { roleId: number; name: string } | null;
}

/** Libellé du destinataire d'un courrier, quel qu'en soit le genre (rôle ou acteur nommé). */
export const destinataireLabel = (m: {
  destinataire?: { user: { fullName: string | null; username: string } } | null;
  destinataireRole?: { name: string } | null;
}): string =>
  m.destinataireRole?.name || m.destinataire?.user.fullName || m.destinataire?.user.username || '—';

export interface MailListResult {
  total: number;
  page: number;
  pageSize: number;
  rows: MailSummary[];
}

export interface BadgeCounts {
  controle: number;
  validation: number;
  suivi: number;
  /** Personnel : imputations actionnables non traitées (« En Copie » exclu). */
  parapheur: number;
  /** Départs sans document de décharge — non plafonné, contrairement au lookup de l'écran. */
  decharge: number;
  scans: number;
}

export interface MailDocumentLink {
  mailDocumentId: number;
  decharge: boolean;
  document: { documentId: number; label: string } | null;
}

export interface MailInputationView {
  mailInputationId: number;
  userId: number;
  mailInputationTypeId: number;
  instructions: string | null;
  deadline: string | null;
  dateTreated: string | null;
  /** Traçabilité de l'imputation (§08) : qui l'a créée et quand — alimente son historique. */
  createdAt: string | null;
  createdBy: number | null;
  type: { label: string; suivi: boolean } | null;
}

/**
 * Détail complet (GET /courriers/:id) : le back renvoie tous les scalaires + relations, là où la
 * projection de worklist (MailSummary) est volontairement réduite.
 */
export interface MailDetail extends MailSummary {
  description: string | null;
  enregistrementReponse: boolean;
  dateEnregistrementCourrier: string | null;
  dateFollowUp: string | null;
  endDateFollowUp: string | null;
  dateDecharge: string | null;
  mailParent: number | null;
  nature: { label: string } | null;
  confidentialite: { label: string } | null;
  objet: { label: string } | null;
  departType: { label: string } | null;
  organigramme: { label: string } | null;
  inputations: MailInputationView[];
  documents: MailDocumentLink[];
}

export interface RefRow {
  label: string;
}

type Page = { page?: number; pageSize?: number };
const qs = (p?: Page) => `?page=${p?.page ?? 1}&pageSize=${p?.pageSize ?? 25}`;

// ---- Worklists (§03.2/§03.4) ----
export const listControle = (p?: Page) => apiJson<MailListResult>(`/courriers/controle${qs(p)}`);
export const listParapheur = (p?: Page) => apiJson<MailListResult>(`/courriers/parapheur${qs(p)}`);
export const listSuivi = (p?: Page) => apiJson<MailListResult>(`/courriers/suivi${qs(p)}`);
export const listValidationDirection = (p?: Page) =>
  apiJson<MailListResult>(`/courriers/validation-direction${qs(p)}`);
export const listDepart = (p?: Page) => apiJson<MailListResult>(`/courriers/depart${qs(p)}`);
export const getBadges = () => apiJson<BadgeCounts>('/courriers/badges');
/**
 * Détail d'un courrier. `onlyMyImputations` (parapheur §08) demande au serveur de ne renvoyer que
 * les imputations de l'utilisateur et celles qu'il a créées ; c'est le serveur qui décide s'il y
 * échappe (destinataire principal, admin).
 */
export const getMail = (id: number, opts?: { onlyMyImputations?: boolean }) =>
  apiJson<MailDetail>(`/courriers/${id}${opts?.onlyMyImputations ? '?imputations=mine' : ''}`);

// ---- Lookup « Lié au courrier » (§12) ----
export interface MailLinkOption {
  mailId: number;
  nReference: string | null;
  title: string;
  date: string;
  mailType: number;
}
export const listMailsByExternalEntity = (externalEntityId: number) =>
  apiJson<MailLinkOption[]>(`/courriers/by-external-entity/${externalEntityId}`);

// ---- Lookup « Courrier » de l'Intégration décharge (§13) ----
/** Courrier de départ dont la preuve de remise signée n'a pas encore été intégrée. */
export interface DechargeEnAttente {
  mailId: number;
  nReference: string | null;
  title: string;
  date: string;
  externalEntity: { label: string } | null;
}
export const listDechargesEnAttente = () =>
  apiJson<DechargeEnAttente[]>('/courriers/decharges-en-attente');

// ---- Numérotation ----
export const nextArriveeReference = () =>
  apiJson<{ nReference: string }>('/courriers/next-reference/arrivee');
export const nextDepartReference = (typeId: number) =>
  apiJson<{ nReference: string }>(`/courriers/next-reference/depart/${typeId}`);

// ---- Transitions (§06/§08/§10/§13) ----
const post = <T = unknown>(path: string, body?: unknown) =>
  apiJson<T>(path, {
    method: 'POST',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const valider = (id: number) => post(`/courriers/${id}/valider`);
export const dechargeCourrier = (id: number) => post(`/courriers/${id}/decharge`);
export const enregistrementReponse = (id: number) =>
  post(`/courriers/${id}/enregistrement-reponse`);
export const validationDG = (id: number) => post(`/courriers/${id}/validation-dg`);
export const archiver = (id: number) => post(`/courriers/${id}/archiver`);
export const validationDirection = (mailIds: number[]) =>
  post<{ updated: number }>('/courriers/validation-direction', { mailIds });
export const integrateDecharge = (
  id: number,
  body: { documentId?: number; scannedDocumentId?: number },
) => post(`/courriers/${id}/integration-decharge`, body);
export const softDeleteMail = (id: number) => apiJson(`/courriers/${id}`, { method: 'DELETE' });

// ---- Création (§05/§12) ----
export const createArrivee = (body: Record<string, unknown>) => post('/courriers/arrivee', body);
export const createDepart = (body: Record<string, unknown>) => post('/courriers/depart', body);

// ---- Recherche (§11) ----
export interface MailSearchParams {
  fullText?: string;
  mailType?: number;
  status?: number;
  externalEntityId?: number;
  mailNatureId?: number;
  mailObjetId?: number;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sort?: Array<{ field: string; dir: 'asc' | 'desc' }>;
}

/** La recherche (§11) renvoie une projection plate (correspondant/destinataire = libellés). */
export interface MailSearchRow {
  mailId: number;
  title: string;
  nReference: string | null;
  reference: string | null;
  mailType: number;
  status: number;
  date: string | null;
  externalEntity: string | null;
  destinataire: string | null;
}
export interface MailSearchResult {
  total: number;
  page: number;
  pageSize: number;
  rows: MailSearchRow[];
}
export const searchMails = (params: MailSearchParams) =>
  apiJson<MailSearchResult>('/courriers/recherche', {
    method: 'POST',
    body: JSON.stringify(params),
  });

// ---- Imputations (§08/§10) ----
export interface CreateInputationBody {
  mailId: number;
  userGroupId: number;
  mailInputationTypeId: number;
  instructions?: string;
  deadline?: string;
}
export const createInputation = (body: CreateInputationBody) =>
  post('/courriers/imputations', body);
/** Soumission à validation (§08) : imputation de type 5 (DG) ou 14 (Direction), échéance +48 h. */
export const submitValidation = (body: { mailId: number; userGroupId: number; isDG: boolean }) =>
  post('/courriers/imputations/validation', body);
/** Traitement des imputations d'un destinataire donné (§10), sans forcer le statut du courrier. */
export const treatRecipient = (mailId: number, userGroupId: number) =>
  post<{ treated: number }>(`/courriers/${mailId}/imputations/traiter-destinataire`, {
    userGroupId,
  });
/** Validation automatique à la lecture (§08) : traite les imputations « suivi ». */
export const treatOnRead = (mailId: number) => post(`/courriers/${mailId}/imputations/lecture`);
/** « Marquer comme traité » (§08) : traite toutes les imputations puis passe le courrier en Traité. */
export const markTreated = (mailId: number) => post(`/courriers/${mailId}/imputations/traiter`);
/** Suppression d'une imputation (§08) — le back n'autorise que son auteur (`createdBy`). */
export const removeInputation = (mailInputationId: number) =>
  apiJson<{ deleted: true }>(`/courriers/imputations/${mailInputationId}`, { method: 'DELETE' });
export const listInputationTypes = () =>
  apiJson<Array<{ mailInputationTypeId: number; label: string; suivi: boolean }>>(
    '/courriers/referentials/inputation-types',
  );

// ---- Notifications (inbox + badge) ----
export interface NotificationRow {
  notificationId: number;
  message: string;
  targetType: string | null;
  targetId: number | null;
  isRead: boolean;
  createdAt: string;
  readAt: string | null;
}
export interface NotificationList {
  total: number;
  unread: number;
  page: number;
  pageSize: number;
  rows: NotificationRow[];
}
export const listNotifications = (p?: { unreadOnly?: boolean; page?: number; pageSize?: number }) =>
  apiJson<NotificationList>(
    `/notifications?page=${p?.page ?? 1}&pageSize=${p?.pageSize ?? 20}${p?.unreadOnly ? '&unreadOnly=true' : ''}`,
  );
export const unreadNotificationCount = () =>
  apiJson<{ count: number }>('/notifications/unread-count');
export const markNotificationRead = (id: number) =>
  apiJson(`/notifications/${id}/read`, { method: 'PATCH' });
export const markAllNotificationsRead = () =>
  apiJson('/notifications/read-all', { method: 'PATCH' });

// ---- Document GED lié (visionneuse PDF) ----
export interface DocDetail {
  documentId: number;
  label: string;
  currentVersion: { files: Array<{ fileId: number; fileExtension: string }> } | null;
}
export const getDocumentDetail = (documentId: number) =>
  apiJson<DocDetail>(`/documents/${documentId}`);

/** Recherche dans la GED archivée — sert à choisir la décharge signée à intégrer (§13). */
export interface GedDocRow {
  documentId: number;
  label: string;
  documentDate: string | null;
  cote: string | null;
}
export const searchGedDocuments = (fullText: string) =>
  apiJson<{ total: number; rows: GedDocRow[] }>('/documents/search', {
    method: 'POST',
    body: JSON.stringify({ fullText: fullText.trim() || undefined, page: 1, pageSize: 20 }),
  });

/** Récupère le binaire d'un fichier GED et renvoie une object-URL (à révoquer par l'appelant).
 * Renvoie `null` pour toute raison d'échec : réponse non-2xx, serveur injoignable, CORS… */
export async function fetchDocumentBlobUrl(
  documentId: number,
  fileId: number,
): Promise<string | null> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  try {
    const res = await fetch(`${API_BASE}/documents/${documentId}/files/${fileId}/content`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    // TypeError: Failed to fetch — serveur hors ligne, CORS, réseau coupé…
    return null;
  }
}

/** Caractères interdits dans un nom de fichier (Windows compris) — remplacés par « _ ». */
const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'document';

/**
 * Télécharge la pièce courante d'un document GED (« Enregistrer sous »). Renvoie `false` si le
 * document n'a aucun fichier ou si le binaire est introuvable — à l'appelant d'en informer
 * l'utilisateur, plutôt qu'un téléchargement qui échoue en silence.
 */
export async function downloadDocument(documentId: number, label: string): Promise<boolean> {
  const detail = await getDocumentDetail(documentId).catch(() => null);
  const file = detail?.currentVersion?.files[0];
  if (!file) return false;
  const url = await fetchDocumentBlobUrl(documentId, file.fileId);
  if (!url) return false;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFileName(label)}${file.fileExtension ?? ''}`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

// ---- Acteurs (lookup « en copie » §05 / imputé §08) ----
export interface Actor {
  userGroupId: number;
  label: string;
  /** Rôle applicatif (§04, cf. /admin/roles) porté par l'acteur — filtre l'imputé par rôle (§08). */
  roleId: number | null;
}
export const listActors = () => apiJson<Actor[]>('/courriers/actors');

// ---- Rôles destinataires (lookup destinataire §05) ----
/** Un courrier Arrivée est adressé à un rôle ; `userCount` = nombre d'utilisateurs qui le recevront. */
export interface DestinataireRole {
  roleId: number;
  label: string;
  userCount: number;
}
export const listDestinataireRoles = () =>
  apiJson<DestinataireRole[]>('/courriers/destinataire-roles');

// ---- Documents scannés (§07) ----
export interface ScannedDocumentRow {
  mailScannedDocumentId: number;
  fileName: string | null;
  filePath: string | null;
  dateScanned: string;
  machineName: string | null;
  isTraite: boolean;
  mailId: number | null;
  documentId: number | null;
}
export interface ScannedListResult {
  total: number;
  page: number;
  pageSize: number;
  rows: ScannedDocumentRow[];
}
/**
 * Dépôt d'un document dans la file §07 (multipart). Pas d'`apiJson` ici : le corps est un
 * FormData, dont le navigateur doit poser lui-même le Content-Type (avec le boundary).
 */
export async function uploadScannedDocument(file: File): Promise<ScannedDocumentRow> {
  const body = new FormData();
  body.append('file', file);
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  const res = await fetch(`${API_BASE}/courriers/documents-scannes`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(typeof err.message === 'string' ? err.message : `HTTP ${res.status}`);
  }
  return res.json() as Promise<ScannedDocumentRow>;
}

// ---- Saisie automatique par IA (§05) ----
/** Champs proposés par le modèle. `null` = non lu sur le document ; le champ reste à saisir. */
export interface MailAiExtraction {
  title: string | null;
  date: string | null;
  reference: string | null;
  externalEntityId: number | null;
  externalEntityLabel: string | null;
  destinataireRoleId: number | null;
  description: string | null;
}

export const aiExtractionAvailability = () =>
  apiJson<{ enabled: boolean }>('/courriers/extraction-ia/disponibilite');

/**
 * Analyse un courrier numérisé pour pré-remplir le formulaire d'enregistrement. Multipart comme
 * `uploadScannedDocument` (le navigateur pose le Content-Type avec son boundary), mais le binaire
 * n'est pas déposé : l'API le lit et le jette.
 */
export async function extractMailWithAi(file: File): Promise<MailAiExtraction> {
  const body = new FormData();
  body.append('file', file);
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  const res = await fetch(`${API_BASE}/courriers/extraction-ia`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(typeof err.message === 'string' ? err.message : `HTTP ${res.status}`);
  }
  return res.json() as Promise<MailAiExtraction>;
}

// ---- Métadonnées EAV de l'entité externe (§17, saisies depuis le workflow courrier) ----
export interface CustomPropertyRow {
  externalEntityCustomPropertyId: number;
  label: string;
}
export interface CustomValueRow {
  externalEntityCustomValueId: number;
  value: string;
  externalEntityCustomPropertyId: number;
  customProperty: { label: string } | null;
}

/** Propriétés personnalisées actives (colonnes possibles du formulaire de métadonnées). */
export const listCustomProperties = () =>
  apiJson<CustomPropertyRow[]>('/courriers/referentials/custom-properties');

/** Valeurs déjà saisies pour une entité externe. */
export const listCustomValues = (externalEntityId: number) =>
  apiJson<CustomValueRow[]>(
    `/courriers/referentials/external-entities/${externalEntityId}/custom-values`,
  );

/** Upsert d'une valeur ; le serveur déduit le type depuis l'entité. */
export const setCustomValue = (body: {
  externalEntityId: number;
  externalEntityCustomPropertyId: number;
  value: string;
}) => post('/courriers/referentials/custom-values', body);

// ---- Fiche d'Imputation (§09) ----
/** Récupère la fiche en blob ; `pdf` pour l'aperçu/impression, `docx` pour le téléchargement. */
async function fetchFiche(mailId: number, format: 'pdf' | 'docx'): Promise<Blob> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  const suffix = format === 'pdf' ? '/pdf' : '';
  const res = await fetch(`${API_BASE}/courriers/${mailId}/fiche-imputation${suffix}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(typeof err.message === 'string' ? err.message : `HTTP ${res.status}`);
  }
  return res.blob();
}

/** Aperçu PDF de la fiche (§09) — blob URL à révoquer par l'appelant. */
export const ficheImputationPdfUrl = async (mailId: number): Promise<string> =>
  URL.createObjectURL(await fetchFiche(mailId, 'pdf'));

/** Téléchargement de la fiche en DOCX (§09) — le nom vient de l'en-tête du serveur. */
export async function downloadFicheImputation(mailId: number): Promise<void> {
  const blob = await fetchFiche(mailId, 'docx');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `FICHE_IMPUTATION_${mailId}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Aperçu d'un scan : blob URL (le flux exige l'en-tête d'auth, donc pas d'`src` direct). */
export async function fetchScannedBlobUrl(scanId: number): Promise<string | null> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  const res = await fetch(`${API_BASE}/courriers/documents-scannes/${scanId}/content`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

export const listScannedDocuments = (p?: Page) =>
  apiJson<ScannedListResult>(`/courriers/documents-scannes${qs(p)}`);
export const getScannedDocument = (id: number) =>
  apiJson<ScannedDocumentRow>(`/courriers/documents-scannes/${id}`);

// ---- Référentiels de paramétrage : CRUD (§14–§19) ----
/** Fabrique le CRUD d'un référentiel (list / create / update / deactivate). */
function refCrud<T>(base: string) {
  return {
    list: () => apiJson<T[]>(base),
    create: (body: Record<string, unknown>) =>
      apiJson<T>(base, { method: 'POST', body: JSON.stringify(body) }),
    update: (id: number, body: Record<string, unknown>) =>
      apiJson<T>(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    remove: (id: number) => apiJson(`${base}/${id}`, { method: 'DELETE' }),
  };
}

export interface MailNatureRow {
  mailNatureId: number;
  label: string;
}
export interface MailObjetRow {
  mailObjetId: number;
  label: string;
  dureeSuiviExterne: number;
  dureeSuiviInterne: number;
}
export interface MailInputationTypeRow {
  mailInputationTypeId: number;
  label: string;
  suivi: boolean;
}
export interface MailDepartTypeRow {
  mailDepartTypeId: number;
  label: string;
}
export interface MailConfidentialiteRow {
  mailConfidentialiteId: number;
  label: string;
}
export interface ExternalEntityTypeRow {
  externalEntityTypeId: number;
  label: string;
}
export interface ExternalEntityRow {
  externalEntityId: number;
  label: string;
  email: string | null;
  telephone: string | null;
  externalEntityTypeId: number | null;
  externalEntityType: { label: string } | null;
}

export const mailNaturesApi = refCrud<MailNatureRow>('/courriers/referentials/natures');
export const mailObjetsApi = refCrud<MailObjetRow>('/courriers/referentials/objets');
export const inputationTypesApi = refCrud<MailInputationTypeRow>(
  '/courriers/referentials/inputation-types',
);
export const departTypesApi = refCrud<MailDepartTypeRow>('/courriers/referentials/depart-types');
export const confidentialitesApi = refCrud<MailConfidentialiteRow>(
  '/courriers/referentials/confidentialites',
);
export const externalEntityTypesApi = refCrud<ExternalEntityTypeRow>(
  '/courriers/referentials/external-entity-types',
);
export const externalEntitiesApi = refCrud<ExternalEntityRow>(
  '/courriers/referentials/external-entities',
);

// Lookups (alias des `list` ci-dessus, utilisés par les écrans de saisie §05/§11/§12).
export const listMailNatures = () => mailNaturesApi.list();
export const listMailObjets = () => mailObjetsApi.list();
export const listMailDepartTypes = () => departTypesApi.list();
export const listMailConfidentialites = () => confidentialitesApi.list();
export const listExternalEntities = () => externalEntitiesApi.list();

// ---- Organigramme (§14) + assignation rôle (§15) ----
export interface OrganigrammeNode {
  organigrammeId: number;
  parentId: number | null;
  label: string;
  depth: number;
  path: string;
}
export const listOrganigramme = () => apiJson<OrganigrammeNode[]>('/courriers/organigramme');
export const createOrganigramme = (body: { label: string; parentId?: number }) =>
  apiJson<OrganigrammeNode>('/courriers/organigramme', {
    method: 'POST',
    body: JSON.stringify(body),
  });
export const updateOrganigramme = (id: number, label: string) =>
  apiJson(`/courriers/organigramme/${id}`, { method: 'PATCH', body: JSON.stringify({ label }) });
export const reparentOrganigramme = (id: number, parentId: number | null) =>
  apiJson(`/courriers/organigramme/${id}/parent`, {
    method: 'PATCH',
    body: JSON.stringify({ parentId }),
  });
export const deleteOrganigramme = (id: number) =>
  apiJson(`/courriers/organigramme/${id}`, { method: 'DELETE' });

export interface RoleAssignmentRow {
  roleId: number;
  name: string;
  organigrammeId: number | null;
  organigramme: { label: string } | null;
}
export const listRoleAssignments = () =>
  apiJson<RoleAssignmentRow[]>('/courriers/organigramme/role-assignments');
export const assignRoleOrganigramme = (roleId: number, organigrammeId: number | null) =>
  apiJson(`/courriers/organigramme/roles/${roleId}`, {
    method: 'PATCH',
    body: JSON.stringify({ organigrammeId }),
  });
