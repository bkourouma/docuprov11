'use client';

import { Col, Row, Table, Typography } from 'antd';
import { KpiCard } from '../../../components/KpiCard';
import { ChartCard } from '../../../dashboards/components/ChartCard';
import { fmtInt } from '../../../theme/charts';
import { MAIL_TYPE_LABELS, type SyntheseParType, type SyntheseResponse } from '../lib/api';

/**
 * Zone 3 — chiffres clés de la période.
 *
 * Deux partis pris :
 *  - **« En cours » ignore la période** : c'est un stock, pas un flux. Le soumettre au filtre ferait
 *    disparaître un courrier ouvert depuis trois mois d'une vue « 30 derniers jours » — exactement
 *    celui qu'il faut voir.
 *  - **Le délai est donné en médiane ET en P90**, jamais en moyenne : sur de petits volumes avec
 *    des valeurs extrêmes, une moyenne est ininterprétable.
 */
export function ZoneSynthese({
  data,
  loading,
}: {
  data: SyntheseResponse | null;
  loading: boolean;
}) {
  const enAttente = loading && !data;

  return (
    <>
      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <KpiCard
            icon="add"
            label="Enregistrés"
            value={data ? data.enregistres.valeur : null}
            variation={data?.enregistres}
            hint="Sur la période sélectionnée"
            loading={enAttente}
          />
        </Col>
        <Col xs={12} lg={6}>
          <KpiCard
            icon="validated"
            label="Archivés"
            value={data ? data.traites.valeur : null}
            variation={data?.traites}
            hint="Sur la période sélectionnée"
            loading={enAttente}
          />
        </Col>
        <Col xs={12} lg={6}>
          <KpiCard
            icon="pending"
            label="En cours"
            value={data ? data.enCours : null}
            hint="Stock total — indépendant de la période"
            href="/courriers/suivi"
            loading={enAttente}
          />
        </Col>
        <Col xs={12} lg={6}>
          <KpiCard
            icon="analytics"
            label="Délai de traitement"
            value={data?.delaiMedianJours ?? null}
            suffix="j (médiane)"
            hint={
              data?.delaiP90Jours != null
                ? `90 % traités en moins de ${data.delaiP90Jours} j`
                : 'Aucun courrier archivé sur la période'
            }
            // Un délai qui s'allonge est une mauvaise nouvelle.
            hausseDefavorable
            loading={enAttente}
          />
        </Col>
      </Row>

      <div style={{ marginTop: 16 }}>
        <DetailParType lignes={data?.parType ?? []} loading={enAttente} />
      </div>
    </>
  );
}

/**
 * Ventilation par type. Elle n'est pas décorative : Arrivées et Départs n'ont pas le même cycle de
 * vie. Un Départ reçoit sa date d'archivage dès sa rédaction, si bien qu'il peut compter à la fois
 * comme « archivé » et comme « en cours ». Additionner les deux flux dans un chiffre unique masque
 * cette ambiguïté ; les séparer la rend lisible.
 */
function DetailParType({ lignes, loading }: { lignes: SyntheseParType[]; loading: boolean }) {
  return (
    <ChartCard
      title="Détail par type de courrier"
      subtitle="Arrivées et Départs suivent des cycles distincts — les totaux agrégés peuvent se recouper."
      height={180}
      loading={loading}
      empty={!loading && lignes.length === 0}
      emptyText="Aucun courrier sur la période."
    >
      <Table<SyntheseParType>
        size="small"
        pagination={false}
        rowKey="mailType"
        dataSource={lignes}
        columns={[
          {
            title: 'Type',
            dataIndex: 'mailType',
            render: (t: number) => MAIL_TYPE_LABELS[t] ?? `Type ${t}`,
          },
          {
            title: 'Enregistrés',
            dataIndex: 'enregistres',
            align: 'right',
            render: (n: number) => <span className="da-mono">{fmtInt(n)}</span>,
          },
          {
            title: 'Archivés',
            dataIndex: 'traites',
            align: 'right',
            render: (n: number) => <span className="da-mono">{fmtInt(n)}</span>,
          },
          {
            title: 'En cours',
            dataIndex: 'enCours',
            align: 'right',
            render: (n: number) => <span className="da-mono">{fmtInt(n)}</span>,
          },
        ]}
        footer={() => (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            « Enregistrés » et « Archivés » portent sur la période ; « En cours » est un stock.
          </Typography.Text>
        )}
      />
    </ChartCard>
  );
}
