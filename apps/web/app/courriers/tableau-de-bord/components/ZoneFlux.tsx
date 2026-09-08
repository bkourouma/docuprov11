'use client';

import { Col, Row, Segmented, Typography } from 'antd';
import { ChartCard } from '../../../dashboards/components/ChartCard';
import { fmtInt } from '../../../theme/charts';
import { BacklogAire, FluxColonnes } from './charts';
import type { FluxResponse, Granularity } from '../lib/api';

const PAS: { label: string; value: Granularity }[] = [
  { label: 'Jour', value: 'day' },
  { label: 'Semaine', value: 'week' },
  { label: 'Mois', value: 'month' },
];

/**
 * Zone 4 — flux et encours.
 *
 * Le couple entrées/sorties dit le rythme ; la courbe d'encours dit la tendance. C'est la seconde
 * qui compte : une organisation peut traiter beaucoup et décrocher quand même, si les entrées
 * dépassent durablement les sorties.
 */
export function ZoneFlux({
  data,
  loading,
  granularity,
  onGranularityChange,
}: {
  data: FluxResponse | null;
  loading: boolean;
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
}) {
  const vide = !loading && (!data || data.points.length === 0);
  const dernier = data?.points.at(-1);
  const evolution = data && dernier ? dernier.backlogNet - data.backlogInitial : null;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={14}>
        <ChartCard
          title="Entrées et sorties"
          subtitle="Courriers enregistrés vs archivés sur la période"
          height={260}
          loading={loading && !data}
          empty={vide}
          extra={
            <Segmented<Granularity>
              size="small"
              options={PAS}
              value={granularity}
              onChange={onGranularityChange}
            />
          }
        >
          {data && <FluxColonnes points={data.points} />}
        </ChartCard>
      </Col>

      <Col xs={24} lg={10}>
        <ChartCard
          title="Encours cumulé"
          subtitle={
            data ? (
              <>
                Départ de période : <span className="da-mono">{fmtInt(data.backlogInitial)}</span>
                {evolution !== null && (
                  <>
                    {' · '}
                    <Typography.Text
                      style={{
                        fontSize: 12,
                        // Un encours qui grossit est une mauvaise nouvelle, quel que soit le volume traité.
                        color:
                          evolution > 0
                            ? 'var(--ant-color-error)'
                            : evolution < 0
                              ? 'var(--ant-color-success)'
                              : undefined,
                      }}
                    >
                      {evolution > 0 ? '+' : ''}
                      {fmtInt(evolution)} sur la période
                    </Typography.Text>
                  </>
                )}
              </>
            ) : undefined
          }
          height={200}
          loading={loading && !data}
          empty={vide}
        >
          {data && <BacklogAire points={data.points} />}
        </ChartCard>
      </Col>
    </Row>
  );
}
