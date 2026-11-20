// Docu-GED lot 4a — contrat d'API partagé (api / web) des espaces et des versions de documents.
// Ajouts NON cassants : interfaces uniquement, les énumérations (GedSpaceKind, GedSpacePermission,
// GedVersionChangeKind) restent dans ./ged.
import type { GedSpaceKind, GedSpacePermission, GedVersionChangeKind } from './ged';

/** Droit effectif de l'acteur sur un espace : propriétaire, ou niveau de membre (0/1/2). */
export type GedSpaceAccess = 'owner' | GedSpacePermission;

export interface GedSpaceSummary {
  gedSpaceId: number;
  label: string;
  description: string | null;
  kind: GedSpaceKind;
  isActive: boolean;
  ownerUserGroupId: number;
  ownerName: string | null;
  publicationSlug: string | null;
  publishedAt: string | null;
  /**
   * Nombre de documents VISIBLES par l'acteur. `null` quand il n'est pas communiqué (liste,
   * lecture par slug, non-gestionnaire) : un compte brut révélerait l'existence de documents masqués.
   */
  documentCount: number | null;
  memberCount: number;
  /** Droit de l'acteur courant ; `null` = accès en lecture par publication (slug) seulement. */
  myAccess: GedSpaceAccess | null;
  createdAt: string;
  updatedAt: string;
}

export interface GedSpaceMemberRow {
  gedSpaceMemberId: number;
  userGroupId: number | null;
  roleId: number | null;
  /** Libellé du bénéficiaire (nom de l'utilisateur ou libellé du rôle). */
  granteeLabel: string;
  granteeType: 'user' | 'role';
  permission: GedSpacePermission;
  addedAt: string;
}

export interface GedSpaceDetail extends GedSpaceSummary {
  /** Membres : fournis seulement à un propriétaire ou à un membre « gestion », sinon []. */
  members: GedSpaceMemberRow[];
  canManage: boolean;
  canContribute: boolean;
}

export interface GedSpaceDocumentRow {
  documentId: number;
  label: string;
  documentDate: string | null;
  documentTypeLabel: string | null;
  addedAt: string;
}

export interface GedSpaceMemberCandidates {
  users: { userGroupId: number; fullName: string; username: string }[];
  roles: { roleId: number; label: string }[];
}

export interface GedSpaceInput {
  label: string;
  description?: string | null;
  /** 0 privé, 1 partage, 2 collaboration — la publication (3) passe par /publish. */
  kind: GedSpaceKind;
}

export interface GedSpacePublishResult {
  space: GedSpaceSummary;
  /** Documents rattachés qui ne seront PAS visibles du public de la publication (confidentialité posée). */
  nonPublishableCount: number;
}

export interface GedDocumentVersionFile {
  fileId: number;
  originalName: string | null;
  fileExtension: string;
  byteLength: number | null;
  pageCount: number | null;
}

export interface GedDocumentVersionRow {
  documentVersionId: number;
  versionNumber: number;
  isCurrent: boolean;
  isValidated: boolean;
  comment: string | null;
  createdAt: string;
  createdByName: string | null;
  changeKind: GedVersionChangeKind;
  changeSummary: string | null;
  /** SHA-256 hexadécimal du contenu de cette version ; `null` si jamais mesuré (fonds antérieurs). */
  contentHash: string | null;
  restoredFromVersionNumber: number | null;
  files: GedDocumentVersionFile[];
}
