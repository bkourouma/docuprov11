'use client';

import { Alert, Col, Row, Skeleton } from 'antd';
import { StatusTile } from '../../../components/StatusTile';
import type { AlertesResponse } from '../lib/api';

/**
 * Zone 1 — ce qui justifie l'existence de cet écran.
 *
 * Les rappels automatiques deviennent SILENCIEUX dès l'échéance franchie (le worker cesse de
 * relancer une imputation en retard) et leurs paliers sont des valeurs exactes (J-7, J-3, J-1, J0) :
 * un courrier à J-5, ou en retard de dix jours, ne déclenche rien. Cette zone est le seul endroit
 * où ces dossiers réapparaissent.
 *
 * Quand tout est à zéro, on affiche **une ligne verte discrète** plutôt que trois tuiles « 0 » :
 * un tableau d'alertes vide doit se lire d'un coup d'œil, pas occuper le tiers de l'écran.
 */
export function ZoneAlertes({ data, loading }: { data: AlertesResponse | null; loading: boolean }) {
  if (loading && !data) return <Skeleton active paragraph={{ rows: 1 }} />;
  if (!data) return null;

  const { courriersEnRetard, imputationsEnRetard, sansImputation } = data;
  const total = courriersEnRetard + imputationsEnRetard + sansImputation;

  if (total === 0) {
    return (
      <Alert
        type="success"
        showIcon
        message="Aucune alerte : pas de retard, pas de courrier sans imputation."
      />
    );
  }

  return (
    <Row gutter={[16, 16]}>
      {courriersEnRetard > 0 && (
        <Col xs={24} sm={12} lg={8}>
          <StatusTile
            icon="alert"
            tone="danger"
            label="Courriers en retard"
            value={courriersEnRetard}
            hint="Échéance dépassée — au-delà de 3 jours, plus aucune relance n'est envoyée."
            href="/courriers/suivi"
          />
        </Col>
      )}
      {imputationsEnRetard > 0 && (
        <Col xs={24} sm={12} lg={8}>
          <StatusTile
            icon="pending"
            tone="danger"
            label="Imputations en retard"
            value={imputationsEnRetard}
            hint="Échues : les rappels automatiques se sont tus."
            href="/courriers/parapheur"
          />
        </Col>
      )}
      {sansImputation > 0 && (
        <Col xs={24} sm={12} lg={8}>
          <StatusTile
            icon="alert"
            tone="warning"
            label="Courriers sans imputation"
            value={sansImputation}
            hint="En cours et affectés à personne."
            href="/courriers/controle"
          />
        </Col>
      )}
    </Row>
  );
}
