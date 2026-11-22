import { createHash } from 'node:crypto';
import { ASST_PROPOSAL_TTL_MINUTES, asstCanonicalActionsJson, type AsstProposedAction } from '@archivage/types';

/** SHA-256 hexadécimal (minuscules) du JSON canonique des actions : c'est l'`argsHash` d'une proposition. */
export function asstArgsHash(actions: AsstProposedAction[]): string {
  return createHash('sha256').update(asstCanonicalActionsJson(actions), 'utf8').digest('hex');
}

/** Échéance d'une proposition créée à `now` : `now` + `ASST_PROPOSAL_TTL_MINUTES` (15 min). */
export function asstProposalExpiresAt(now: Date): Date {
  return new Date(now.getTime() + ASST_PROPOSAL_TTL_MINUTES * 60_000);
}
