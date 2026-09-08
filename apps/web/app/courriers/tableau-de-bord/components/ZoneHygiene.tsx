'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Alert, Button, Card, Typography } from 'antd';
import { fmtInt } from '../../../theme/charts';
import type { HygieneIndicateur, HygieneResponse } from '../lib/api';

/**
 * Zone 9 — hygiène des données. Repliée par défaut : elle explique les autres indicateurs plutôt
 * que d'en produire un de plus, et n'a pas à concurrencer les alertes en haut de page.
 *
 * Chaque ligne affiche sa **conséquence** avant son compteur. « 17 courriers sans échéance »
 * n'appelle aucune action ; « 17 courriers qu'aucune relance ne signalera » si.
 */
export function ZoneHygiene({ data, loading }: { data: HygieneResponse | null; loading: boolean }) {
  const [ouvert, setOuvert] = useState(false);

  const anomalies = data?.indicateurs.filter((i) => i.count > 0) ?? [];
  const total = anomalies.length;

  if (loading && !data) return null;
  if (!data) return null;

  if (total === 0) {
    return (
      <Alert type="success" showIcon message="Aucun défaut de saisie ou de paramétrage détecté." />
    );
  }

  return (
    <Card styles={{ body: { padding: 16 } }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          <strong>{total}</strong> point(s) de vigilance dégradent la fiabilité des indicateurs
          ci-dessus.
        </Typography.Text>
        <Button size="small" type="link" onClick={() => setOuvert((v) => !v)}>
          {ouvert ? 'Masquer' : 'Voir le détail'}
        </Button>
      </div>

      {ouvert && (
        <div style={{ marginTop: 12 }}>
          {anomalies.map((i) => (
            <Ligne key={i.cle} indicateur={i} />
          ))}
        </div>
      )}
    </Card>
  );
}

function Ligne({ indicateur }: { indicateur: HygieneIndicateur }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 16,
        padding: '8px 0',
        borderTop: '1px solid var(--ant-color-border-secondary)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Typography.Text style={{ fontSize: 13 }}>
          {indicateur.lien ? (
            <Link href={indicateur.lien}>{indicateur.label}</Link>
          ) : (
            indicateur.label
          )}
        </Typography.Text>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {indicateur.consequence}
          </Typography.Text>
        </div>
      </div>
      <span className="da-mono" style={{ fontSize: 15, fontWeight: 600, flex: 'none' }}>
        {fmtInt(indicateur.count)}
      </span>
    </div>
  );
}
