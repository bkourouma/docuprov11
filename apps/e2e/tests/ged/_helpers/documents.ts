/**
 * Aides GED : fabrication d'un document PDF, de ses versions, de son cachet, et d'utilisateurs
 * porteurs d'un compte-acteur (nécessaire pour recevoir un droit sur un document).
 *
 * Écrites contre le contrat des fixtures (`apps/e2e/fixtures`, lot 0). Aucune ne pilote l'écran :
 * ce sont des préconditions posées par l'API, pour que chaque test reste indépendant.
 *
 * ── Comment naît un document PDF par l'API ──────────────────────────────────────────────────────
 * L'archivage par QR passe par un lot et le worker (asynchrone) ; l'éditeur collaboratif crée des
 * pièces `.ydoc`, pas des PDF. Le chemin SYNCHRONE le plus court vers un vrai document PDF est la
 * file « Documents scannés » des courriers : on y dépose un PDF, puis un courrier Départ le promeut
 * en document GED (version 1, empreinte SHA-256 posée dès la création, binaire écrit au coffre —
 * `MailScannedDocumentsService.promoteToDocument`). L'administrateur passe outre les menus requis.
 */
import type { APIResponse } from '@playwright/test';
import type { ApiClient, UploadFile } from '../../../fixtures';
import { createRestrictedUser, type ApiAs, type GedApi, type GedUser } from './users';

// ─────────────────────────────────────────────────────────────────────────────── types du contrat

/** Réponse brute (`api.raw.<verbe>`) : `APIResponse` de Playwright. */
export type RawResponse = APIResponse;

export type { UploadFile };

/** Client REST des fixtures (envoi multipart et variante brute `raw` compris). */
export type GedDocsApi = ApiClient;

/** Niveaux de `permission_level` (seed figé) — « Denied » n'est jamais accordable. */
export const PERMISSION_LEVEL = {
  DENIED: 1,
  CONSULTATION: 2,
  MODIFICATION: 3,
  ADMINISTRATION: 4,
  ARCHIVISTIQUE: 5,
} as const;

/** Ligne de version (`GedDocumentVersionRow` de `@archivage/types`, champs utiles aux tests). */
export interface VersionRow {
  documentVersionId: number;
  versionNumber: number;
  isCurrent: boolean;
  changeKind: string;
  changeSummary: string | null;
  contentHash: string | null;
  restoredFromVersionNumber: number | null;
  files: Array<{ fileId: number; originalName: string | null; fileExtension: string }>;
}

/** Document créé par `createPdfDocument`. */
export interface TestDocument {
  documentId: number;
  label: string;
  /** Version 1 (courante à la création) et son unique fichier. */
  versionId: number;
  fileId: number;
  /** Binaire déposé, pour comparer un téléchargement octet à octet. */
  pdf: Buffer;
}

// ──────────────────────────────────────────────────────────────────────────────────────── PDF

/**
 * PDF minimal VALIDE (une page, une ligne de texte), avec table xref exacte. Le texte rend chaque
 * binaire unique : deux appels avec deux textes différents donnent deux empreintes différentes
 * (le dépôt d'une version identique à la courante est refusé en 409).
 */
export function minimalPdf(text: string): Buffer {
  const safe = text.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
  const content = `BT /F1 12 Tf 10 50 Td (${safe}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const pdfFile = (name: string, buffer: Buffer): UploadFile => ({
  name,
  mimeType: 'application/pdf',
  buffer,
});

// ────────────────────────────────────────────────────────────────────────────────── documents

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Crée un document GED d'un seul fichier PDF, au nom de l'administrateur (`api`).
 * `label` doit être unique (passer un `uniq(...)`) : c'est aussi le titre du courrier porteur.
 */
export async function createPdfDocument(
  api: GedDocsApi,
  label: string,
  pdf: Buffer = minimalPdf(label),
): Promise<TestDocument> {
  const scan = await api.upload<{ mailScannedDocumentId: number }>('/courriers/documents-scannes', {
    field: 'file',
    file: pdfFile(`${label}.pdf`, pdf),
    fields: { machineName: 'e2e-ged' },
  });
  await api.post('/courriers/depart', {
    title: label,
    date: today(),
    scannedDocumentId: scan.mailScannedDocumentId,
  });
  const promoted = await api.get<{ documentId: number | null }>(
    `/courriers/documents-scannes/${scan.mailScannedDocumentId}`,
  );
  if (promoted.documentId == null) {
    throw new Error(`Le scan ${scan.mailScannedDocumentId} n'a pas été promu en document GED`);
  }
  const detail = await api.get<{
    currentVersion: { documentVersionId: number; files: Array<{ fileId: number }> } | null;
  }>(`/documents/${promoted.documentId}`);
  const current = detail.currentVersion;
  const firstFile = current?.files[0];
  if (!current || !firstFile) {
    throw new Error(`Document ${promoted.documentId} sans version courante exploitable`);
  }
  return {
    documentId: promoted.documentId,
    label,
    versionId: current.documentVersionId,
    fileId: firstFile.fileId,
    pdf,
  };
}

/** Élément `i` d'une liste, avec un échec explicite s'il manque (`noUncheckedIndexedAccess`). */
export function nth<T>(rows: readonly T[], i: number, what = 'élément'): T {
  const row = rows[i];
  if (row === undefined) throw new Error(`${what} n°${i} absent (liste de ${rows.length})`);
  return row;
}

/** Versions du document, la plus récente d'abord. */
export function listVersions(api: GedApi, documentId: number): Promise<VersionRow[]> {
  return api.get<VersionRow[]>(`/documents/${documentId}/versions`);
}

/** Dépose une nouvelle version (PDF unique par défaut) et renvoie sa ligne. */
export function createVersion(
  api: GedDocsApi,
  documentId: number,
  opts: { pdf?: Buffer; name?: string; changeSummary?: string } = {},
): Promise<VersionRow> {
  const pdf = opts.pdf ?? minimalPdf(`v-${documentId}-${Date.now()}-${Math.random()}`);
  return api.upload<VersionRow>(`/documents/${documentId}/versions`, {
    field: 'file',
    file: pdfFile(opts.name ?? 'nouvelle-version.pdf', pdf),
    fields: opts.changeSummary ? { changeSummary: opts.changeSummary } : {},
  });
}

export function restoreVersion(
  api: GedApi,
  documentId: number,
  versionId: number,
): Promise<VersionRow> {
  return api.post<VersionRow>(`/documents/${documentId}/versions/${versionId}/restore`, {});
}

/** URL relative (à `/api`) du binaire d'un fichier d'une version. */
export const versionContentPath = (documentId: number, versionId: number, fileId: number) =>
  `/documents/${documentId}/versions/${versionId}/files/${fileId}/content`;

// ──────────────────────────────────────────────────────────────────────── intégrité et cachet

export interface SealState {
  sealed: boolean;
  algorithm?: string;
  sealedAt?: string;
  keyFingerprint?: string;
  knownKey?: boolean;
  signatureValid?: boolean | null;
  contentMatches?: boolean | null;
  timestampMatches?: boolean | null;
}

export const getSeal = (api: GedApi, documentId: number) =>
  api.get<SealState>(`/documents/${documentId}/seal`);

export const applySeal = (api: GedApi, documentId: number) =>
  api.post<{ algorithm: string; keyFingerprint: string; sealedAt: string }>(
    `/documents/${documentId}/seal`,
  );

export const getSealingPublicKey = (api: GedApi) =>
  api.get<{ algorithm: string; fingerprint: string; publicKeyPem: string }>(
    '/documents/sealing/public-key',
  );

export const verifyIntegrity = (api: GedApi, documentId: number) =>
  api.post<{
    dateLastVerified: string;
    integrityOk: boolean | null;
    files: Array<{ fileId: number; status: 'ok' | 'mismatch' | 'missing' | 'imprinted' }>;
  }>(`/documents/${documentId}/integrity/verify`);

// ─────────────────────────────────────────────────────────────────────── droits et utilisateurs

/** Compte-acteur (`user_group_id`) porté par le jeton du client donné. */
export async function myUserGroupId(client: GedApi): Promise<number | null> {
  const me = await client.get<{ userGroupId: number | null }>('/auth/me');
  return me.userGroupId;
}

export interface GedActor extends GedUser {
  /** Compte-acteur créé pour lui : c'est lui qui reçoit les droits sur un document. */
  userGroupId: number;
  groupId: number;
  /** Nom affiché dans les listes d'acteurs (« Prénom Nom » = `E2E <username>`). */
  fullName: string;
}

/**
 * Comme `createRestrictedUser`, puis lui donne un profil par défaut : sans compte-acteur, un
 * utilisateur ne peut recevoir AUCUN droit nominatif sur un document (`document_permission`
 * vise un `user_group_id`), ni apparaître dans la liste « Utilisateur… » de l'onglet Accès.
 */
export async function createActorUser(
  api: GedDocsApi,
  apiAs: ApiAs,
  prefix: string,
  menuKeys: string[] = [],
): Promise<GedActor> {
  const user = await createRestrictedUser(api, apiAs, prefix, menuKeys);
  const group = await api.post<{ groupId: number }>('/users/groups/all', {
    name: `Profil ${user.username}`,
  });
  await api.post(`/users/${user.userId}/groups`, { groupId: group.groupId, isDefault: true });
  // Nouvelle connexion : le jeton porte le compte-acteur par défaut au moment du login.
  const self = await apiAs(user.username, user.password);
  const userGroupId = await myUserGroupId(self);
  if (userGroupId == null) throw new Error(`Aucun compte-acteur pour ${user.username}`);
  return { ...user, userGroupId, groupId: group.groupId, fullName: `E2E ${user.username}` };
}

export function grantDocumentPermission(
  api: GedApi,
  documentId: number,
  grant: { userGroupId?: number; groupId?: number; permissionLevelId: number },
): Promise<{ documentPermissionId: number }> {
  return api.post(`/documents/${documentId}/permissions`, grant);
}

/**
 * Rend le document RESTREINT : dès qu'un droit explicite existe sur lui, seuls ses bénéficiaires
 * (et le créateur, et l'administrateur) l'ouvrent encore (`DocumentsService.isVisibleByPermissions`).
 * On accorde ce droit au compte-acteur de l'administrateur, sans effet pour lui (il passe outre).
 */
export async function restrictDocument(api: GedApi, documentId: number): Promise<void> {
  const adminUg = await myUserGroupId(api);
  if (adminUg == null) throw new Error("L'administrateur n'a pas de compte-acteur");
  await grantDocumentPermission(api, documentId, {
    userGroupId: adminUg,
    permissionLevelId: PERMISSION_LEVEL.CONSULTATION,
  });
}
