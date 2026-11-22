'use client';

import { Card } from 'antd';
import { EmptyState } from '../../../components/EmptyState';

/** État « accès refusé » clair (menu non accordé ou réponse 403) : jamais d'erreur technique. */
export function AccessDenied({ message }: { message: string }) {
  return (
    <Card>
      <div role="alert">
        <EmptyState icon="lock" title={message} />
      </div>
    </Card>
  );
}
