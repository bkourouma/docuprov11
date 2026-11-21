'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Card, Col, Drawer, Row, Skeleton, Space, Tabs, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import { fetchDocumentBlobUrl } from '../../lib/courriers';
import {
  documentsApi,
  metaDataDocumentTypesApi,
  type DocumentDetail,
  type MetaDataField,
} from '../../lib/archives';
import type { MetaValues } from '../../components/MetaDataFields';
import { MetaDataDisplay } from '../../components/MetaDataDisplay';
import { InfoCard, InfoRow } from '../../components/InfoCard';
import { AccessTab } from '../../components/documents/AccessTab';
import { HistoryTab } from '../../components/documents/HistoryTab';
import { VersionsTab } from '../../components/documents/VersionsTab';
import { SecurityTab } from '../../components/documents/SecurityTab';
import { IndexationTab } from '../../components/documents/IndexationTab';
import { LifeCycleTab } from '../../components/documents/LifeCycleTab';
import { StateTag } from '../../components/documents/shared';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { PdfViewer } from '../../components/viewer/PdfViewer';
import { icons } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';
import { PERMISSION_LEVEL } from '../../lib/security';
import { isCollabDocument } from '../../lib/editeur';

const { Text } = Typography;

const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');

/** Libellés du niveau de permission EFFECTIF — mêmes noms que le référentiel (`permission_level`),
 * en dur ici pour ne pas recharger toute la liste juste pour ce badge. */
const PERMISSION_LEVEL_LABEL: Record<number, string> = {
  [PERMISSION_LEVEL.CONSULTATION]: 'Consultation',
  [PERMISSION_LEVEL.MODIFICATION]: 'Modification',
  [PERMISSION_LEVEL.ADMINISTRATION]: 'Administration',
  [PERMISSION_LEVEL.ARCHIVISTIQUE]: 'Archivistique',
};

/**
 * Squelette de la fiche pendant son chargement — même silhouette que la fiche réelle : titre,
 * ligne de badges d'état, barre d'actions, carte à onglets en deux colonnes. Le spinner centré
 * qu'il remplace ne réservait aucune place : la page passait d'un vide à la fiche complète d'un
 * coup, alors que la recherche d'où l'on arrive annonce déjà sa structure.
 */
function DocumentDetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement du document">
      <Skeleton.Input active size="large" style={{ width: 'min(420px, 70%)' }} />
      <div style={{ display: 'flex', gap: space.sm, marginTop: space.md, marginBottom: space.md }}>
        <Skeleton.Button active size="small" style={{ width: 88 }} />
        <Skeleton.Button active size="small" style={{ width: 160 }} />
      </div>
      <div style={{ marginBottom: space.lg }}>
        <Skeleton.Button active style={{ width: 210 }} />
      </div>
      <Card>
        <Row gutter={[space.lg, space.lg]}>
          <Col xs={24} lg={12}>
            <Skeleton active title={{ width: 140 }} paragraph={{ rows: 5 }} />
          </Col>
          <Col xs={24} lg={12}>
            <Skeleton active title={{ width: 140 }} paragraph={{ rows: 5 }} />
          </Col>
        </Row>
      </Card>
    </div>
  );
}

/**
 * Page de consultation d'un document archivé, en onglets — reprise du `DocumentViewer` du module
 * source, adaptée à V6 :
 *  - « Information » fond en un seul onglet la fiche et ses métadonnées (le source les séparait
 *    entre deux blocs d'un même onglet « Informations ») ;
 *  - « Indexation » réindexe complètement (classement + métadonnées), comme `UpdateDocument` ;
 *  - « Cycle de vie » oppose la règle du type à la dérogation propre au document ;
 *  - « Accès » et « Historique » reprennent les onglets homonymes.
 *
 * Deux onglets du source restent hors de portée faute de support en base, et non par choix :
 * « Accès par Profil » (`document_permission` ne porte qu'un `user_group_id`, pas de groupe) et
 * « Sécurité et Conformité » (aucune colonne `hash`/`signature`/`date_last_verified` sur
 * `document` — le source en câblait d'ailleurs déjà deux valeurs sur six en dur).
 */
export default function DocumentDetailPage() {
  const params = useParams<{ documentId: string }>();
  const router = useRouter();
  const idNum = Number(params.documentId);
  const documentId = Number.isFinite(idNum) ? idNum : null;

  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [fields, setFields] = useState<MetaDataField[]>([]);
  const [activeTab, setActiveTab] = useState('document');

  const [docOpen, setDocOpen] = useState(false);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);

  const load = useCallback(async () => {
    if (documentId == null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const d = await documentsApi.detail(documentId);
      setDetail(d);
      // Champs du type SEULEMENT s'il y en a un : un document sans type n'a pas de métadonnées.
      setFields(
        d.documentTypeId != null
          ? await metaDataDocumentTypesApi.fields(d.documentTypeId).catch(() => [])
          : [],
      );
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openViewer = useCallback(async () => {
    setDocOpen(true);
    if (viewerUrl || !detail) return; // déjà chargé
    const file = detail.currentVersion?.files[0];
    if (!file) return;
    setViewerLoading(true);
    try {
      setViewerUrl(await fetchDocumentBlobUrl(detail.documentId, file.fileId));
    } finally {
      setViewerLoading(false);
    }
  }, [detail, viewerUrl]);

  useEffect(() => {
    // Le blob n'a de sens que pour CE document : le révoquer évite une fuite mémoire au démontage.
    return () => {
      if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    };
  }, [viewerUrl]);

  const backToList = () => router.push('/search');

  if (loading) {
    return <DocumentDetailSkeleton />;
  }

  if (!detail) {
    // Id invalide, document supprimé, ou accès direct à une URL périmée — pas un cas d'erreur,
    // juste une sortie propre plutôt qu'un écran bloqué.
    return (
      <div>
        <PageHeader
          icon="document"
          title="Document introuvable"
          breadcrumb={[{ label: 'Recherche', href: '/search' }, { label: 'Introuvable' }]}
          actions={<Button onClick={backToList}>Retour à la recherche</Button>}
        />
        <Card>
          <EmptyState icon="document" title="Document introuvable" />
        </Card>
      </div>
    );
  }

  const metaValues: MetaValues = Object.fromEntries(
    detail.metadataValues.map((v) => [v.metaDataId, v]),
  );
  const filledMetaCount = fields.filter((f) => {
    const v = metaValues[f.metaDataId];
    return v && (v.metaDataListItemId != null || (v.value ?? '').trim() !== '');
  }).length;

  // Niveau EFFECTIF (2026-08-04) : déjà résolu côté serveur (admin/créateur/droits explicites
  // confondus, cf. `DocumentsService.getEffectivePermissionLevel`) — la page n'a plus qu'à comparer
  // aux seuils pour montrer/masquer ce que ce niveau autorise. Repli Consultation si absent (cas
  // limite du document disparu entre la vérification d'accès et le calcul).
  const level = detail.effectivePermissionLevel ?? PERMISSION_LEVEL.CONSULTATION;
  const canIndex = level >= PERMISSION_LEVEL.MODIFICATION;
  const canManageAccess = level >= PERMISSION_LEVEL.ADMINISTRATION;
  // Onglet « Sécurité et conformité » (2026-09-15) : vérifier l'intégrité écrit un verdict et pose
  // l'empreinte de référence — c'est une modification, pas une lecture ; sceller fonde la valeur
  // probante et relève donc du même niveau que le cycle de vie.
  const canSeal = level >= PERMISSION_LEVEL.ARCHIVISTIQUE;

  return (
    <div>
      {/* Pas le libellé du document en titre d'écran (retiré le 2026-09-15) : il est déjà donné
          par la ligne « Libellé » de l'onglet Information, et sur deux lignes il repoussait le
          contenu utile vers le bas. L'en-tête garde un titre — `PageHeader` en exige un et une
          page sans `<h1>/<h2>` n'est plus navigable au lecteur d'écran — mais un titre stable,
          qui identifie la fiche par son numéro. */}
      <PageHeader
        icon="document"
        title={`Document #${detail.documentId}`}
        breadcrumb={[{ label: 'Recherche', href: '/search' }, { label: `#${detail.documentId}` }]}
        actions={<Button onClick={backToList}>Retour à la recherche</Button>}
      />

      {/* Les deux états majeurs de la fiche sur une seule ligne, au-dessus des actions : le gel
          et le niveau EFFECTIF de l'utilisateur courant conditionnent tout ce que la page
          autorise ensuite. En badges PLEINS — en Tag pâles, deux informations décisives se
          lisaient comme des étiquettes de plus. Volontairement pas repris dans l'en-tête du
          tiroir d'aperçu : une fois est suffisant. */}
      <Space wrap size={space.sm} style={{ marginBottom: space.md }}>
        {detail.isFrozen && <StateTag tone="danger">Gelé</StateTag>}
        <Tooltip title="Vos droits sur ce document">
          <StateTag tone="brand">Vos droits : {PERMISSION_LEVEL_LABEL[level] ?? level}</StateTag>
        </Tooltip>
      </Space>

      {/* L'aperçu est le geste attendu de l'écran : il porte seul l'accent primaire, le retour à
          la recherche restant une action secondaire de l'en-tête. */}
      <Space wrap size={space.sm} style={{ marginBottom: space.lg }}>
        {isCollabDocument(detail.currentVersion?.files) ? (
          /* Texte natif : la pièce .ydoc n'est pas un PDF, l'éditeur (lecture ou écriture selon
             les droits, décidé par le serveur) remplace l'aperçu. */
          <Button type="primary" icon={<icons.edit size={16} />} onClick={() => router.push(`/editeur/${detail.documentId}`)}>
            Ouvrir le document
          </Button>
        ) : (
          <Button type="primary" icon={<icons.view size={16} />} onClick={() => void openViewer()}>
            Visualiser le document
          </Button>
        )}
      </Space>

      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'document',
              label: 'Information',
              children: (
                <Row gutter={[16, 16]}>
                  <Col xs={24} lg={12}>
                    <InfoCard icon="document" title="Document">
                      <InfoRow label="Libellé" value={detail.label || '—'} />
                      <InfoRow label="Type de document" value={detail.documentType?.label || '—'} />
                      <InfoRow label="Enregistré le" value={fmt(detail.createdAt)} />
                      <InfoRow label="Dossier" value={detail.dossier?.label || '—'} />
                      {/* Libellé seul : la cote du plan n'aide pas en consultation. */}
                      <InfoRow label="Plan de classement" value={detail.plan?.label || '—'} />
                      <InfoRow
                        label="Niveau de confidentialité"
                        value={
                          detail.confidentialite ? (
                            <StateTag tone="info">{detail.confidentialite.label}</StateTag>
                          ) : (
                            '—'
                          )
                        }
                      />
                    </InfoCard>
                  </Col>
                  <Col xs={24} lg={12}>
                    <InfoCard
                      icon="documentType"
                      title="Métadonnée(s)"
                      extra={
                        fields.length > 0 && (
                          <Text type="secondary" style={{ fontSize: fontSize.xs, fontWeight: 400 }}>
                            {filledMetaCount}/{fields.length} renseignées
                          </Text>
                        )
                      }
                    >
                      {detail.documentTypeId == null ? (
                        <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                          Ce document n’a pas de type : aucune métadonnée n’est attendue.
                        </Text>
                      ) : fields.length === 0 ? (
                        <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                          Ce type de document n’attend aucun champ supplémentaire.
                        </Text>
                      ) : (
                        <MetaDataDisplay fields={fields} values={metaValues} />
                      )}
                    </InfoCard>
                  </Col>
                </Row>
              ),
            },
            // Masqué sous le niveau 3 « Modification » (2026-08-04) : Consultation seule ne donne
            // pas accès à l'écriture des attributs/métadonnées (le PATCH est de toute façon refusé
            // côté serveur, cf. `DocumentsService.indexDocument` — ce n'est pas qu'un habillage).
            ...(canIndex
              ? [
                  {
                    key: 'indexation',
                    label: 'Indexation',
                    children: (
                      <IndexationTab
                        detail={detail}
                        onSaved={() => {
                          void load();
                          setActiveTab('document');
                        }}
                      />
                    ),
                  },
                ]
              : []),
            {
              key: 'lifecycle',
              label: 'Cycle de vie',
              children: (
                <LifeCycleTab
                  documentId={detail.documentId}
                  documentTypeLabel={detail.documentType?.label ?? null}
                />
              ),
            },
            {
              key: 'access-user',
              label: 'Accès par utilisateur',
              children: (
                <AccessTab
                  documentId={detail.documentId}
                  canManage={canManageAccess}
                  scope="user"
                />
              ),
            },
            {
              key: 'access-group',
              label: 'Accès par profil',
              children: (
                <AccessTab
                  documentId={detail.documentId}
                  canManage={canManageAccess}
                  scope="group"
                />
              ),
            },
            {
              key: 'security',
              label: 'Sécurité et conformité',
              children: (
                <SecurityTab
                  documentId={detail.documentId}
                  canVerify={canIndex}
                  canSeal={canSeal}
                />
              ),
            },
            {
              // Dépôt et restauration réservés au niveau Modification, comme l'onglet Indexation.
              key: 'versions',
              label: 'Versions',
              children: (
                <VersionsTab
                  documentId={detail.documentId}
                  canEdit={canIndex}
                  onChanged={() => void load()}
                />
              ),
            },
            {
              key: 'history',
              label: 'Historique',
              children: <HistoryTab documentId={detail.documentId} />,
            },
          ]}
        />
      </Card>

      <Drawer
        title="Aperçu du document"
        placement="right"
        width="min(1100px, 96vw)"
        open={docOpen}
        onClose={() => setDocOpen(false)}
        styles={{
          // En-tête sur le fond de layout : sans lui, le bandeau blanc du tiroir se confond avec
          // la page blanche du PDF juste en dessous et la limite de la barre d'outils disparaît.
          header: { background: 'var(--ant-color-bg-layout)' },
          body: { padding: 0, display: 'flex', flexDirection: 'column' },
        }}
        extra={
          <Space size={space.sm}>
            {/* Taille par défaut (36 px) et non `small` (28 px) : c'est une action pointée à la
                souris, à côté de la croix de fermeture. */}
            <Button
              icon={<icons.view size={16} />}
              disabled={!viewerUrl}
              onClick={() => viewerUrl && window.open(viewerUrl, '_blank')}
            >
              Nouvel onglet
            </Button>
          </Space>
        }
      >
        <PdfViewer
          src={viewerUrl}
          loading={viewerLoading}
          fileName={`${detail.label || `document-${detail.documentId}`}.pdf`}
          style={{ flex: 1, border: 'none', borderRadius: 0 }}
          empty={<EmptyState compact icon="document" title="Aucun aperçu" />}
        />
      </Drawer>
    </div>
  );
}
