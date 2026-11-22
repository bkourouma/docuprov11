import { createHash } from 'node:crypto';
import { asstCanonicalActionsJson, type AsstProposedAction } from '@archivage/types';

/**
 * Empreinte d'une liste d'actions proposées : SHA-256 hexadécimal (minuscules) du JSON canonique
 * (`asstCanonicalActionsJson` : clés triées récursivement, sans espaces, ordre du tableau conservé).
 * C'est la valeur `argsHash` d'une proposition, à laquelle la confirmation est liée.
 */
export function asstActionsHash(actions: AsstProposedAction[]): string {
  return createHash('sha256').update(asstCanonicalActionsJson(actions), 'utf8').digest('hex');
}
