'use client';

import { useEffect, useState } from 'react';
import { App, Pagination, Tag, Timeline, Typography } from 'antd';
import dayjs from 'dayjs';
import { documentsApi, type DocumentHistoryRow } from '../../lib/archives';
import { EmptyState } from '../EmptyState';
import { StateTag, TabSkeleton } from './shared';
import { icons } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';

const { Text } = Typography;

/**
 * Onglet « Historique » : journal du document, modifications et consultations confondues.
 *
 * Les deux sources d'audit (`data_change_audit`, ancré sur `document:{id}`, et `navigation_audit`,
 * ancré sur l'URL) sont fusionnées côté serveur en une seule chronologie : l'utilisateur veut voir
 * ce qui s'est passé dans l'ordre, pas recouper deux listes.
 *
 * Pagination CÔTÉ CLIENT : le serveur renvoie la chronologie d'un coup, déjà bornée (200 entrées
 * par source). Découper la page ici évite un aller-retour par page pour un volume déjà en mémoire.
 */
export function HistoryTab({ documentId }: { documentId: number }) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<DocumentHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void documentsApi
      .history(documentId)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        // Changer de document remet la chronologie à son début : rester page 4 sur un historique
        // qui n'en compte qu'une afficherait un onglet vide.
        setPage(1);
      })
      .catch((e: unknown) => {
        if (!cancelled) message.error(e instanceof Error ? e.message : 'Chargement impossible');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, message]);

  if (loading) {
    return <TabSkeleton rows={6} />;
  }

  if (rows.length === 0) {
    return <EmptyState compact icon="pending" title="Aucun événement" />;
  }

  const visible = rows.slice((page - 1) * pageSize, page * pageSize);

  return (
    <>
      <Timeline
        items={visible.map((r) => ({
          key: r.key,
          // Pastille : une modification prend le primaire, une consultation s'efface sur une
          // teinte de texte tertiaire. Aucun texte n'y est posé, la variable de thème suffit.
          color:
            r.kind === 'change' ? 'var(--ant-color-primary)' : 'var(--ant-color-text-tertiary)',
          children: (
            <div>
              <div
                style={{ display: 'flex', gap: space.sm, alignItems: 'baseline', flexWrap: 'wrap' }}
              >
                <Text strong style={{ fontSize: fontSize.sm }}>
                  {r.action}
                </Text>
                {r.kind === 'change' ? (
                  <StateTag tone="brand" style={{ marginInlineEnd: 0 }}>
                    Modification
                  </StateTag>
                ) : (
                  <Tag style={{ marginInlineEnd: 0 }}>Consultation</Tag>
                )}
              </div>
              <div
                style={{ display: 'flex', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                  {dayjs(r.at).format('DD/MM/YYYY HH:mm')}
                </Text>
                {/* L'auteur porte son icône : c'est l'information que l'on cherche en premier
                    dans un journal, elle ne doit pas se lire comme la fin de la date. Les
                    lignes antérieures au 2026-09-08 n'en ont pas — on le dit plutôt que de
                    laisser un vide qui se confondrait avec « personne n'a rien fait ». */}
                <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                  <icons.users
                    size={13}
                    strokeWidth={1.75}
                    style={{ verticalAlign: '-2px', marginInlineEnd: 4 }}
                  />
                  {r.actor ?? 'Auteur non journalisé'}
                </Text>
              </div>
              {r.details && (
                <div>
                  <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                    {r.details}
                  </Text>
                </div>
              )}
            </div>
          ),
        }))}
      />
      <Pagination
        align="end"
        size="small"
        current={page}
        pageSize={pageSize}
        total={rows.length}
        onChange={(p, s) => {
          setPage(p);
          setPageSize(s);
        }}
        showSizeChanger
        pageSizeOptions={[10, 20, 50]}
        // Un historique qui tient sur une page n'a pas besoin qu'on le dise : sur les documents
        // peu mouvementés (la majorité), la barre ne serait que du bruit sous la chronologie.
        hideOnSinglePage
        showTotal={(t) => `${t} événement(s)`}
      />
    </>
  );
}
