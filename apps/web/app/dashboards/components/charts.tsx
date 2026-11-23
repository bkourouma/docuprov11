'use client';

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import { Skeleton } from 'antd';
import { fmtDateFr, fmtInt, useChartTheme } from '../../theme/charts';
import { radii } from '../../theme/tokens';

// @ant-design/plots est client-only (canvas, dépend de `window`) → import dynamique
// ssr:false. Casté en ComponentType<any> : l'API spec G2 v5 est permissive et on
// veut éviter le bruit de typage sur les nombreuses options.
const loading = () => <Skeleton active paragraph={{ rows: 5 }} />;
const Area = dynamic(() => import('@ant-design/plots').then((m) => m.Area), {
  ssr: false,
  loading,
}) as ComponentType<Record<string, unknown>>;
const Pie = dynamic(() => import('@ant-design/plots').then((m) => m.Pie), {
  ssr: false,
  loading,
}) as ComponentType<Record<string, unknown>>;
const Bar = dynamic(() => import('@ant-design/plots').then((m) => m.Bar), {
  ssr: false,
  loading,
}) as ComponentType<Record<string, unknown>>;

export interface TimelinePoint {
  bucket: string;
  count: number;
  cumulative: number;
}
export interface DistributionSlice {
  name: string;
  value: number;
}

/** Aire cumulée — croissance du fonds dans le temps. */
export function CumulativeArea({ data, height = 280 }: { data: TimelinePoint[]; height?: number }) {
  const t = useChartTheme();
  return (
    <Area
      data={data}
      xField="bucket"
      yField="cumulative"
      height={height}
      autoFit
      animate={false}
      style={{ fill: t.primary, fillOpacity: 0.5 }}
      axis={{
        x: { labelFormatter: (v: string) => fmtDateFr(v), labelFill: t.label, labelFontFamily: t.fontFamily },
        y: {
          labelFormatter: (v: number) => fmtInt(v),
          title: 'Fonds cumulé',
          labelFill: t.label, labelFontFamily: t.fontFamily,
          titleFill: t.label, titleFontFamily: t.fontFamily,
        },
      }}
      legend={false}
    />
  );
}

/** Anneau — composition (répartition par type, top N + Autres + Sans type). */
export function TypeDonut({ data, height = 280 }: { data: DistributionSlice[]; height?: number }) {
  const t = useChartTheme();
  return (
    <Pie
      data={data}
      angleField="value"
      colorField="name"
      innerRadius={0.6}
      height={height}
      autoFit
      animate={false}
      scale={{ color: { range: t.palette } }}
      legend={{ color: { position: 'right', maxRows: 6, itemLabelFontFamily: t.fontFamily, itemLabelFill: t.label } }}
      label={false}
    />
  );
}

/** Barres horizontales — répartition par dimension catégorielle (dossier, plan…) : les libellés longs se lisent à l'horizontale. */
export function DistributionBars({
  data,
  height = 280,
}: {
  data: DistributionSlice[];
  height?: number;
}) {
  const t = useChartTheme();
  return (
    <Bar
      data={data}
      xField="name"
      yField="value"
      height={height}
      autoFit
      animate={false}
      style={{ fill: t.primary, radiusTopRight: radii.sm, radiusBottomRight: radii.sm }}
      axis={{
        x: {
          labelAutoRotate: false,
          labelFormatter: (v: string) => v,
          labelFill: t.label, labelFontFamily: t.fontFamily,
        },
        y: { labelFormatter: (v: number) => fmtInt(v), labelFill: t.label, labelFontFamily: t.fontFamily },
      }}
      legend={false}
    />
  );
}
