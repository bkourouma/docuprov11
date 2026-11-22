/**
 * Utilitaires communs de la suite E2E (sans dépendance au runner de tests).
 * Les specs importent d'abord `../../fixtures` ; ce module sert aux seeds et aux aides de module.
 */
export { ADMIN_PASSWORD, ADMIN_USER } from './constants';
export {
  ApiError,
  apiAs,
  createApiClient,
  loginApi,
  type ApiClient,
  type RawApi,
  type RequestOptions,
  type UploadFile,
  type UploadSpec,
} from './api-client';
export type { GlobalSeed, GlobalSeedContext } from './module-seeds';
export { uniq } from './uniq';
export { API_URL, CONNECTOR_FS_ROOT, REPO_ROOT, E2E_ROOT, WEB_URL } from './env';
