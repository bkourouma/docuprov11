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
