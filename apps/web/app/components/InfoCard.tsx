'use client';

import type { ReactNode } from 'react';
import { Card, Space, Typography } from 'antd';
import { icons } from '../theme/icons';

const { Text } = Typography;

/**
 * En-tête de bloc de fiche (« Document », « Métadonnée(s) », …) : icône + titre, au-dessus d'un
 * filet. Carte PLATE : rayon, bordure 1 px et absence d'ombre viennent du thème (Card) ;
 * le filet reprend la bordure de carte pour ne pas introduire un troisième gris.
 */
export function InfoCard({
  icon,
  title,
  extra,
  children,
}: {
  icon: keyof typeof icons;
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const Glyph = icons[icon];
  return (
    <Card size="small">
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          paddingBottom: 10,
          marginBottom: 12,
          borderBottom: '1px solid var(--ant-color-border)',
        }}
      >
        <Space size={8} align="center">
          <Glyph size={16} strokeWidth={1.75} style={{ color: 'var(--ant-color-primary)' }} />
          <Text strong>{title}</Text>
        </Space>
        {extra}
      </div>
      {children}
    </Card>
  );
}

/** Une ligne « Libellé : valeur » d'un `InfoCard` en lecture seule. */
export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <Text strong>{label} : </Text>
      <Text>{value}</Text>
    </div>
  );
}
