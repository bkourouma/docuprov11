import { GED_CONNECTOR_ALLOWED_EXTENSIONS, GED_CONNECTOR_LIMITS } from '@archivage/types';
import type { ConnectorLimits } from './types';

/**
 * Bornes par défaut d'un connecteur. Les surcharges ne peuvent que RESSERRER les bornes communes :
 * une taille supérieure au plafond global ou une extension hors de la liste globale est ignorée,
 * pour qu'une configuration ne puisse jamais élargir la surface d'ingestion.
 */
export function resolveLimits(overrides?: Partial<ConnectorLimits>): ConnectorLimits {
  const maxFileBytes =
    overrides?.maxFileBytes !== undefined && overrides.maxFileBytes > 0
      ? Math.min(overrides.maxFileBytes, GED_CONNECTOR_LIMITS.maxFileBytes)
      : GED_CONNECTOR_LIMITS.maxFileBytes;
  const global: readonly string[] = GED_CONNECTOR_ALLOWED_EXTENSIONS;
  const allowedExtensions = overrides?.allowedExtensions
    ? overrides.allowedExtensions.map((e) => e.toLowerCase()).filter((e) => global.includes(e))
    : [...global];
  return { maxFileBytes, allowedExtensions };
}

/** Extension en minuscules, point inclus (`''` si aucune). */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}
