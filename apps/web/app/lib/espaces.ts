// Client API des espaces GED (lot 4a). Le contrat vit dans @archivage/types : on ne redéclare
// ni les énumérations ni les formes de réponse, on les réexporte pour que les pages n'aient
// qu'un seul point d'import.
import {
  GedSpaceKind,
  GedSpacePermission,
  GED_SPACE_KIND_LABELS,
  GED_SPACE_PERMISSION_LABELS,
  type GedSpaceAccess,
  type GedSpaceDetail,
  type GedSpaceDocumentRow,
  type GedSpaceInput,
  type GedSpaceMemberCandidates,
  type GedSpaceMemberRow,
  type GedSpacePublishResult,
  type GedSpaceSummary,
} from '@archivage/types';
import { apiJson } from './api';

export {
  GedSpaceKind,
  GedSpacePermission,
  GED_SPACE_KIND_LABELS,
  GED_SPACE_PERMISSION_LABELS,
  type GedSpaceAccess,
  type GedSpaceDetail,
  type GedSpaceDocumentRow,
  type GedSpaceInput,
  type GedSpaceMemberCandidates,
  type GedSpaceMemberRow,
  type GedSpacePublishResult,
  type GedSpaceSummary,
};

/** Bénéficiaire à ajouter : un utilisateur OU un rôle, jamais les deux. */
export type AddMemberInput = (
  | { userGroupId: number; roleId?: never }
  | { roleId: number; userGroupId?: never }
) & { permission: GedSpacePermission };

const enc = encodeURIComponent;

export const espacesApi = {
  list: () => apiJson<GedSpaceSummary[]>('/spaces'),
  create: (input: GedSpaceInput) =>
    apiJson<GedSpaceSummary>('/spaces', { method: 'POST', body: JSON.stringify(input) }),
  /** Déclaré avant `/spaces/:id` côté API : « member-candidates » n'est pas un identifiant. */
  candidates: () => apiJson<GedSpaceMemberCandidates>('/spaces/member-candidates'),
  getPublished: (slug: string) => apiJson<GedSpaceSummary>(`/spaces/published/${enc(slug)}`),
  get: (id: number) => apiJson<GedSpaceDetail>(`/spaces/${id}`),
  update: (id: number, input: Partial<GedSpaceInput>) =>
    apiJson<GedSpaceSummary>(`/spaces/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  remove: (id: number) => apiJson<unknown>(`/spaces/${id}`, { method: 'DELETE' }),

  listMembers: (id: number) => apiJson<GedSpaceMemberRow[]>(`/spaces/${id}/members`),
  addMember: (id: number, input: AddMemberInput) =>
    apiJson<GedSpaceMemberRow>(`/spaces/${id}/members`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateMember: (id: number, memberId: number, permission: GedSpacePermission) =>
    apiJson<GedSpaceMemberRow>(`/spaces/${id}/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify({ permission }),
    }),
  removeMember: (id: number, memberId: number) =>
    apiJson<unknown>(`/spaces/${id}/members/${memberId}`, { method: 'DELETE' }),

  listDocuments: (id: number) => apiJson<GedSpaceDocumentRow[]>(`/spaces/${id}/documents`),
  attachDocument: (id: number, documentId: number) =>
    apiJson<unknown>(`/spaces/${id}/documents`, {
      method: 'POST',
      body: JSON.stringify({ documentId }),
    }),
  detachDocument: (id: number, documentId: number) =>
    apiJson<unknown>(`/spaces/${id}/documents/${documentId}`, { method: 'DELETE' }),

  publish: (id: number, slug?: string) =>
    apiJson<GedSpacePublishResult>(`/spaces/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(slug ? { slug } : {}),
    }),
  unpublish: (id: number) =>
    apiJson<GedSpaceSummary>(`/spaces/${id}/unpublish`, { method: 'POST', body: '{}' }),
};

/** Recherche de documents à rattacher : réutilise la recherche documentaire existante. */
export interface DocumentSearchRow {
  documentId: number;
  label: string;
  documentType: string | null;
  documentDate: string | null;
}
export const searchDocumentsByLabel = (fullText: string) =>
  apiJson<{ rows: DocumentSearchRow[] }>('/documents/search', {
    method: 'POST',
    body: JSON.stringify({ fullText, page: 1, pageSize: 20 }),
  }).then((r) => r.rows);

/** Texte d'aide par type, affiché à la création et à la modification. */
export const KIND_HELP: Record<number, string> = {
  [GedSpaceKind.Prive]: 'Réservé à vous : seul le propriétaire y accède.',
  [GedSpaceKind.Partage]:
    'Vous choisissez des membres (utilisateurs ou rôles), avec un droit de lecture, de contribution ou de gestion.',
  [GedSpaceKind.Collaboration]:
    'Espace de travail commun : les membres contributeurs y rattachent et détachent des documents.',
};

/** Types proposables à la création/modification (la publication passe par « Publier »). */
export const EDITABLE_KINDS = [
  GedSpaceKind.Prive,
  GedSpaceKind.Partage,
  GedSpaceKind.Collaboration,
] as const;

export const publicPath = (slug: string) => `/espaces/publie/${slug}`;
