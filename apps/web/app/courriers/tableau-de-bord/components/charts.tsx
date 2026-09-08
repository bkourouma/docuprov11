'use client';

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import { Skeleton } from 'antd';
import { fmtDateFr, fmtInt, useChartTheme } from '../../../theme/charts';
import type { FluxPoint, RepartitionTranche } from '../lib/api';

// Import client-only : @ant-design/plots (G2 v5) ne supporte pas le rendu serveur. Le cast évite
// le bruit de typage des props G2 — même parti pris que `dashboards/components/charts.tsx`.
const loading = () => <Skeleton active paragraph={{ rows: 5 }} />;
const Column = dynamic(() => import('@ant-design/plots').then((m) => m.Column), {
  ssr: false,
  loading,
}) as ComponentType<Record<string, unknown>>;
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

/**
 * Entrées et sorties par période, en barres groupées.
 *
 * Les séries sont mises au format long ({ bucket, serie, valeur }) : c'est ce que G2 attend pour
 * grouper, et cela garde les seaux vides — le service les renvoie à zéro plutôt que de les omettre,
 * sans quoi la courbe relierait deux dates non contiguës comme si rien ne s'était passé entre elles.
 */
export function FluxColonnes({ points, height = 260 }: { points: FluxPoint[]; height?: number }) {
  const t = useChartTheme();
  const data = points.flatMap((p) => [
    { bucket: p.bucket, serie: 'Entrées', valeur: p.entrees },
    { bucket: p.bucket, serie: 'Sorties', valeur: p.sorties },
  ]);

  return (
    <Column
      data={data}
      xField="bucket"
      yField="valeur"
      colorField="serie"
      group
      height={height}
      autoFit
      animate={false}
      scale={{ color: { range: [t.palette[0], t.palette[2]] } }}
      axis={{
        x: { labelFormatter: (v: string) => fmtDateFr(v), labelFill: t.label },
        y: { labelFormatter: (v: number) => fmtInt(v), labelFill: t.label },
      }}
      legend={{ color: { itemLabelFill: t.label } }}
    />
  );
}

/**
 * Backlog cumulé. La courbe démarre au stock ANTÉRIEUR à la fenêtre (`backlogInitial`) : sans cette
 * amorce, elle repartirait de zéro à chaque changement de période et sous-évaluerait grossièrement
 * l'encours. C'est la courbe qui dit si l'organisation décroche.
 */
export function BacklogAire({ points, height = 200 }: { points: FluxPoint[]; height?: number }) {
  const t = useChartTheme();
  return (
    <Area
      data={points}
      xField="bucket"
      yField="backlogNet"
      height={height}
      autoFit
      animate={false}
      style={{ fill: t.primary, fillOpacity: 0.4 }}
      axis={{
        x: { labelFormatter: (v: string) => fmtDateFr(v), labelFill: t.label },
        y: {
          labelFormatter: (v: number) => fmtInt(v),
          title: 'Encours',
          labelFill: t.label,
          titleFill: t.label,
        },
      }}
      legend={false}
    />
  );
}

/** Anneau — composition d'une dimension à faible cardinalité (statut, type). */
export function RepartitionAnneau({
  tranches,
  height = 260,
}: {
  tranches: RepartitionTranche[];
  height?: number;
}) {
  const t = useChartTheme();
  return (
    <Pie
      data={tranches}
      angleField="valeur"
      colorField="label"
      innerRadius={0.6}
      height={height}
      autoFit
      animate={false}
      scale={{ color: { range: t.palette } }}
      label={false}
      legend={{ color: { itemLabelFill: t.label, maxRows: 3 } }}
    />
  );
}

/** Barres horizontales — dimensions à libellés longs (correspondants, services, objets). */
export function RepartitionBarres({
  tranches,
  height = 260,
}: {
  tranches: RepartitionTranche[];
  height?: number;
}) {
  const t = useChartTheme();
  return (
    <Bar
      data={tranches}
      xField="label"
      yField="valeur"
      height={height}
      autoFit
      animate={false}
      style={{ fill: t.primary }}
      axis={{
        x: { labelFill: t.label },
        y: { labelFormatter: (v: number) => fmtInt(v), labelFill: t.label },
      }}
      legend={false}
    />
  );
}
