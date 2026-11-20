'use client';

import { Typography } from 'antd';
import { GOVERNANCE_PII_ENTITY_LABELS, type GovernancePiiFinding } from '@archivage/types';
import { percent } from './labels';

/**
 * Familles de données personnelles trouvées. L'API ne fournit JAMAIS les valeurs : seulement un
 * compte, une confiance et des contextes déjà masqués, rendus ici comme texte brut.
 */
export function PiiFindings({ findings }: { findings: GovernancePiiFinding[] }) {
  return (
    <ul className="gov-pii" aria-label="Familles de données personnelles trouvées">
      {findings.map((f) => (
        <li key={f.entity}>
          <Typography.Text strong>{GOVERNANCE_PII_ENTITY_LABELS[f.entity]}</Typography.Text>
          <Typography.Text type="secondary">
            {' '}
            · {f.count} occurrence(s) · confiance {percent(f.confidence)}
          </Typography.Text>
          {f.contexts.length > 0 && (
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              {f.contexts.map((c, i) => (
                <pre key={i} className="gov-excerpt" style={{ maxHeight: 120 }}>
                  {c}
                </pre>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
