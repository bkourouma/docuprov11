import { apiJson } from './api';

export interface Me {
  username: string;
  fullName: string | null;
  isAdmin: boolean;
  // Identité effective (§08 acteur) : compare aux `createdBy` d'imputation pour savoir
  // « est-ce la mienne ? ». Absent = backend pas à jour => aucune comparaison possible.
  userGroupId?: number | null;
  // Menus visibles selon le rôle (renvoyés par /auth/me). Absent = backend pas à jour => tout afficher.
  menuKeys?: string[];
  role?: { roleId: number; name: string } | null;
}

export const getMe = () => apiJson<Me>('/auth/me');

/** Fiche complète du compte connecté — écran « Mon profil » (`GET /auth/profile`). */
export interface MyProfile {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  matricule: string | null;
  isAdmin: boolean;
  isDisabled: boolean;
  mustChangePwd: boolean;
  createdAt: string;
  role: {
    roleId: number;
    name: string;
    description: string | null;
    isActive: boolean;
    isSystem: boolean;
    organigramme: { organigrammeId: number; label: string; path: string } | null;
  } | null;
  /** Habilitation : rang maximal de confidentialité consultable. `null` = aucune. */
  confidentialite: { confidentialiteId: number; label: string; rank: number } | null;
  /** Nombre de menus effectivement accessibles (tous si administrateur). */
  menuCount: number;
  groups: Array<{ userGroupId: number; groupId: number; name: string; isDefault: boolean }>;
}

export const getMyProfile = () => apiJson<MyProfile>('/auth/profile');

/** Change le mot de passe du compte connecté (efface aussi `mustChangePwd`). */
export const changeMyPassword = (currentPassword: string, newPassword: string) =>
  apiJson<{ changed: boolean }>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
