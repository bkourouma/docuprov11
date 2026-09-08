'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Modal, Space } from 'antd';
import { EmptyState } from '../EmptyState';
import { PdfViewer } from '../viewer/PdfViewer';
import { downloadFicheImputation, ficheImputationPdfUrl } from '../../lib/courriers';
import { space } from '../../theme/tokens';

/**
 * Fiche d'Imputation (§09) : aperçu PDF + Imprimer + Télécharger (DOCX).
 * Le DOCX remplit le gabarit du Sénat (fidèle) ; le PDF est un re-rendu de contenu identique —
 * le source, lui, convertit le DOCX, ce que la stack V6 ne permet pas (écart validé).
 */
export function FicheImputationModal({
  mailId,
  onClose,
}: {
  mailId: number | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Génère l'aperçu à l'ouverture ; le blob est révoqué à la fermeture (pas de fuite mémoire).
  useEffect(() => {
    if (mailId == null) return;
    let cancelled = false;
    let created: string | null = null;
    setLoading(true);
    setUrl(null);
    void (async () => {
      try {
        const u = await ficheImputationPdfUrl(mailId);
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        created = u;
        setUrl(u);
      } catch (e) {
        if (!cancelled) message.error(e instanceof Error ? e.message : 'Fiche indisponible');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [mailId, message]);

  // Impression : on imprime le blob déjà chargé plutôt que de régénérer un second PDF.
  // (La visionneuse expose le même bouton dans sa barre d'outils ; celui-ci reste en pied
  // de fenêtre car c'est l'action attendue sur une fiche d'imputation.)
  const print = useCallback(() => {
    if (!url) return;
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    frame.src = url;
    frame.onload = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    };
    document.body.appendChild(frame);
    window.setTimeout(() => frame.remove(), 120_000);
  }, [url]);

  const download = useCallback(async () => {
    if (mailId == null) return;
    setBusy(true);
    try {
      await downloadFicheImputation(mailId);
      message.success('Fiche téléchargée (DOCX).');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Téléchargement impossible');
    } finally {
      setBusy(false);
    }
  }, [mailId, message]);

  return (
    <Modal
      open={mailId != null}
      onCancel={onClose}
      width="70%"
      style={{ top: space.xl }}
      destroyOnHidden
      title="Fiche d'imputation"
      footer={
        // Actions sur le document à gauche, sortie à droite : le pied reste lisible même quand
        // les libellés s'allongent.
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: space.sm }}>
          <Space size="small">
            <Button onClick={print} disabled={!url}>
              Imprimer
            </Button>
            <Button loading={busy} onClick={() => void download()}>
              Télécharger (DOCX)
            </Button>
          </Space>
          <Button type="primary" onClick={onClose}>
            Fermer
          </Button>
        </div>
      }
    >
      <div style={{ height: 'calc(100vh - 260px)' }}>
        <PdfViewer
          src={url}
          loading={loading}
          fileName={`fiche-imputation-${mailId ?? ''}.pdf`}
          empty={<EmptyState compact icon="document" title="Aperçu indisponible" />}
        />
      </div>
    </Modal>
  );
}
