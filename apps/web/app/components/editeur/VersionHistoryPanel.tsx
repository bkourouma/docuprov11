'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Popconfirm, Timeline, Typography } from 'antd';
import dayjs from 'dayjs';
import { GED_VERSION_CHANGE_KIND_LABELS, type GedDocumentVersionRow } from '@archivage/types';
import { docVersionsApi } from '../../lib/doc-versions';
import { editeurApi } from '../../lib/editeur';
import { EmptyState } from '../EmptyState';
import { StateTag, TabSkeleton } from '../documents/shared';
import { icons } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';

const { Text } = Typography;

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Historique des versions d'un document texte. « Restaurer » demande au serveur une NOUVELLE
 * version à partir de l'ancienne (l'historique n'est jamais réécrit) ; la salle collaborative est
 * alors réinitialisée (code 4410) et l'éditeur recharge seul son contenu.
 */
export function VersionHistoryPanel({
  documentId,
  canRestore,
  refreshKey,
  onRestored,
  onError,
}: {
  documentId: number;
  canRestore: boolean;
  /** Incrémenté par le parent (ex. après « Enregistrer une version ») pour recharger la liste. */
  refreshKey: number;
  onRestored: (restored: GedDocumentVersionRow) => void;
  onError: (message: string) => void;
}) {
  const [rows, setRows] = useState<GedDocumentVersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRows(await docVersionsApi.list(documentId));
    } catch (e) {
      setLoadError(errMsg(e, 'Chargement de l’historique impossible.'));
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const restore = async (r: GedDocumentVersionRow) => {
    setRestoringId(r.documentVersionId);
    try {
      const created = await editeurApi.restore(documentId, r.documentVersionId);
      onRestored(created);
      await load();
    } catch (e) {
      onError(errMsg(e, 'Restauration impossible.'));
    } finally {
      setRestoringId(null);
    }
  };

  if (loading && rows.length === 0) return <TabSkeleton />;

  if (loadError) {
    return (
      <div role="alert">
        <Text type="danger">{loadError}</Text>
        <div style={{ marginTop: space.sm }}>
          <Button onClick={() => void load()}>Réessayer</Button>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState compact icon="document" title="Aucune version enregistrée" />;
  }

  return (
    <Timeline
      items={rows.map((r) => ({
        key: r.documentVersionId,
        color: r.isCurrent ? 'var(--ant-color-primary)' : 'var(--ant-color-text-tertiary)',
        children: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
            <div style={{ display: 'flex', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}>
              <Text strong style={{ fontSize: fontSize.base }}>
                Version {r.versionNumber}
              </Text>
              {r.isCurrent && <StateTag tone="brand">Courante</StateTag>}
              <StateTag tone="neutral">
                {GED_VERSION_CHANGE_KIND_LABELS[r.changeKind] ?? r.changeKind}
              </StateTag>
            </div>
            <Text type="secondary" style={{ fontSize: fontSize.xs }}>
              {dayjs(r.createdAt).format('DD/MM/YYYY HH:mm')}
              {r.createdByName ? ` · ${r.createdByName}` : ''}
              {r.restoredFromVersionNumber != null
                ? ` · Restaurée depuis la v${r.restoredFromVersionNumber}`
                : ''}
            </Text>
            {r.changeSummary && <Text style={{ fontSize: fontSize.sm }}>{r.changeSummary}</Text>}
            {canRestore && !r.isCurrent && (
              <div>
                <Popconfirm
                  title={`Restaurer la version ${r.versionNumber} ?`}
                  description={`Le contenu actuel sera remplacé par celui de la version ${r.versionNumber} pour toutes les personnes connectées. Une nouvelle version est créée : l’historique est conservé.`}
                  okText="Restaurer"
                  cancelText="Annuler"
                  onConfirm={() => restore(r)}
                >
                  <Button
                    size="small"
                    icon={<icons.reset size={14} />}
                    loading={restoringId === r.documentVersionId}
                    aria-label={`Restaurer la version ${r.versionNumber}`}
                  >
                    Restaurer cette version
                  </Button>
                </Popconfirm>
              </div>
            )}
          </div>
        ),
      }))}
    />
  );
}
