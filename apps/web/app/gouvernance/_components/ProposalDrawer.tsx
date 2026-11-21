'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Descriptions, Drawer, Skeleton, Typography } from 'antd';
import {
  GovernanceKind,
  type GovernanceProposalDetail,
  type GovernanceProposalView,
  type GovernanceSensitivityReason,
} from '@archivage/types';
import { GovernanceApiError, errorMessage, governanceApi } from '../gouvernance-api';
import { DuplicateComparison } from './DuplicateComparison';
import { PiiFindings } from './PiiFindings';
import { ReviewActions } from './ReviewActions';
import {
  KindTag,
  SENSITIVITY_REASON_LABELS,
  StatusTag,
  DUPLICATE_METHOD_LABELS,
  directionTag,
  docName,
  formatDateTime,
  percent,
} from './labels';

const { Text } = Typography;

/**
 * Détail d'une proposition (Drawer : focus piégé, fermeture par Échap). L'extrait est MASQUÉ par
 * l'API et rendu comme TEXTE brut en police monospace ; rien n'est interprété comme HTML.
 */
export function ProposalDrawer({
  proposal,
  busy,
  onClose,
  onValidate,
  onReject,
  onAskLowering,
}: {
  proposal: GovernanceProposalView | null;
  busy: boolean;
  onClose: () => void;
  onValidate: (view: GovernanceProposalView) => void;
  onReject: (view: GovernanceProposalView) => void;
  onAskLowering: (view: GovernanceProposalView) => void;
}) {
  const [detail, setDetail] = useState<GovernanceProposalDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = proposal?.id ?? null;

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!id) return;
    const controller = new AbortController();
    setLoading(true);
    governanceApi
      .detail(id, controller.signal)
      .then((d) => setDetail(d))
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(e instanceof GovernanceApiError ? e : new GovernanceApiError('generic')));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id]);

  // Les données de la ligne servent d'affichage immédiat ; le détail les complète (comparaison).
  const view: GovernanceProposalView | null = detail && detail.id === id ? detail : proposal;
  const out = view?.output;
  const isDuplicate = view?.kind === GovernanceKind.DoublonExact || view?.kind === GovernanceKind.QuasiDoublon;
  const hasAi = out && out.kind !== GovernanceKind.DoublonExact && out.kind !== GovernanceKind.QuasiDoublon;

  return (
    <Drawer
      open={proposal !== null}
      onClose={onClose}
      width="min(760px, 100vw)"
      destroyOnHidden
      keyboard
      title={view ? <span>{docName(view.documentId, view.documentLabel)}</span> : 'Détail'}
      footer={
        view && (
          <ReviewActions
            view={view}
            busy={busy}
            size="middle"
            onValidate={onValidate}
            onReject={onReject}
            onAskLowering={onAskLowering}
          />
        )
      }
    >
      {view && out && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 16 }}>
            <KindTag kind={view.kind} />
            <StatusTag status={view.status} />
            {directionTag(view)}
            {view.documentId != null && (
              <Link href={`/documents/${view.documentId}`}>Ouvrir le document</Link>
            )}
          </div>

          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2 }}
            items={[
              { key: 'conf', label: 'Confiance', children: percent(view.confidence) },
              {
                key: 'model',
                label: 'Modèle / fournisseur',
                children: `${view.model}${view.provider ? ` / ${view.provider}` : ''}`,
              },
              ...(hasAi
                ? [
                    {
                      key: 'detect',
                      label: 'Détection',
                      children: out.kind === GovernanceKind.Sensibilite || out.kind === GovernanceKind.DonneesPersonnelles
                        ? out.detection.ai
                          ? 'Règles + IA'
                          : 'Règles'
                        : '',
                    },
                  ]
                : []),
              { key: 'date', label: 'Proposée le', children: formatDateTime(view.createdAt) },
              ...(view.validatedAt
                ? [{ key: 'vdate', label: 'Traitée le', children: formatDateTime(view.validatedAt) }]
                : []),
            ]}
          />

          {view.excerpt && (
            <>
              <h3 className="gov-section">Extrait</h3>
              <pre className="gov-excerpt" aria-label="Extrait du texte analysé">
                {view.excerpt}
              </pre>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Valeurs personnelles masquées.
              </Text>
            </>
          )}

          {out.kind === GovernanceKind.DonneesPersonnelles && (
            <>
              <h3 className="gov-section">Données personnelles trouvées</h3>
              <PiiFindings findings={out.findings} />
            </>
          )}

          {out.kind === GovernanceKind.Sensibilite && (
            <>
              <h3 className="gov-section">Niveau de confidentialité</h3>
              <Text>
                {view.currentConfidentialiteLabel ?? 'Aucun niveau'} → {view.proposedConfidentialiteLabel ?? 'Niveau proposé'}
              </Text>
              <h3 className="gov-section">Raisons</h3>
              {out.reasons.length === 0 ? (
                <Text type="secondary">Aucune raison détaillée.</Text>
              ) : (
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                  {out.reasons.map((r: GovernanceSensitivityReason) => (
                    <li key={r}>{SENSITIVITY_REASON_LABELS[r]}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          {isDuplicate && (out.kind === GovernanceKind.DoublonExact || out.kind === GovernanceKind.QuasiDoublon) && (
            <>
              <h3 className="gov-section">Comparaison</h3>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                {DUPLICATE_METHOD_LABELS[out.method]} · similarité {percent(out.similarity)}
              </Text>
              {loading && <Skeleton active paragraph={{ rows: 5 }} />}
              {error && (
                <Alert
                  type="error"
                  showIcon
                  message={error}
                  action={
                    <Button
                      size="small"
                      onClick={() => {
                        // Relance du chargement en réinitialisant l'état local.
                        setError(null);
                        setLoading(true);
                        governanceApi
                          .detail(view.id)
                          .then((d) => setDetail(d))
                          .catch((e) =>
                            setError(errorMessage(e instanceof GovernanceApiError ? e : new GovernanceApiError('generic'))),
                          )
                          .finally(() => setLoading(false));
                      }}
                    >
                      Réessayer
                    </Button>
                  }
                />
              )}
              {detail?.comparison && (
                <DuplicateComparison original={detail.comparison.original} duplicate={detail.comparison.duplicate} />
              )}
              {!loading && !error && detail && !detail.comparison && (
                <Text type="secondary">La comparaison n’est pas disponible pour cette proposition.</Text>
              )}
            </>
          )}
        </>
      )}
    </Drawer>
  );
}
