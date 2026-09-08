'use client';

import type { ReactNode } from 'react';
import { ZoneAlertes } from './ZoneAlertes';
import { ZoneFiles } from './ZoneFiles';
import { ZoneSynthese } from './ZoneSynthese';
import { ZoneFlux } from './ZoneFlux';
import { ZoneRepartition } from './ZoneRepartition';
import { ZoneRetards } from './ZoneRetards';
import { ZoneDelais } from './ZoneDelais';
import { ZoneCharge } from './ZoneCharge';
import { ZoneHygiene } from './ZoneHygiene';
import type {
  AlertesResponse,
  ChargeResponse,
  DelaisResponse,
  FilesResponse,
  FluxResponse,
  Granularity,
  HygieneResponse,
  MailScope,
  RepartitionDimension,
  RepartitionResponse,
  RetardsResponse,
  SyntheseResponse,
} from '../lib/api';

/**
 * Registre `id de widget → composant` — transposition du `DashboardViewConfiguration` d'ABP, qui
 * associe chaque identifiant du catalogue à sa vue.
 *
 * Le catalogue (côté API) dit ce qui existe et qui peut le voir ; ce registre dit seulement
 * **comment le dessiner**. Un identifiant présent dans l'agencement mais absent d'ici ne fait pas
 * planter l'écran : il rend un encart explicite, ce qui arrive légitimement si le backend est plus
 * récent que le frontend déployé.
 */
export interface DonneesWidgets {
  alertes: AlertesResponse | null;
  files: FilesResponse | null;
  synthese: SyntheseResponse | null;
  flux: FluxResponse | null;
  repartition: RepartitionResponse | null;
  retards: RetardsResponse | null;
  delais: DelaisResponse | null;
  charge: ChargeResponse | null;
  hygiene: HygieneResponse | null;
}

export interface ContexteWidget {
  donnees: DonneesWidgets;
  loading: boolean;
  scope: MailScope;
  /** Réglages propres à certains widgets, conservés par la page (non persistés dans l'agencement). */
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
  dimension: RepartitionDimension;
  onDimensionChange: (d: RepartitionDimension) => void;
}

type Rendu = (ctx: ContexteWidget) => ReactNode;

const REGISTRE: Record<string, Rendu> = {
  alertes: (c) => <ZoneAlertes data={c.donnees.alertes} loading={c.loading} />,
  files: (c) => <ZoneFiles data={c.donnees.files} loading={c.loading} scope={c.scope} />,
  synthese: (c) => <ZoneSynthese data={c.donnees.synthese} loading={c.loading} />,
  flux: (c) => (
    <ZoneFlux
      data={c.donnees.flux}
      loading={c.loading}
      granularity={c.granularity}
      onGranularityChange={c.onGranularityChange}
    />
  ),
  repartition: (c) => (
    <ZoneRepartition
      data={c.donnees.repartition}
      loading={c.loading}
      dimension={c.dimension}
      onDimensionChange={c.onDimensionChange}
    />
  ),
  retards: (c) => <ZoneRetards data={c.donnees.retards} loading={c.loading} />,
  delais: (c) => <ZoneDelais data={c.donnees.delais} loading={c.loading} />,
  charge: (c) => <ZoneCharge data={c.donnees.charge} loading={c.loading} />,
  hygiene: (c) => <ZoneHygiene data={c.donnees.hygiene} loading={c.loading} />,
};

export function rendreWidget(id: string, ctx: ContexteWidget): ReactNode {
  const rendu = REGISTRE[id];
  return rendu ? rendu(ctx) : null;
}

export function widgetConnu(id: string): boolean {
  return id in REGISTRE;
}
