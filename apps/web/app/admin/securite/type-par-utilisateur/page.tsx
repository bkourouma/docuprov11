'use client';

import { lookups } from '../../../lib/archives';
import { personName } from '../../../components/mail/mailFormat';
import { TypeSecurityPage } from '../../../components/security/TypeSecurityPage';

export default function TypeParUtilisateurPage() {
  return (
    <TypeSecurityPage
      scope="user"
      icon="users"
      title="Sécurité type document par utilisateur"
      actorLabel="Utilisateur"
      actorPlaceholder="Utilisateurs…"
      // `Actor.label` vaut « Nom — Groupe » : ici on ne garde que la personne. Le droit porte sur
      // l'acteur (`app_user_group`), le groupe ne fait donc que rallonger l'option. `personName`
      // dépend du contrat `Actor` de `/courriers/actors`, pas du domaine courrier — c'est la même
      // liste que consomme cet écran.
      actorsLoader={() =>
        lookups
          .actors()
          .then((rows) => rows.map((a) => ({ value: a.userGroupId, label: personName(a.label) })))
      }
    />
  );
}
