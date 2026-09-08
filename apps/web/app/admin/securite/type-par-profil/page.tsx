'use client';

import { apiJson } from '../../../lib/api';
import { TypeSecurityPage } from '../../../components/security/TypeSecurityPage';

interface RoleRow {
  roleId: number;
  name: string;
  isActive: boolean;
}

/**
 * Bénéficiaire collectif = le RÔLE (2026-08-06), plus le « profil » (`app_group`) : l'administration
 * n'expose que les rôles, seuls affectés aux comptes — la liste des profils montrait un référentiel
 * que rien n'alimente. La route garde son nom, qui est aussi la clé de permission stockée en base.
 */
export default function TypeParRolePage() {
  return (
    <TypeSecurityPage
      scope="role"
      icon="roles"
      title="Sécurité type document par rôle"
      actorLabel="Rôle"
      actorPlaceholder="Rôles…"
      actorsLoader={() =>
        apiJson<RoleRow[]>('/roles').then((rows) =>
          rows.filter((r) => r.isActive).map((r) => ({ value: r.roleId, label: r.name })),
        )
      }
    />
  );
}
