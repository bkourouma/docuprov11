'use client';

import { Card } from 'antd';
import { EmptyState } from '../../components/EmptyState';

/** État affiché quand l'API refuse l'accès (403) : les connecteurs sont réservés aux administrateurs. */
export function ForbiddenState() {
  return (
    <Card>
      <EmptyState
        icon="lock"
        title="Accès réservé aux administrateurs. Les connecteurs de sources ne sont gérés que par un compte administrateur."
      />
    </Card>
  );
}
