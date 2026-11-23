// État d'affichage du cachet serveur (onglet « Sécurité et conformité ») — fonction PURE (sans
// React), testée à part : `npx tsx --test app/components/documents/seal-view.test.ts`.
//
// ANO-GED-11 (2026-11-22) : l'appel d'état du cachet était avalé (`.catch(() => null)`) et un
// `null` se lisait « Non scellé ». Une panne (réseau, 500, base indisponible) affirmait donc que
// le document n'avait aucun cachet, et proposait « Apposer le cachet » sur une pièce peut-être
// déjà scellée — voire altérée, qu'un nouveau cachet viendrait attester. L'échec a désormais son
// propre état, prioritaire sur tous les autres : on ne sait pas, on le dit, et on ne propose pas
// de geste sur le cachet tant qu'il n'a pas pu être relu.
import type { DocumentSealView } from '../../lib/archives';
import type { StateTone } from './shared';

/** Badge de verdict : `tone: null` = Tag neutre (absence de verdict, qu'on ne colore pas). */
export interface SealBadge {
  label: string;
  tone: StateTone | null;
}

export interface SealViewModel {
  verdict: SealBadge;
  /** Corps de la section : détail du cachet, invitation à sceller, ou erreur de chargement. */
  section: 'sealed' | 'unsealed' | 'error';
  /** Geste proposé sur le cachet ; `null` quand son état est inconnu (rien à proposer à l'aveugle). */
  action: 'apply' | 'renew' | null;
}

/** Verdict affiché quand l'état du cachet n'a pas pu être chargé. */
export const SEAL_UNVERIFIABLE_LABEL = 'Cachet non vérifiable';

/**
 * Verdict d'un coup d'œil : les états du cachet ne se résument pas à « valide / invalide ».
 * L'absence de verdict (non scellé, clé inconnue, état non vérifiable) reste un Tag neutre —
 * colorer un « on ne sait pas » lui donnerait un sens qu'il n'a pas.
 *
 * `integrityOk` entre dans le verdict depuis le 2026-09-15 : `verifySeal` ne relit JAMAIS le
 * coffre, il compare les empreintes ENREGISTRÉES à celles qui ont été scellées. Un binaire altéré
 * sur le disque laisse donc `contentMatches` à `true` ; sans ce critère, le cachet s'affichait
 * « Scellé et intact » sur un document dont la vérification venait d'établir qu'il était compromis.
 */
export function sealBadge(
  seal: DocumentSealView | null,
  integrityOk: boolean | null | undefined,
  sealError: string | null,
): SealBadge {
  if (sealError !== null) return { label: SEAL_UNVERIFIABLE_LABEL, tone: null };
  if (!seal?.sealed) return { label: 'Non scellé', tone: null };
  if (seal.knownKey === false) return { label: 'Clé inconnue', tone: null };
  if (!seal.signatureValid) return { label: 'Cachet invalide', tone: 'danger' };
  // Ordre délibéré : un horodatage retouché est une falsification, à annoncer avant une simple
  // évolution de contenu — qui, elle, peut être parfaitement légitime.
  if (seal.timestampMatches === false) return { label: 'Horodatage altéré', tone: 'danger' };
  // Le coffre diverge de ce qui est scellé : le cachet reste authentique, mais il n'atteste plus
  // le binaire présent. DISTINCT de `contentMatches` ci-dessous — celui-là signale une évolution
  // des références (nouvelle version réindexée), qui est légitime et se règle en re-scellant.
  if (integrityOk === false) return { label: 'Contenu du coffre altéré', tone: 'danger' };
  if (!seal.contentMatches) return { label: 'Contenu modifié depuis', tone: 'warning' };
  return { label: 'Scellé et intact', tone: 'success' };
}

/** Décision d'affichage complète de la section « Cachet serveur ». */
export function sealView(state: {
  seal: DocumentSealView | null;
  integrityOk: boolean | null | undefined;
  sealError: string | null;
}): SealViewModel {
  const verdict = sealBadge(state.seal, state.integrityOk, state.sealError);
  if (state.sealError !== null) return { verdict, section: 'error', action: null };
  if (state.seal?.sealed) return { verdict, section: 'sealed', action: 'renew' };
  return { verdict, section: 'unsealed', action: 'apply' };
}

/** Message d'un échec de chargement de l'état du cachet (jamais vide). */
export function sealErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message.trim() : '';
  return raw || 'État du cachet indisponible';
}
