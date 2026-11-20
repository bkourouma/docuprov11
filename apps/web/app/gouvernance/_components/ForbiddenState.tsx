'use client';

import { Card } from 'antd';
import { EmptyState } from '../../components/EmptyState';

/** État affiché quand l'API refuse l'accès (403) : le menu Gouvernance n'est pas accordé à ce compte. */
export function ForbiddenState() {
  return (
    <Card>
      <EmptyState
        icon="lock"
        title="Accès refusé. Votre rôle ne donne pas accès à la gouvernance des documents. Demandez l’accès à un administrateur."
      />
    </Card>
  );
}
