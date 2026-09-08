import { apiJson } from './api';

/**
 * Sécurité Documentaire — types + clients typés, sur le patron de `archives.ts`.
 *
 * Les écrans « Demandes d'accès document » et « Sécurité par classification » ont été retirés de
 * l'interface (2026-08-04) : leurs clients (`accessInquiriesApi`, `plansWithTypesApi`) sont partis
 * avec eux. Les endpoints API restent en place (`AccessInquiriesController`,
 * `GET /referentials/plans-with-document-types`) — un client web est trivial à réécrire si ces
 * écrans reviennent.
 */

/**
 * Seuils du niveau de permission EFFECTIF (2026-08-04) — mêmes valeurs que le backend
 * (`DocumentsService.getEffectivePermissionLevel`) : 1 Denied n'apparaît jamais ici (exclu des
 * écrans d'octroi), la base tient déjà lieu de refus.
 */
export const PERMISSION_LEVEL = {
  CONSULTATION: 2,
  MODIFICATION: 3,
  ADMINISTRATION: 4,
  ARCHIVISTIQUE: 5,
} as const;

export interface TypePermissionRow {
  documentTypePermissionId: number;
  documentTypeId: number;
  documentTypeLabel: string;
  permissionLevelId: number;
  permissionLevelName: string;
  /** Bénéficiaire : acteur nommé (`user`) ou rôle entier (`role`, ex-profil — 2026-08-06). */
  scope: 'user' | 'role';
  /** Renseigné pour `scope: 'role'` — clé de regroupement de l'écran « par rôle ». */
  roleId: number | null;
  userGroupId: number | null;
  label: string;
  groupName: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface GrantTypePermissionInput {
  documentTypeId: number;
  permissionLevelId: number;
  userGroupId?: number;
  roleId?: number;
  startDate?: string;
  endDate?: string;
}

export const typePermissionsApi = {
  list: () => apiJson<TypePermissionRow[]>('/referentials/document-type-permissions'),
  grant: (body: GrantTypePermissionInput) =>
    apiJson<unknown>('/referentials/document-type-permissions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revoke: (id: number) =>
    apiJson<{ deleted: number }>(`/referentials/document-type-permissions/${id}`, { method: 'DELETE' }),
};

/** Même forme que `RefApi<T>` (`components/mail/MailRefPage.tsx`) — réutilisée telle quelle. */
export interface ConfidentialiteArchiveRow {
  confidentialiteId: number;
  label: string;
  rank: number;
}

export const confidentialitesArchivesApi = {
  list: () => apiJson<ConfidentialiteArchiveRow[]>('/referentials/confidentialites'),
  create: (body: Record<string, unknown>) =>
    apiJson<ConfidentialiteArchiveRow>('/referentials/confidentialites', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (id: number, body: Record<string, unknown>) =>
    apiJson<ConfidentialiteArchiveRow>(`/referentials/confidentialites/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (id: number) => apiJson<{ deactivated: boolean }>(`/referentials/confidentialites/${id}`, { method: 'DELETE' }),
};
