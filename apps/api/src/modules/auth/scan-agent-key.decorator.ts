import { SetMetadata } from '@nestjs/common';

export const ALLOW_SCAN_AGENT_KEY = 'allowScanAgentKey';

/**
 * Autorise l'authentification par `X-Api-Key` (clé `SCAN_AGENT_API_KEY`) en plus du JWT.
 *
 * Réservé aux routes que l'agent de numérisation appelle sans humain derrière : un service
 * installé sur un poste de scan ne doit pas porter le compte — ni le mot de passe — d'un
 * utilisateur. Toute route non décorée reste strictement JWT.
 */
export const AllowScanAgentKey = () => SetMetadata(ALLOW_SCAN_AGENT_KEY, true);
