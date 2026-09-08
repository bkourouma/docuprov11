'use client';

import Link from 'next/link';
import { Alert, Col, Progress, Row, Table, Typography } from 'antd';
import { ChartCard } from '../../../dashboards/components/ChartCard';
import { fmtInt } from '../../../theme/charts';
import type { RetardsBucket, RetardsResponse, TopRetard } from '../lib/api';

/**
 * Zone 6a — retards.
 *
 * Les paliers reprennent EXACTEMENT les bornes de `bucketPalier` (domaine testé) ; l'ancienneté,
 * celles de `bucketAnciennete`. Aucune borne n'est réécrite ici : les deux définitions ne peuvent
 * donc pas diverger.
 */
export function ZoneRetards({ data, loading }: { data: RetardsResponse | null; loading: boolean }) {
  const enAttente = loading && !data;
  const totalPaliers = data?.paliers.reduce((a, b) => a + b.count, 0) ?? 0;
  const totalAge = data?.anciennete.reduce((a, b) => a + b.count, 0) ?? 0;

  return (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <ChartCard
            title="Échéances des courriers en cours"
            subtitle="Les relances automatiques ne se déclenchent qu'à J-7, J-3, J-1 et J0 : tout le reste est muet."
            height={200}
            loading={enAttente}
            empty={!enAttente && totalPaliers === 0}
            emptyText="Aucun courrier en cours avec une échéance."
          >
            <Barres buckets={data?.paliers ?? []} total={totalPaliers} alerteSur={['retard']} />
          </ChartCard>
        </Col>

        <Col xs={24} lg={12}>
          <ChartCard
            title="Ancienneté du backlog"
            subtitle="Indépendante de l'échéance — seul filet pour les courriers qui n'en ont pas."
            height={200}
            loading={enAttente}
            empty={!enAttente && totalAge === 0}
            emptyText="Aucun courrier en cours."
          >
            <Barres buckets={data?.anciennete ?? []} total={totalAge} alerteSur={['plus_30']} />
          </ChartCard>
        </Col>
      </Row>

      {data && data.sansEcheance > 0 && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message={
            <>
              <strong>{fmtInt(data.sansEcheance)}</strong> courrier(s) en cours{' '}
              <strong>sans date butoir</strong>
            </>
          }
          description="Sans échéance, ils ne sont jamais « en retard » : aucune relance ne les signalera, et ils n'apparaissent pas dans les paliers ci-dessus. Seule leur ancienneté les rattrape."
        />
      )}

      <div style={{ marginTop: 16 }}>
        <ChartCard
          title="Retards les plus anciens"
          subtitle="Cliquez une ligne pour ouvrir le courrier."
          height={240}
          loading={enAttente}
          empty={!enAttente && (data?.top.length ?? 0) === 0}
          emptyText="Aucun courrier en retard."
        >
          <Table<TopRetard>
            size="small"
            rowKey="mailId"
            pagination={false}
            scroll={{ y: 240 }}
            dataSource={data?.top ?? []}
            columns={[
              {
                title: 'Courrier',
                dataIndex: 'title',
                ellipsis: true,
                render: (titre: string, r) => (
                  <Link href={`/courriers/suivi/${r.mailId}`}>{titre}</Link>
                ),
              },
              { title: 'Référence', dataIndex: 'reference', width: 130, ellipsis: true },
              {
                title: 'Retard',
                dataIndex: 'joursRetard',
                width: 100,
                align: 'right',
                render: (j: number) => (
                  <span className="da-mono" style={{ color: 'var(--ant-color-error)' }}>
                    {fmtInt(j)} j
                  </span>
                ),
              },
            ]}
          />
        </ChartCard>
      </div>
    </>
  );
}

/**
 * Barres proportionnelles. Les tranches à zéro restent affichées : une tranche absente se lit
 * « pas de données », une tranche à zéro se lit « rien dans cet état » — ce n'est pas pareil.
 */
function Barres({
  buckets,
  total,
  alerteSur,
}: {
  buckets: RetardsBucket[];
  total: number;
  alerteSur: string[];
}) {
  return (
    <div>
      {buckets.map((b) => {
        const part = total > 0 ? b.count / total : 0;
        const alerte = alerteSur.includes(b.cle) && b.count > 0;
        return (
          <div key={b.cle} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <Typography.Text style={{ fontSize: 12 }} type={alerte ? undefined : 'secondary'}>
                {b.label}
              </Typography.Text>
              <span
                className="da-mono"
                style={{ fontSize: 12, color: alerte ? 'var(--ant-color-error)' : undefined }}
              >
                {fmtInt(b.count)}
              </span>
            </div>
            <Progress
              percent={Math.round(part * 100)}
              showInfo={false}
              size="small"
              strokeColor={alerte ? 'var(--ant-color-error)' : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
