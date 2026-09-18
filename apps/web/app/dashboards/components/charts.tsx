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
const Column = dynamic(() => import('@ant-design/plots').then((m) => m.Column), {
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
        x: { labelFormatter: (v: string) => fmtDateFr(v), labelFill: t.label },
        y: {
          labelFormatter: (v: number) => fmtInt(v),
          title: 'Fonds cumulé',
          labelFill: t.label,
          titleFill: t.label,
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
      legend={{ color: { position: 'right', maxRows: 6 } }}
      label={false}
    />
  );
}

/** Barres — répartition par dimension catégorielle (localisation, plan…). */
export function DistributionBars({
  data,
  height = 280,
}: {
  data: DistributionSlice[];
  height?: number;
}) {
  const t = useChartTheme();
  return (
    <Column
      data={data}
      xField="name"
      yField="value"
      height={height}
      autoFit
      animate={false}
      style={{ fill: t.primary, radiusTopLeft: radii.sm, radiusTopRight: radii.sm }}
      axis={{
        x: {
          labelAutoRotate: true,
          labelAutoHide: true,
          labelFormatter: (v: string) => v,
          labelFill: t.label,
        },
        y: { labelFormatter: (v: number) => fmtInt(v), labelFill: t.label },
      }}
      legend={false}
    />
  );
}
