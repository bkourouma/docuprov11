'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Modal, Space, Table, Tooltip, Upload } from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import Link from 'next/link';
import dayjs from 'dayjs';
import { PageHeader } from '../../components/PageHeader';
import { CountBadge } from '../../components/CountBadge';
import { EmptyState } from '../../components/EmptyState';
import { PdfViewer } from '../../components/viewer/PdfViewer';
import { TableSkeleton } from '../../components/skeletons';
import { icons } from '../../theme/icons';
import {
  fetchScannedBlobUrl,
  listScannedDocuments,
  uploadScannedDocument,
  type ScannedDocumentRow,
} from '../../lib/courriers';

/** Extensions acceptées au dépôt — doit rester aligné sur ACCEPTED_EXTENSIONS côté API (§07). */
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.tiff,.tif';

export default function DocumentsScannesPage() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<ScannedDocumentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{ scan: ScannedDocumentRow; url: string | null } | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listScannedDocuments({ page, pageSize });
      setRows(res.rows);
      setTotal(res.total);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
      setFirstLoad(false);
    }
  }, [page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const doUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        await uploadScannedDocument(file);
        message.success(`« ${file.name} » déposé.`);
        setPage(1);
        await load();
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Dépôt impossible');
      } finally {
        setUploading(false);
      }
    },
    [load, message],
  );

  // Aperçu (§07) : blob révoqué à la fermeture pour ne pas fuiter le binaire en mémoire.
  const openPreview = useCallback(
    async (scan: ScannedDocumentRow) => {
      setPreviewLoading(true);
      setPreview({ scan, url: null });
      try {
        const url = await fetchScannedBlobUrl(scan.mailScannedDocumentId);
        if (!url) message.error('Aperçu indisponible (fichier introuvable).');
        setPreview({ scan, url });
      } finally {
        setPreviewLoading(false);
      }
    },
    [message],
  );

  const closePreview = useCallback(() => {
    setPreview((p) => {
      if (p?.url) URL.revokeObjectURL(p.url);
      return null;
    });
  }, []);

  const columns: TableColumnsType<ScannedDocumentRow> = [
    {
      title: 'Fichier',
      dataIndex: 'fileName',
      key: 'fileName',
      ellipsis: true,
      render: (v: string | null) => (v ? <span className="da-mono">{v}</span> : '—'),
    },
    {
      title: 'Scanné le',
      dataIndex: 'dateScanned',
      key: 'dateScanned',
      width: 170,
      render: (v: string) => dayjs(v).format('DD/MM/YYYY HH:mm'),
    },
    {
      title: '',
      key: 'actions',
      width: 230,
      align: 'right',
      render: (_, r) => (
        <Space>
          <Button size="small" onClick={() => void openPreview(r)}>
            Consulter
          </Button>
          <Link href={`/courriers/enregistrement?scanId=${r.mailScannedDocumentId}`}>
            <Button type="primary" size="small" icon={<icons.add size={15} />}>
              Enregistrer
            </Button>
          </Link>
        </Space>
      ),
    },
  ];

  const onChange = (pagination: TablePaginationConfig) => {
    setPage(pagination.current ?? 1);
    setPageSize(pagination.pageSize ?? 25);
  };

  return (
    <div>
      <PageHeader
        icon="scan"
        title="Documents scannés"
        actions={
          <Upload
            accept={ACCEPT}
            showUploadList={false}
            maxCount={1}
            beforeUpload={(file) => {
              void doUpload(file as unknown as File);
              return Upload.LIST_IGNORE; // dépôt géré à la main : pas de requête AntD ni de liste
            }}
          >
            <Tooltip title="Formats acceptés : PDF, JPG, PNG, TIFF">
              <Button type="primary" loading={uploading} icon={<icons.add size={16} />}>
                Déposer un document
              </Button>
            </Tooltip>
          </Upload>
        }
      />
      <Card
        title={
          firstLoad && loading ? (
            'Chargement…'
          ) : (
            <CountBadge value={total} label="document(s) en attente" />
          )
        }
        extra={
          <Button size="small" icon={<icons.refresh size={15} />} onClick={() => void load()}>
            Rafraîchir
          </Button>
        }
      >
        {firstLoad && loading ? (
          <TableSkeleton rows={6} columns={3} />
        ) : total === 0 && !loading ? (
          <EmptyState icon="scan" title="Aucun document scanné en attente" />
        ) : (
          // Un seul niveau d'explication : la description de page (et l'infobulle du dépôt pour
          // les formats) disent déjà à quoi sert « Enregistrer » — pas de rappel au-dessus de la
          // table.
          <Table<ScannedDocumentRow>
            rowKey="mailScannedDocumentId"
            columns={columns}
            dataSource={rows}
            loading={loading && !firstLoad}
            // Écran de production : densité resserrée.
            size="small"
            scroll={{ x: 'max-content' }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              pageSizeOptions: [10, 25, 50, 100],
              showTotal: (t) => `${t} document(s)`,
            }}
            onChange={onChange}
          />
        )}
      </Card>

      {/*
        Aperçu inline du dépôt (§07) — consultation avant enregistrement. Même cadrage que le
        tiroir d'aperçu du détail courrier (`MailDetailPage`) : la visionneuse occupe toute la
        surface, bord à bord, et suit la hauteur de la fenêtre. La hauteur figée précédente
        (`calc(100vh - 240px)` sur un `<div>` intérieur) laissait ~66 px de fenêtre inutilisés
        quelle que soit la taille de l'écran, et amputait la zone de lecture d'un tiers.
      */}
      <Modal
        open={preview != null}
        onCancel={closePreview}
        width="min(1100px, 96vw)"
        style={{ top: 24 }}
        destroyOnHidden
        title={preview?.scan.fileName ?? 'Document scanné'}
        // Pas de pied : la croix et Échap ferment déjà, comme dans le tiroir — et les 57 px
        // gagnés reviennent à la lecture.
        footer={null}
        styles={{
          // Le padding est déplacé du conteneur vers l'en-tête : le corps peut ainsi aller d'un
          // bord à l'autre, comme le `Drawer` dont le body est déjà en `padding: 0`.
          // La fenêtre est calée sur la hauteur d'écran (moins les 24 px de marge haute et basse)
          // et le corps prend simplement ce que l'en-tête laisse : pas de constante à réajuster
          // si celui-ci change de taille, ni de titre long qui ferait déborder.
          content: {
            padding: 0,
            overflow: 'hidden',
            height: 'calc(100vh - 48px)',
            display: 'flex',
            flexDirection: 'column',
          },
          header: {
            flex: 'none',
            padding: '16px 24px',
            marginBottom: 0,
            borderBottom: '1px solid var(--ant-color-border-secondary, #eef1f6)',
          },
          body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
        }}
      >
        <PdfViewer
          src={preview?.url ?? null}
          loading={previewLoading}
          fileName={preview?.scan.fileName ?? 'document.pdf'}
          style={{ flex: 1, minHeight: 0, border: 'none', borderRadius: 0 }}
          empty={<EmptyState compact icon="document" title="Aperçu indisponible" />}
        />
      </Modal>
    </div>
  );
}
