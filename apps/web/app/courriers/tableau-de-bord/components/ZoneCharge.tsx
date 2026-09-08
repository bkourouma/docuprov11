'use client';

import { Col, Progress, Row, Table, Tooltip, Typography } from 'antd';
import { ChartCard } from '../../../dashboards/components/ChartCard';
import { fmtInt } from '../../../theme/charts';
import type { AgentCharge, ChargeResponse, ServiceCharge } from '../lib/api';

/**
 * Zone 7 — charge de travail, en restitution nominative (arbitrage du commanditaire).
 *
 * L'écran n'est monté qu'en périmètre global ; l'API renvoie de toute façon 403 sinon, de sorte
 * qu'un appel direct ne contourne pas ce que l'interface ne montre pas.
 *
 * Deux précautions de lecture, qui évitent qu'un tableau devienne un jugement :
 *  - le **délai médian est tu sous le seuil d'effectif** — un percentile sur deux dossiers n'est
 *    pas une performance, et un classement le rendrait tranchant ;
 *  - la colonne **« traités »** figure à côté de « ouvertes » : une charge élevée sans débit et un
 *    débit élevé avec charge résiduelle ne racontent pas la même histoire.
 */
export function ZoneCharge({ data, loading }: { data: ChargeResponse | null; loading: boolean }) {
  const enAttente = loading && !data;
  const maxService = Math.max(1, ...(data?.services.map((s) => s.ouvertes) ?? [1]));

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={14}>
        <ChartCard
          title="Charge par agent"
          subtitle={
            data
              ? `Imputations ouvertes et traitées sur la période. Le délai médian n'est affiché qu'à partir de ${data.seuilEffectif} dossiers traités.`
              : undefined
          }
          height={280}
          loading={enAttente}
          empty={!enAttente && (data?.agents.length ?? 0) === 0}
          emptyText="Aucune imputation sur la période."
        >
          <Table<AgentCharge>
            size="small"
            rowKey="userGroupId"
            pagination={false}
            scroll={{ y: 260 }}
            dataSource={data?.agents ?? []}
            columns={[
              { title: 'Agent', dataIndex: 'label', ellipsis: true },
              {
                title: 'Ouvertes',
                dataIndex: 'ouvertes',
                width: 90,
                align: 'right',
                render: (n: number) => <span className="da-mono">{fmtInt(n)}</span>,
              },
              {
                title: 'Traitées',
                dataIndex: 'traitees',
                width: 90,
                align: 'right',
                render: (n: number) => <span className="da-mono">{fmtInt(n)}</span>,
              },
              {
                title: 'En retard',
                dataIndex: 'enRetard',
                width: 95,
                align: 'right',
                render: (n: number) => (
                  <span
                    className="da-mono"
                    style={{ color: n > 0 ? 'var(--ant-color-error)' : undefined }}
                  >
                    {fmtInt(n)}
                  </span>
                ),
              },
              {
                title: 'Délai médian',
                dataIndex: 'delaiMedianJours',
                width: 120,
                align: 'right',
                render: (v: number | null, r) =>
                  v === null ? (
                    <Tooltip
                      title={`Effectif insuffisant (${r.n} dossier(s) traité(s)) : une médiane n'y aurait pas de sens.`}
                    >
                      <Typography.Text type="secondary">—</Typography.Text>
                    </Tooltip>
                  ) : (
                    <span className="da-mono">{v} j</span>
                  ),
              },
            ]}
          />
        </ChartCard>
      </Col>

      <Col xs={24} lg={10}>
        <ChartCard
          title="Charge par service"
          subtitle="Un service inclut ses sous-services. Arrivées uniquement — les Départs ne portent pas d'organigramme."
          height={280}
          loading={enAttente}
          empty={!enAttente && (data?.services.length ?? 0) === 0}
          emptyText="Aucun rattachement organisationnel."
        >
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {data?.services.map((s) => (
              <LigneService key={s.organigrammeId ?? 'null'} service={s} max={maxService} />
            ))}
          </div>
        </ChartCard>
      </Col>
    </Row>
  );
}

function LigneService({ service, max }: { service: ServiceCharge; max: number }) {
  const nonRattache = service.organigrammeId === null;
  return (
    <div style={{ marginBottom: 10, paddingLeft: service.depth * 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <Typography.Text
          style={{ fontSize: 12 }}
          type={nonRattache ? 'secondary' : undefined}
          ellipsis={{ tooltip: service.label }}
        >
          {service.label}
        </Typography.Text>
        <span className="da-mono" style={{ fontSize: 12, flex: 'none' }}>
          {fmtInt(service.ouvertes)}
        </span>
      </div>
      <Progress
        percent={Math.round((service.ouvertes / max) * 100)}
        showInfo={false}
        size="small"
        strokeColor={nonRattache ? 'var(--ant-color-warning)' : undefined}
      />
    </div>
  );
}
