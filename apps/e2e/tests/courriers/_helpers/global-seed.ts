import type { ApiClient } from '../../../fixtures';
import { INPUTATION_TYPE } from './menus';

/**
 * Seed du module Docu-Courriers — IDEMPOTENT, appelé par le lot 0 avant les specs du module.
 *
 * Garantit les prérequis que les specs supposent, normalement posés par le seed de base
 * (`packages/db/prisma/seed.ts`) :
 *  - les 4 types d'imputation système aux identifiants FIGÉS 5/10/14/17 (actifs) ;
 *  - le type d'entité externe « Non défini ».
 *
 * Hypothèses à vérifier en phase B :
 *  - `GET /courriers/referentials/inputation-types` ne renvoie que les types actifs.
 *  - Un type système manquant ne peut PAS être recréé par l'API avec son identifiant (auto-incrément) :
 *    le seed échoue alors franchement, plutôt que de laisser les specs échouer loin de la cause.
 */
export default async function seed(ctx: { api: ApiClient }): Promise<void> {
  const { api } = ctx;

  const types = (await api.get('/courriers/referentials/inputation-types')) as Array<{
    mailInputationTypeId: number;
    label: string;
  }>;
  const present = new Set(types.map((t) => t.mailInputationTypeId));
  const missing = Object.entries(INPUTATION_TYPE).filter(([, id]) => !present.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Seed courriers : types d'imputation système absents ou inactifs (${missing
        .map(([k, id]) => `${k}=${id}`)
        .join(', ')}). Lancer le seed de base (packages/db/prisma/seed.ts) sur la base E2E.`,
    );
  }

  const extTypes = (await api.get('/courriers/referentials/external-entity-types')) as Array<{
    externalEntityTypeId: number;
    label: string;
  }>;
  if (!extTypes.some((t) => t.label === 'Non défini')) {
    await api.post('/courriers/referentials/external-entity-types', { label: 'Non défini' });
  }
}
