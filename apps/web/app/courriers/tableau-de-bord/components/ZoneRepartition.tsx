'use client';

import { Col, Row, Select, Typography } from 'antd';
import { ChartCard } from '../../../dashboards/components/ChartCard';
import { fmtInt } from '../../../theme/charts';
import { RepartitionAnneau, RepartitionBarres } from './charts';
import type { RepartitionDimension, RepartitionResponse } from '../lib/api';

/**
 * Dimensions proposées. `nature`, `objet` et `confidentialite` restent exploitables en lecture
 * bien que leurs écrans de paramétrage soient masqués : les colonnes sont peuplées à la saisie.
 */
const DIMENSIONS: { value: RepartitionDimension; label: string }[] = [
  { value: 'type', label: 'Type de courrier' },
  { value: 'statut', label: 'Statut' },
  { value: 'correspondant', label: 'Correspondant' },
  { value: 'type_entite', label: "Type d'entité externe" },
  { value: 'service', label: 'Service (Arrivées)' },
  { value: 'nature', label: 'Nature' },
  { value: 'objet', label: 'Objet' },
  { value: 'confidentialite', label: 'Confidentialité' },
  { value: 'type_depart', label: 'Type de départ' },
];

/** Dimensions à faible cardinalité : l'anneau y est lisible ; ailleurs, des barres horizontales. */
const ANNEAU: RepartitionDimension[] = ['type', 'statut', 'confidentialite'];

export function ZoneRepartition({
  data,
  loading,
  dimension,
  onDimensionChange,
}: {
  data: RepartitionResponse | null;
  loading: boolean;
  dimension: RepartitionDimension;
  onDimensionChange: (d: RepartitionDimension) => void;
}) {
  const vide = !loading && (!data || data.tranches.length === 0);
  const enAnneau = ANNEAU.includes(dimension);

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={14}>
        <ChartCard
          title="Répartition"
          subtitle={
            data ? (
              <>
                <span className="da-mono">{fmtInt(data.total)}</span> courriers sur la période
                {data.tranches.some((t) => t.label === 'Autres') &&
                  ' · 8 premières valeurs + « Autres »'}
              </>
            ) : undefined
          }
          height={260}
          loading={loading && !data}
          empty={vide}
          emptyText="Aucun courrier sur la période."
          extra={
            <Select<RepartitionDimension>
              size="small"
              style={{ minWidth: 190 }}
              options={DIMENSIONS}
              value={dimension}
              onChange={onDimensionChange}
            />
          }
        >
          {data &&
            (enAnneau ? (
              <RepartitionAnneau tranches={data.tranches} />
            ) : (
              <RepartitionBarres tranches={data.tranches} />
            ))}
        </ChartCard>
      </Col>

      <Col xs={24} lg={10}>
        <ChartCard
          title="Détail"
          subtitle="La tranche « non renseignée » est toujours affichée en dernier, jamais fondue dans « Autres »."
          height={260}
          loading={loading && !data}
          empty={vide}
          emptyText="Aucun courrier sur la période."
        >
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {data?.tranches.map((t) => {
              const part = data.total > 0 ? t.valeur / data.total : 0;
              const nonRenseigne = t.label.startsWith('—');
              return (
                <div
                  key={t.label}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '4px 0',
                  }}
                >
                  <Typography.Text
                    ellipsis={{ tooltip: t.label }}
                    type={nonRenseigne ? 'secondary' : undefined}
                    style={{ fontSize: 13, minWidth: 0 }}
                  >
                    {t.label}
                  </Typography.Text>
                  <span style={{ flex: 'none' }}>
                    <span className="da-mono" style={{ fontSize: 13 }}>
                      {fmtInt(t.valeur)}
                    </span>
                    <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                      {(part * 100).toFixed(0)} %
                    </Typography.Text>
                  </span>
                </div>
              );
            })}
          </div>
        </ChartCard>
      </Col>
    </Row>
  );
}
