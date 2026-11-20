'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Timeline,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import dayjs from 'dayjs';
import { GED_VERSION_CHANGE_KIND_LABELS, type GedDocumentVersionRow } from '@archivage/types';
import { docVersionsApi } from '../../lib/doc-versions';
import { EmptyState } from '../EmptyState';
import { StateTag, TabSkeleton } from './shared';
import { icons } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';

const { Text } = Typography;

/** 64 hex vers « 1a2b3c4d…9f8e7d6c » : assez pour comparer à l'oeil, le hash complet est copiable. */
const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-8)}`;

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Onglet « Versions » : chronologie des versions du document, dépôt d'une nouvelle version et
 * restauration d'une version antérieure.
 *
 * Restaurer ne réécrit jamais l'historique : le serveur crée une NOUVELLE version à partir de
 * l'ancienne. C'est ce que disent les textes de confirmation, pour qu'on n'hésite pas à restaurer
 * par crainte de perdre la version actuelle.
 *
 * `canEdit` ne fait que masquer les boutons : le serveur refuse de toute façon (403) sous le
 * niveau Modification.
 */
export function VersionsTab({
  documentId,
  canEdit,
  onChanged,
}: {
  documentId: number;
  canEdit: boolean;
  onChanged?: () => void;
}) {
  const { message } = App.useApp();
  const [rows, setRows] = useState<GedDocumentVersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await docVersionsApi.list(documentId));
    } catch (e) {
      message.error(errMsg(e, 'Chargement des versions impossible'));
    } finally {
      setLoading(false);
    }
  }, [documentId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeModal = () => {
    setModalOpen(false);
    setFileList([]);
    setSummary('');
  };

  const submitNew = async () => {
    const file = fileList[0]?.originFileObj;
    if (!file) {
      message.warning('Choisissez un fichier PDF.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await docVersionsApi.create(documentId, file, { changeSummary: summary });
      message.success(`Version ${created.versionNumber} créée`);
      closeModal();
      await load();
      onChanged?.();
    } catch (e) {
      // 409 « contenu identique », 403, 413… : le message de l'API dit quoi corriger.
      message.error(errMsg(e, 'Création de la version impossible'));
    } finally {
      setSubmitting(false);
    }
  };

  const restore = async (row: GedDocumentVersionRow) => {
    setRestoringId(row.documentVersionId);
    try {
      const created = await docVersionsApi.restore(documentId, row.documentVersionId);
      message.success(`Version ${row.versionNumber} restaurée en version ${created.versionNumber}`);
      await load();
      onChanged?.();
    } catch (e) {
      message.error(errMsg(e, 'Restauration impossible'));
    } finally {
      setRestoringId(null);
    }
  };

  const copyHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      message.success('Empreinte copiée');
    } catch {
      // Presse-papiers refusé (contexte non sécurisé, permission) : on le dit plutôt que de se taire.
      message.error('Copie impossible');
    }
  };

  const openFile = async (versionId: number, fileId: number) => {
    try {
      await docVersionsApi.open(documentId, versionId, fileId);
    } catch (e) {
      message.error(errMsg(e, 'Ouverture du fichier impossible'));
    }
  };

  const header = canEdit && (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: space.md }}>
      <Button type="primary" icon={<icons.upload size={16} />} onClick={() => setModalOpen(true)}>
        Nouvelle version
      </Button>
    </div>
  );

  let body;
  if (loading) {
    body = <TabSkeleton rows={6} />;
  } else if (rows.length === 0) {
    body = <EmptyState compact icon="document" title="Aucune version enregistrée" />;
  } else {
    body = (
      <Timeline
        items={rows.map((r) => ({
          key: r.documentVersionId,
          // Pastille primaire pour la version courante, teinte tertiaire pour les archivées.
          color: r.isCurrent ? 'var(--ant-color-primary)' : 'var(--ant-color-text-tertiary)',
          children: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
              <div
                style={{ display: 'flex', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <Text strong style={{ fontSize: fontSize.base }}>
                  Version {r.versionNumber}
                </Text>
                {r.isCurrent && <StateTag tone="brand">Courante</StateTag>}
                {r.isValidated && <StateTag tone="success">Validée</StateTag>}
                <StateTag tone="neutral">{GED_VERSION_CHANGE_KIND_LABELS[r.changeKind]}</StateTag>
                {r.restoredFromVersionNumber != null && (
                  <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                    Restaurée depuis la v{r.restoredFromVersionNumber}
                  </Text>
                )}
                {canEdit && !r.isCurrent && (
                  <Popconfirm
                    title={`Restaurer la version ${r.versionNumber} ?`}
                    description={`Une nouvelle version sera créée à partir de la v${r.versionNumber} ; l'historique est conservé.`}
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
                      Restaurer
                    </Button>
                  </Popconfirm>
                )}
              </div>
              <div
                style={{ display: 'flex', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                  {dayjs(r.createdAt).format('DD/MM/YYYY HH:mm')}
                </Text>
                <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                  <icons.users
                    size={13}
                    strokeWidth={1.75}
                    style={{ verticalAlign: '-2px', marginInlineEnd: 4 }}
                  />
                  {r.createdByName ?? 'Auteur non journalisé'}
                </Text>
              </div>
              {r.changeSummary && <Text style={{ fontSize: fontSize.sm }}>{r.changeSummary}</Text>}
              {r.comment && (
                <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                  {r.comment}
                </Text>
              )}
              {r.contentHash && (
                <div style={{ display: 'flex', gap: space.xs, alignItems: 'center' }}>
                  <Tooltip title={`SHA-256 : ${r.contentHash}`}>
                    <Text code style={{ fontSize: fontSize.xs }}>
                      {shortHash(r.contentHash)}
                    </Text>
                  </Tooltip>
                  <Button
                    type="text"
                    size="small"
                    icon={<icons.check size={14} />}
                    aria-label={`Copier l'empreinte SHA-256 de la version ${r.versionNumber}`}
                    onClick={() => void copyHash(r.contentHash as string)}
                  />
                </div>
              )}
              {r.files.length > 0 && (
                <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap' }}>
                  {r.files.map((f) => (
                    <Button
                      key={f.fileId}
                      type="link"
                      size="small"
                      style={{ paddingInline: 0 }}
                      icon={<icons.view size={14} />}
                      aria-label={`Ouvrir ${f.originalName ?? `le fichier ${f.fileId}`} (version ${r.versionNumber})`}
                      onClick={() => void openFile(r.documentVersionId, f.fileId)}
                    >
                      Ouvrir{f.originalName ? ` — ${f.originalName}` : ''}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          ),
        }))}
      />
    );
  }

  return (
    <>
      {header}
      {body}
      <Modal
        title="Nouvelle version"
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => void submitNew()}
        okText="Créer la version"
        cancelText="Annuler"
        confirmLoading={submitting}
        okButtonProps={{ disabled: fileList.length === 0 }}
        destroyOnHidden
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: space.md }}>
          Le fichier déposé devient la version courante. La version actuelle est conservée dans
          l&apos;historique et reste consultable.
        </Text>
        <Form layout="vertical">
          <Form.Item label="Fichier PDF" required>
            <Upload
              accept=".pdf,application/pdf"
              maxCount={1}
              fileList={fileList}
              // Pas d'envoi automatique : le fichier part avec le résumé, en un seul POST.
              beforeUpload={(file) => {
                if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
                  message.error('Seuls les fichiers PDF sont acceptés.');
                  return Upload.LIST_IGNORE;
                }
                return false;
              }}
              onChange={({ fileList: l }) => setFileList(l.slice(-1))}
            >
              <Button icon={<icons.upload size={16} />}>Choisir un PDF</Button>
            </Upload>
          </Form.Item>
          <Form.Item label="Résumé du changement (facultatif)">
            <Input.TextArea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={500}
              showCount
              rows={3}
              placeholder="Ex. : pages 3 et 4 remplacées après correction"
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
