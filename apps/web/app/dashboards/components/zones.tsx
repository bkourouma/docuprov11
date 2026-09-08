'use client';

import { Alert, Col, Progress, Row, Skeleton, Space, Typography } from 'antd';
import { StatTile } from '../../components/StatTile';
import { fmtInt } from '../../theme/charts';
import { ChartCard } from './ChartCard';
import { CumulativeArea, DistributionBars, ProgrammeTreemap, TypeDonut } from './charts';
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
  const p = data?.pipeline;

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
          label="En attente d'indexation"
          value={k?.documentsPending ?? null}
          icon="pending"
          href="/acquisition"
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          tone="coral"
          label="Lots en cours"
          value={p?.ouverts ?? null}
          hint={p ? `${fmtInt(p.echecs)} échec(s)` : undefined}
          icon="acquisition"
          href="/acquisition"
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

export function ZoneAnomalies({ data, loading }: PropsZone) {
  if (loading && !data) return <Skeleton active paragraph={{ rows: 1 }} />;
  const a = data?.kpis.anomalies;
  if (!a) return null;

  const total = a.sansType + a.sansDossier + a.sansDate + a.sansCote;

  // Comme les alertes de Docu-Courriers : à zéro, une ligne verte discrète plutôt qu'un tableau de
  // compteurs vides — un fonds sain doit se lire d'un coup d'œil, pas occuper l'écran.
  if (total === 0) {
    return (
      <Alert
        type="success"
        showIcon
        message="Aucune anomalie : type, dossier, date et cote sont renseignés partout."
      />
    );
  }

  return (
    <Alert
      type="warning"
      showIcon
      message={`${fmtInt(total)} document(s) présentent une anomalie de qualité`}
      description={
        <Space size={16} wrap>
          {a.sansType > 0 && <span>Sans type : {fmtInt(a.sansType)}</span>}
          {a.sansDossier > 0 && <span>Sans dossier : {fmtInt(a.sansDossier)}</span>}
          {a.sansDate > 0 && <span>Sans date : {fmtInt(a.sansDate)}</span>}
          {a.sansCote > 0 && <span>Sans cote : {fmtInt(a.sansCote)}</span>}
        </Space>
      }
    />
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

export function ZoneProgramme({ data, loading }: PropsZone) {
  return (
    <ChartCard
      title="Par programme"
      subtitle="Documents par sous-arbre de dossiers"
      height={240}
      loading={loading}
      empty={!data?.byProgramme.length}
    >
      {data && <ProgrammeTreemap data={data.byProgramme} height={230} />}
    </ChartCard>
  );
}

export function ZoneLocalisation({ data, loading }: PropsZone) {
  return (
    <ChartCard
      title="Par localisation"
      height={240}
      loading={loading}
      empty={!data?.byLocation.length}
    >
      {data && <DistributionBars data={data.byLocation} height={230} />}
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

/** Objectif du mois. Autre bloc (`objective`) que l'API calculait sans que l'écran ne le montre. */
export function ZoneObjectif({ data, loading }: PropsZone) {
  if (loading && !data) return <Skeleton active paragraph={{ rows: 3 }} />;
  const o = data?.objective;
  if (!o) return null;

  if (!o.hasTarget) {
    return (
      <Alert
        type="info"
        showIcon
        message="Aucun objectif défini pour la période"
        description="Renseignez une cible pour suivre l'avancement et le rythme quotidien nécessaire."
      />
    );
  }

  const unite = o.metric === 'pages' ? 'page(s)' : 'document(s)';
  const pct = Math.round(o.pct * 100);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Progress percent={Math.min(100, pct)} status={pct >= 100 ? 'success' : 'active'} />
      <Row gutter={[12, 12]}>
        <Col span={12}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Réalisé
          </Typography.Text>
          <div>
            <Typography.Text strong style={{ fontSize: 18 }}>
              {fmtInt(o.realized)}
            </Typography.Text>{' '}
            <Typography.Text type="secondary">
              / {fmtInt(o.target)} {unite}
            </Typography.Text>
          </div>
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Projection fin de mois
          </Typography.Text>
          <div>
            <Typography.Text strong style={{ fontSize: 18 }}>
              {fmtInt(o.projectedEndOfMonth)}
            </Typography.Text>
          </div>
        </Col>
      </Row>
      {/* Le rythme requis est l'information ACTIONNABLE : le pourcentage dit où l'on en est, lui
          dit ce qu'il reste à faire chaque jour pour y arriver. */}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Jour {o.dayOfMonth}/{o.daysInMonth} — il faut {fmtInt(Math.ceil(o.requiredDailyRate))}{' '}
        {unite} par jour pour tenir l&apos;objectif.
      </Typography.Text>
    </Space>
  );
}

/** Lots d'acquisition. Le taux d'échec est le chiffre qui déclenche une action, d'où sa mise en avant. */
export function ZonePipeline({ data, loading }: PropsZone) {
  if (loading && !data) return <Skeleton active paragraph={{ rows: 2 }} />;
  const p = data?.pipeline;
  if (!p) return null;

  const tauxEchec = Math.round(p.failureRate * 100);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        <Col xs={12}>
          <StatTile tone="sky" label="Lots terminés" value={p.termines} icon="validated" />
        </Col>
        <Col xs={12}>
          <StatTile
            tone="coral"
            label="Lots ouverts"
            value={p.ouverts}
            icon="acquisition"
            href="/acquisition"
          />
        </Col>
      </Row>
      {p.echecs > 0 ? (
        <Alert
          type="error"
          showIcon
          message={`${fmtInt(p.echecs)} lot(s) en échec — ${tauxEchec} % du total`}
          description="Un lot en échec n'entre pas dans le fonds : ses documents restent invisibles à la recherche."
        />
      ) : (
        <Alert type="success" showIcon message="Aucun lot en échec." />
      )}
    </Space>
  );
}
