/**
 * Point UNIQUE d'import du paquet `apps/e2e/support` (lot 0) pour les aides du module socle.
 *
 * Contrat lu dans la copie de travail du lot 0 (`support/index.ts`, `support/env.ts`). Phase B :
 * si un chemin ou un nom change, ne corriger QUE ce fichier.
 */
export {
  ADMIN_PASSWORD,
  ADMIN_USER,
  apiAs,
  createApiClient,
  loginApi,
  type ApiClient,
} from '../../../support';
/** Secret JWT de la pile de test (valeur de test, pas un secret réel). */
export { JWT_SECRET } from '../../../support/env';
