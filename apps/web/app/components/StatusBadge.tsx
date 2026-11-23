'use client';

import { icons } from '../theme/icons';
import { StateMark, type MarkTone } from './StateMark';

export type DocStatus = 'validated' | 'pending' | 'processing' | 'failed';

const CONFIG: Record<DocStatus, { label: string; tone: MarkTone; icon: keyof typeof icons }> = {
  validated: { label: 'Validé', tone: 'success', icon: 'validated' },
  pending: { label: 'À indexer', tone: 'warning', icon: 'pending' },
  processing: { label: 'En cours', tone: 'brand', icon: 'spinner' },
  failed: { label: 'Échec', tone: 'danger', icon: 'alert' },
};

/**
 * État d'un document ou d'un lot (vocabulaire unique dans toute l'app) : glyphe + libellé à
 * l'encre de l'état. `validated`/`pending` pour les documents ; `processing`/`failed` pour
 * les lots. Le glyphe double la couleur : l'état reste lisible sans percevoir la teinte.
 */
export function StatusBadge({ status }: { status: DocStatus }) {
  const { label, tone, icon } = CONFIG[status];
  const Glyph = icons[icon];
  return (
    <StateMark
      tone={tone}
      icon={
        <Glyph
          size={14}
          strokeWidth={2}
          aria-hidden
          style={{
            flex: 'none',
            ...(status === 'processing' ? { animation: 'da-spin 1s linear infinite' } : {}),
          }}
        />
      }
    >
      {label}
    </StateMark>
  );
}
