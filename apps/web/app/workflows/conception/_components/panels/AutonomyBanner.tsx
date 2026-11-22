'use client';

import type { WfAutonomyKey } from '@archivage/types';
import { autonomyBanner, type BannerTone } from '../../../_lib/guardrails-logic';

const GLYPHS: Record<BannerTone, string> = { warning: '⚠', info: 'ℹ', success: '✓' };
const TONE_WORDS: Record<BannerTone, string> = { warning: 'Attention', info: 'Information', success: 'Bon à savoir' };

export interface AutonomyBannerProps {
  level: WfAutonomyKey;
}

/**
 * Bandeau pédagogique sous le sélecteur de niveau d'autonomie. Le sens ne repose jamais sur la couleur seule :
 * icône + mot-clé + texte. Région `status` (annoncée quand le niveau change).
 */
export function AutonomyBanner({ level }: AutonomyBannerProps) {
  const b = autonomyBanner(level);
  return (
    <div className={`wfp-banner wfp-banner--${b.tone}`} role="status" aria-live="polite" data-level={level}>
      <span className="wfp-banner-icon" aria-hidden="true">
        {GLYPHS[b.tone]}
      </span>
      <div className="wfp-banner-body">
        <p className="wfp-banner-title">
          <span className="wfp-banner-tone">{TONE_WORDS[b.tone]} : </span>
          {b.title}
        </p>
        <p className="wfp-banner-text">{b.text}</p>
      </div>
    </div>
  );
}
