'use client';

import { useParams, useRouter } from 'next/navigation';
import { Button, Card } from 'antd';
import { EditorShell } from '../../components/editeur/EditorShell';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';

/** Éditeur natif collaboratif d'un document texte (lot 4b). */
export default function EditeurPage() {
  const params = useParams<{ documentId: string }>();
  const router = useRouter();
  const id = Number(params.documentId);

  if (!Number.isInteger(id) || id <= 0) {
    return (
      <div>
        <PageHeader
          icon="document"
          title="Document inaccessible"
          breadcrumb={[{ label: 'Recherche', href: '/search' }, { label: 'Éditeur' }]}
          actions={<Button onClick={() => router.push('/search')}>Retour à la recherche</Button>}
        />
        <Card>
          <EmptyState icon="document" title="Document inaccessible" />
        </Card>
      </div>
    );
  }

  return <EditorShell documentId={id} />;
}
