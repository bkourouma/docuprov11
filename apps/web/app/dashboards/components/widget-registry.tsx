'use client';

import type { ReactNode } from 'react';
import {
  ZoneDossier,
  ZoneEvolution,
  ZoneKpis,
  ZonePlan,
  ZoneType,
} from './zones';
import type { AnalyticsOverview } from '../lib/api';

/**
 * Registre `id de widget → composant` du tableau de bord Docu-Archives.
 *
 * Le catalogue (côté API) dit ce qui existe et qui peut le voir ; ce registre dit seulement
 * **comment le dessiner**. Un identifiant présent dans l'agencement mais absent d'ici ne fait pas
 * planter l'écran : la grille rend un encart explicite, ce qui arrive légitimement si le backend
 * est plus récent que le frontend déployé.
 *
 * Les clés DOIVENT correspondre aux `id` de `analytics/dashboard-widgets.ts`.
 */
export interface ContexteWidget {
  data: AnalyticsOverview | null;
  loading: boolean;
}

type Rendu = (ctx: ContexteWidget) => ReactNode;

const REGISTRE: Record<string, Rendu> = {
  kpis: (c) => <ZoneKpis {...c} />,
  type: (c) => <ZoneType {...c} />,
  dossier: (c) => <ZoneDossier {...c} />,
  plan: (c) => <ZonePlan {...c} />,
  evolution: (c) => <ZoneEvolution {...c} />,
};

export function rendreWidget(id: string, ctx: ContexteWidget): ReactNode {
  const rendu = REGISTRE[id];
  return rendu ? rendu(ctx) : null;
}

export function widgetConnu(id: string): boolean {
  return id in REGISTRE;
}
