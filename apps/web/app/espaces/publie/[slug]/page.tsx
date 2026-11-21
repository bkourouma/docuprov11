'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, Button, Card, Descriptions } from 'antd';
import { PageHeader } from '../../../components/PageHeader';
import { EmptyState } from '../../../components/EmptyState';
import { TableSkeleton } from '../../../components/skeletons';
import { useFeedback } from '../../../components/feedback';
import { SpaceKindTag } from '../../../components/espaces/SpaceBadges';
import { SpaceDocumentsTable } from '../../../components/espaces/SpaceDocumentsTable';
import { space as spacing } from '../../../theme/tokens';
import { espacesApi, type GedSpaceDocumentRow, type GedSpaceSummary } from '../../../lib/espaces';

/**
 * Docu-GED lot 4a — lecture seule d'un espace publié.
 *
 * Volontairement dépourvue de toute action : pas de `actions` dans le PageHeader, aucun bouton,
 * et le tableau est rendu sans `onDetach`. Les documents que la confidentialité exclut du public
 * sont filtrés par l'API, jamais côté client.
 */
export default function EspacePubliePage() {
  const { slug } = useParams<{ slug: string }>();
  const { message } = useFeedback();
  const [space, setSpace] = useState<GedSpaceSummary | null>(null);
  const [documents, setDocuments] = useState<GedSpaceDocumentRow[]>([]);
  /** Slug vide ou hors alphabet d'URL : pas d'appel API, message clair, pas de squelette. */
  const invalidSlug = !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(slug ?? '');
  const [loading, setLoading] = useState(!invalidSlug);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (invalidSlug) return;
    let alive = true;
    void (async () => {
      try {
        const s = await espacesApi.getPublished(slug);
        const docs = await espacesApi.listDocuments(s.gedSpaceId);
        if (!alive) return;
        setSpace(s);
        setDocuments(docs);
      } catch (e) {
        if (alive) {
          const msg = e instanceof Error ? e.message : 'Espace publié introuvable';
          setErrorMsg(msg);
          message.error(msg);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug, invalidSlug, message]);

  const crumb = [{ label: 'Espaces', href: '/espaces' }];

  if (loading) {
    return (
      <div>
        <PageHeader title="Espace publié" icon="dossier" breadcrumb={crumb} />
        <Card>
          <TableSkeleton rows={4} columns={4} />
        </Card>
      </div>
    );
  }
  if (!space) {
    return (
      <div>
        <PageHeader title="Espace publié" icon="dossier" breadcrumb={crumb} />
        <Card>
          {(invalidSlug || errorMsg) && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: spacing.lg }}
              message={invalidSlug ? "L'adresse de l'espace publié est invalide." : errorMsg}
            />
          )}
          <EmptyState
            icon="alert"
            title="Cet espace n'existe pas ou n'est plus publié."
            action={
              <Link href="/espaces">
                <Button>Retour aux espaces</Button>
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={space.label}
        icon="dossier"
        breadcrumb={[...crumb, { label: space.label }]}
      />
      <Card style={{ marginBottom: spacing.lg }}>
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 3 }}
          items={[
            { key: 'kind', label: 'Type', children: <SpaceKindTag kind={space.kind} /> },
            { key: 'owner', label: 'Propriétaire', children: space.ownerName ?? '—' },
            {
              key: 'at',
              label: 'Publié le',
              children: space.publishedAt
                ? new Date(space.publishedAt).toLocaleDateString('fr-FR')
                : '—',
            },
            ...(space.description
              ? [
                  {
                    key: 'desc',
                    label: 'Description',
                    span: 'filled' as const,
                    children: space.description,
                  },
                ]
              : []),
          ]}
        />
      </Card>
      <Card title="Documents">
        {documents.length === 0 ? (
          <EmptyState compact icon="document" title="Aucun document visible dans cet espace." />
        ) : (
          <SpaceDocumentsTable rows={documents} />
        )}
      </Card>
    </div>
  );
}
