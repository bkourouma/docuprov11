'use client';

import Link from 'next/link';
import { Alert, Col, Progress, Row, Typography } from 'antd';
import { ChartCard } from '../../../dashboards/components/ChartCard';
import { fmtInt } from '../../../theme/charts';
import type { DelaiStat, DelaisResponse } from '../lib/api';
import { InfoTooltip } from '../../../components/InfoTooltip';

/** Sous ce seuil, un percentile n'a pas de sens : on l'affiche mais on le signale. */
const EFFECTIF_MINIMAL = 5;

/**
 * Zone 6b — délais et respect des engagements.
 *
 * Trois choix qui portent la crédibilité de cette zone :
 *  - **jamais de moyenne** : médiane + P90, sur de petits volumes une moyenne est ininterprétable ;
 *  - **l'effectif est affiché** : un délai médian calculé sur 2 dossiers doit se voir comme tel ;
 *  - **le délai d'imputation est ségrégé** auto/manuel, sinon l'auto-traitement à la lecture tire
 *    la médiane vers zéro et fait passer un artefact pour une performance.
 */
export function ZoneDelais({ data, loading }: { data: DelaisResponse | null; loading: boolean }) {
  const enAttente = loading && !data;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <ChartCard
          title="Délais de traitement"
          subtitle="Médiane et 90ᵉ centile — la moyenne serait trompeuse sur ces volumes."
          height={200}
          loading={enAttente}
          empty={!enAttente && !data}
        >
          <LigneDelai
            libelle="Prise en charge"
            aide="De la date du courrier à son enregistrement au bureau d'ordre."
            stat={data?.priseEnCharge}
          />
          <LigneDelai
            libelle="Traitement complet"
            aide="De l'enregistrement à l'archivage. Pour un Départ, la date d'archivage est celle de décharge."
            stat={data?.traitementGlobal}
          />
          <div style={{ marginTop: 12 }}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              Imputations — ségrégées, car les types « auto-traités » sont soldés à la simple
              lecture du courrier :
            </Typography.Text>
          </div>
          <LigneDelai
            libelle="Imputations (travail réel)"
            aide="Types sans auto-traitement : le délai reflète un traitement effectif."
            stat={data?.imputations.manuel}
          />
          <LigneDelai
            libelle="Imputations (auto-traitées)"
            aide="Soldées à l'ouverture du courrier : un délai proche de zéro n'y est pas une performance."
            stat={data?.imputations.auto}
            attenue
          />
        </ChartCard>
      </Col>

      <Col xs={24} lg={12}>
        <ChartCard
          title="Respect des délais (SLA)"
          subtitle="Comparaison au délai de suivi paramétré sur l'objet du courrier."
          height={200}
          loading={enAttente}
          empty={false}
        >
          {data && <BlocSla sla={data.sla} />}
        </ChartCard>
      </Col>
    </Row>
  );
}

function LigneDelai({
  libelle,
  aide,
  stat,
  attenue,
}: {
  libelle: string;
  aide: string;
  stat?: DelaiStat;
  attenue?: boolean;
}) {
  const faible = (stat?.n ?? 0) > 0 && (stat?.n ?? 0) < EFFECTIF_MINIMAL;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        padding: '5px 0',
      }}
    >
      <InfoTooltip title={aide}>
        <Typography.Text style={{ fontSize: 13 }} type={attenue ? 'secondary' : undefined}>
          {libelle}
        </Typography.Text>
      </InfoTooltip>
      <span style={{ flex: 'none', textAlign: 'right' }}>
        {stat && stat.medianeJours !== null ? (
          <>
            <span className="da-mono" style={{ fontSize: 15, fontWeight: 600 }}>
              {stat.medianeJours} j
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
              P90 {stat.p90Jours ?? '—'} j · n={fmtInt(stat.n)}
              {faible && ' ⚠︎'}
            </Typography.Text>
          </>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Aucune donnée sur la période
          </Typography.Text>
        )}
      </span>
    </div>
  );
}

/**
 * Le SLA n'est calculable que si l'objet du courrier porte une durée de suivi. Quand ce n'est le
 * cas nulle part, on affiche la CAUSE et le geste correctif — un graphique vide laisserait croire
 * à une absence de courriers, alors que c'est un défaut de paramétrage.
 */
function BlocSla({ sla }: { sla: DelaisResponse['sla'] }) {
  if (!sla.configure) {
    return (
      <Alert
        type="info"
        showIcon
        message="SLA non configuré"
        description={
          <>
            Aucun objet de courrier ne porte de durée de suivi exploitable
            {sla.objetsSansDuree > 0 && <> ({fmtInt(sla.objetsSansDuree)} objet(s) à zéro)</>}.{' '}
            {sla.lienConfiguration ? (
              <>
                Renseignez les durées dans{' '}
                <Link href={sla.lienConfiguration}>Objets de courrier</Link> pour activer cet
                indicateur.
              </>
            ) : (
              // L'écran de paramétrage est masqué : proposer un lien inatteignable pour un
              // non-admin serait pire que de n'en proposer aucun.
              <>
                Les durées se règlent sur l’objet du courrier, dont l’écran de paramétrage n’est pas
                ouvert : demandez à un administrateur de les renseigner.
              </>
            )}
          </>
        }
      />
    );
  }

  const evalues = sla.dansLesDelais + sla.horsDelais;
  const taux = evalues > 0 ? sla.dansLesDelais / evalues : 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span
          className="da-mono"
          style={{
            fontSize: 28,
            fontWeight: 600,
            color: taux >= 0.8 ? 'var(--ant-color-success)' : 'var(--ant-color-warning)',
          }}
        >
          {Math.round(taux * 100)} %
        </span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          traités dans les délais
        </Typography.Text>
      </div>

      <Progress
        percent={Math.round(taux * 100)}
        showInfo={false}
        strokeColor={taux >= 0.8 ? 'var(--ant-color-success)' : 'var(--ant-color-warning)'}
      />

      <div style={{ marginTop: 8, fontSize: 12 }}>
        <Typography.Text type="secondary">
          {fmtInt(sla.dansLesDelais)} dans les délais · {fmtInt(sla.horsDelais)} hors délais
        </Typography.Text>
      </div>

      {sla.nonEvalues > 0 && (
        <div style={{ marginTop: 6 }}>
          <InfoTooltip title="Ces courriers n'ont pas de durée de suivi paramétrée sur leur objet. Ils ne sont comptés ni en succès ni en échec — les compter en échec fausserait l'indicateur.">
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {fmtInt(sla.nonEvalues)} courrier(s) non évalué(s)
              {sla.objetsSansDuree > 0 && (
                <>
                  {' · '}
                  {sla.lienConfiguration ? (
                    <Link href={sla.lienConfiguration}>
                      {fmtInt(sla.objetsSansDuree)} objet(s) sans durée
                    </Link>
                  ) : (
                    <>{fmtInt(sla.objetsSansDuree)} objet(s) sans durée</>
                  )}
                </>
              )}
            </Typography.Text>
          </InfoTooltip>
        </div>
      )}
    </div>
  );
}
