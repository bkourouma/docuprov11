'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Alert, Button, Col, Row, Space } from 'antd';
import dayjs from 'dayjs';
import { documentsApi, type DocumentLifeCycleView } from '../../lib/archives';
import { InfoCard, InfoRow } from '../InfoCard';
import { SectionTitle, StateTag, TabSkeleton, sectionDivider } from './shared';
import { space } from '../../theme/tokens';

const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');
/** Durée en mois → années : l'écran « Cycles de vie » raisonne en années, on reste cohérent. */
const years = (months: number) => {
  const y = Math.round(months / 12);
  return y === 0 ? 'immédiat' : `${y} an${y > 1 ? 's' : ''}`;
};

/**
 * Onglet « Cycle de vie » : la règle du TYPE de document (référence) face au cycle de vie PROPRE
 * au document (dérogation), tous deux en LECTURE SEULE ici — leur saisie se fait ailleurs.
 *
 * Les deux sont montrés ensemble à dessein — c'est l'écart entre la règle générale et l'échéance
 * réellement retenue qui a une valeur archivistique. Chacun est regroupé en deux blocs (dates
 * d'un côté, sort final de l'autre), même mise en page que les onglets « Information »/« Indexation ».
 *
 * `failed` est distingué de « chargé, sans règle » : les deux laissent `data` à `null`, mais l'onglet
 * affirme dans le second cas que le TYPE n'a pas de règle et invite à aller la créer. Sur un simple
 * échec réseau (API redémarrée, coupure), ce message accuse à tort un paramétrage pourtant correct —
 * et le toast d'erreur, lui, a déjà disparu quand l'utilisateur lit l'écran.
 */
export function LifeCycleTab({
  documentId,
  documentTypeLabel,
}: {
  documentId: number;
  documentTypeLabel: string | null;
}) {
  const { message } = App.useApp();
  const [data, setData] = useState<DocumentLifeCycleView | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await documentsApi.lifeCycle(documentId);
      setData(d);
      setFailed(false);
    } catch (e) {
      setData(null);
      setFailed(true);
      message.error(e instanceof Error ? e.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [documentId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <TabSkeleton rows={5} />;
  }

  if (failed) {
    return (
      <Alert
        type="error"
        showIcon
        message="Cycle de vie indisponible"
        description="Les règles de conservation n’ont pas pu être chargées. Ceci ne présage pas de leur paramétrage."
        action={
          <Button size="small" onClick={() => void load()}>
            Réessayer
          </Button>
        }
      />
    );
  }

  const rule = data?.typeRule ?? null;
  const own = data?.documentLifeCycle ?? null;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div>
        <SectionTitle>
          Règle du type {documentTypeLabel ? `« ${documentTypeLabel} »` : ''}
        </SectionTitle>
        {rule ? (
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <InfoCard icon="dates" title="Dates">
                <InfoRow
                  label="Durée d’utilité administrative"
                  value={years(rule.usefulnessLifespanMonths)}
                />
                <InfoRow label="Durée de conformité" value={years(rule.complianceLifespanMonths)} />
                <InfoRow label="Échéance DUA calculée" value={fmt(rule.projectedUsefulness)} />
                <InfoRow
                  label="Échéance conformité calculée"
                  value={fmt(rule.projectedCompliance)}
                />
              </InfoCard>
            </Col>
            <Col xs={24} lg={12}>
              <InfoCard icon="archive" title="Sort final">
                <InfoRow label="Sort final" value={rule.finalFate?.label ?? '—'} />
                <InfoRow label="Mode de destruction" value={rule.destructionMode?.label ?? '—'} />
              </InfoCard>
            </Col>
          </Row>
        ) : (
          <Alert
            type="info"
            showIcon
            message="Aucune règle de conservation pour ce type"
            description="Définissez-la dans « Cycles de vie des documents » pour que les échéances se calculent automatiquement."
          />
        )}
      </div>

      {own && (
        <div style={sectionDivider}>
          {/* Badge PLEIN : la dérogation est l'information qui prime sur la règle du type juste
              au-dessus — en Tag pâle, elle se lisait comme un simple intitulé de bloc. */}
          <Space size={space.sm} style={{ marginBottom: space.sm }}>
            <StateTag tone="brand">Dérogation active</StateTag>
          </Space>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <InfoCard icon="dates" title="Dates">
                <InfoRow label="Échéance DUA" value={fmt(own.usefulnessLifespan)} />
                <InfoRow label="Échéance conformité" value={fmt(own.complianceLifespan)} />
              </InfoCard>
            </Col>
            <Col xs={24} lg={12}>
              <InfoCard icon="archive" title="Sort final">
                <InfoRow label="Sort final" value={own.finalFate?.label ?? '—'} />
                <InfoRow label="Mode de destruction" value={own.destructionMode?.label ?? '—'} />
                <InfoRow label="Observations" value={own.observations || '—'} />
              </InfoCard>
            </Col>
          </Row>
        </div>
      )}
    </Space>
  );
}
