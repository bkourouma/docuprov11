'use client';

import { useEffect, useState } from 'react';
import { Progress, Typography } from 'antd';
import { icons } from '../theme/icons';
import { fontSize, radii } from '../theme/tokens';

/**
 * Suivi du chargement d'un lot — barre de progression « X / N fichiers traités ».
 *
 * Pilotée par le statut du lot (0=en cours, 1=prêt, 2=échec) et le nombre de fichiers déjà
 * traités. Vaut pour les deux modes : « sans intercalaire » (tous les fichiers fusionnés en un
 * document) et « avec intercalaires » (QR + OCR, plusieurs documents). `documentCount` indique
 * le nombre de documents produits.
 */
export type PipelinePhase = 'uploading' | 'processing' | 'ready' | 'failed';

/** Étapes informatives du pipeline « avec intercalaires » (QR + OCR). Purement explicatif : on ne
 * dispose pas d'un signal par sous-étape côté API, seulement du statut global du lot. */
const QR_STAGES = [
  'Téléversement',
  'Analyse QR + OCR',
  'Découpage en documents',
  'Finalisation',
] as const;

function PipelineLegend({ phase }: { phase: PipelinePhase }) {
  const activeIndex =
    phase === 'uploading' ? 0 : phase === 'processing' ? 1 : phase === 'ready' ? 3 : 0;
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
      {QR_STAGES.map((label, i) => {
        const done = phase === 'ready' ? true : i < activeIndex;
        const active = i === activeIndex && phase !== 'ready' && phase !== 'failed';
        return (
          <span
            key={label}
            className="da-pill"
            style={{
              fontSize: fontSize.xs,
              padding: '3px 10px',
              background:
                done || active ? 'var(--ant-color-primary-bg)' : 'var(--ant-color-fill-quaternary)',
              color: done || active ? 'var(--ant-color-primary)' : 'var(--ant-color-text-tertiary)',
              fontWeight: active ? 600 : 400,
            }}
          >
            {done && !active ? '✓ ' : ''}
            {label}
          </span>
        );
      })}
    </div>
  );
}

export function BatchPipeline({
  phase,
  processed,
  documentCount,
  fileCount,
  showQrStages = false,
}: {
  phase: PipelinePhase;
  processed: number;
  documentCount: number;
  fileCount?: number;
  /** Affiche la légende des étapes QR + OCR — pertinent seulement en mode « avec intercalaires ». */
  showQrStages?: boolean;
}) {
  const total = fileCount && fileCount > 0 ? fileCount : undefined;
  const done = phase === 'ready' || phase === 'failed';

  // Progression composite sur toute la chaîne : téléversement 0→30 %, traitement 30→95 %.
  // Ainsi la barre ne reste plus figée (ex. à 5 %) pendant la file d'attente ou l'assemblage
  // final du PDF : chaque étape occupe une plage dédiée.
  const base = done
    ? 100
    : phase === 'uploading'
      ? total
        ? Math.round((processed / total) * 30)
        : 2
      : total
        ? 30 + Math.round((processed / total) * 62)
        : 30;

  // « Creep » temporel : dans les phases sans signal (attente en file, fusion/écriture du gros
  // PDF final), la barre avance doucement toute seule (+1 % / 2,5 s, plafonné) pour montrer
  // que le traitement continue. Remis à zéro dès qu'une vraie progression arrive.
  const [creep, setCreep] = useState(0);
  useEffect(() => {
    setCreep(0);
  }, [base]);
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setCreep((c) => Math.min(c + 1, 7)), 2500);
    return () => clearInterval(id);
  }, [done]);

  const percent = done ? 100 : Math.min(base + creep, 97);

  const status: 'active' | 'success' | 'exception' =
    phase === 'ready' ? 'success' : phase === 'failed' ? 'exception' : 'active';

  const Glyph = phase === 'failed' ? icons.alert : phase === 'ready' ? icons.validated : icons.scan;

  const message =
    phase === 'failed'
      ? 'Le traitement du lot a échoué.'
      : phase === 'ready'
        ? 'Traitement terminé — document(s) prêt(s) à être indexé(s).'
        : phase === 'uploading'
          ? `Téléversement${total ? ` de ${total} fichier(s)` : ''}…`
          : processed === 0
            ? 'Lot en file d’attente — le traitement démarre (les gros lots peuvent prendre plusieurs minutes)…'
            : 'Traitement en cours…';

  return (
    <div
      style={{
        padding: '24px',
        borderRadius: radii.card,
        background: 'var(--ant-color-bg-layout)',
        border: '1px solid var(--ant-color-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: radii.base,
            display: 'grid',
            placeItems: 'center',
            flex: 'none',
            background:
              phase === 'failed' ? 'var(--ant-color-error-bg)' : 'var(--ant-color-primary-bg)',
            color: phase === 'failed' ? 'var(--ant-color-error)' : 'var(--ant-color-primary)',
          }}
        >
          <Glyph
            size={20}
            strokeWidth={2}
            style={
              phase === 'processing' ? { animation: 'da-spin 1.6s linear infinite' } : undefined
            }
          />
        </span>
        <div style={{ lineHeight: 1.3 }}>
          <Typography.Text strong style={{ display: 'block' }}>
            {message}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: fontSize.sm }}>
            <span
              className="da-mono"
              style={{ fontWeight: 600, color: 'var(--ant-color-primary)' }}
            >
              {processed}
            </span>
            {total ? ` / ${total}` : ''} fichier{processed > 1 ? 's' : ''}{' '}
            {phase === 'uploading' ? 'envoyé' : 'traité'}
            {processed > 1 ? 's' : ''}
            {documentCount > 0
              ? ` · ${documentCount} document${documentCount > 1 ? 's' : ''} produit${documentCount > 1 ? 's' : ''}`
              : ''}
          </Typography.Text>
        </div>
      </div>

      <Progress
        percent={percent}
        status={status}
        strokeColor={phase === 'failed' ? undefined : 'var(--ant-color-primary)'}
      />
      {showQrStages && phase !== 'failed' && <PipelineLegend phase={phase} />}
    </div>
  );
}
