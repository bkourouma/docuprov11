'use client';

import { Col, Row, Skeleton } from 'antd';
import { StatTile } from '../../components/StatTile';
import { ChartCard } from './ChartCard';
import { CumulativeArea, DistributionBars, TypeDonut } from './charts';
import type { AnalyticsOverview } from '../lib/api';

/**
 * Zones du tableau de bord Docu-Archives — une par widget du catalogue serveur
 * (`analytics/dashboard-widgets.ts`).
 *
 * Toutes se nourrissent du **même** agrégat `POST /analytics/overview` : contrairement à
 * Docu-Courriers, où chaque zone a son endpoint, il n'y a donc pas de chargement à la carte. Elles
 * reçoivent l'agrégat entier et y puisent ce qui les concerne, ce qui les rend interchangeables
 * dans la grille sans que l'écran n'ait à réorganiser ses requêtes quand on ajoute ou retire un
 * widget.
 *
 * Chacune gère ses trois états — chargement, vide, garni — pour qu'un bloc lent ou sans données ne
 * laisse pas un trou muet dans une grille par ailleurs remplie.
 */
export interface PropsZone {
  data: AnalyticsOverview | null;
  loading: boolean;
}

/** Les widgets ne portent plus de titre propre : le cadre de la grille l'affiche déjà. */
const SANS_CADRE = { padding: 0 } as const;

export function ZoneKpis({ data, loading }: PropsZone) {
  if (loading && !data) return <Skeleton active paragraph={{ rows: 2 }} />;
  const k = data?.kpis;

  return (
    <Row gutter={[12, 12]} style={SANS_CADRE}>
      <Col xs={12} lg={6}>
        <StatTile
          tone="sky"
          label="Documents archivés"
          value={k?.documentsArchived ?? null}
          icon="validated"
          href="/search"
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          tone="violet"
          label="Types de document"
          value={k?.documentTypes ?? null}
          icon="documentType"
          href="/admin/document-types"
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          tone="coral"
          label="Dossiers"
          value={k?.dossiers ?? null}
          icon="dossier"
          href="/admin/dossiers"
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          tone="ink"
          label="Taux d'indexation"
          value={k ? Math.round(k.indexationRate * 100) : null}
          suffix="%"
          icon="analytics"
        />
      </Col>
    </Row>
  );
}

export function ZoneType({ data, loading }: PropsZone) {
  return (
    <ChartCard
      title="Par type de document"
      height={240}
      loading={loading}
      empty={!data?.byType.length}
    >
      {data && <TypeDonut data={data.byType} height={230} />}
    </ChartCard>
  );
}

export function ZoneDossier({ data, loading }: PropsZone) {
  return (
    <ChartCard
      title="Par dossier"
      subtitle="Documents rangés dans chaque dossier"
      height={240}
      loading={loading}
      empty={!data?.byDossier.length}
    >
      {data && <DistributionBars data={data.byDossier} height={230} />}
    </ChartCard>
  );
}

export function ZonePlan({ data, loading }: PropsZone) {
  return (
    <ChartCard
      title="Par plan de classement"
      height={240}
      loading={loading}
      empty={!data?.byPlan.length}
    >
      {data && <DistributionBars data={data.byPlan} height={230} />}
    </ChartCard>
  );
}

/**
 * Croissance du fonds. L'API renvoyait déjà `timeline` — production de la période et cumul — sans
 * qu'aucun écran ne l'affiche : la rendre disponible en widget ne coûte donc pas une requête de plus.
 */
export function ZoneEvolution({ data, loading }: PropsZone) {
  return (
    <ChartCard
      title="Croissance du fonds"
      subtitle="Fonds cumulé sur la période"
      height={240}
      loading={loading}
      empty={!data?.timeline.length}
    >
      {data && <CumulativeArea data={data.timeline} height={230} />}
    </ChartCard>
  );
}

