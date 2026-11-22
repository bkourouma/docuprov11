// Orchestration PURE de confirmer / refuser / relire une proposition de l'assistant.
// Tout est injecté (api, dispatch, état, horloge, verrou, génération) : aucune dépendance à React, au réseau réel,
// à Date.now ni à AbortController. Contrat : docs/assistant-api.md, sections 3.3, 3.4 et 4.
// Règles : verrou SYNCHRONE pris avant tout await ; le POST n'est jamais annulé ; réponses tardives ignorées ;
// l'argsHash envoyé est celui de la proposition présente dans l'état COURANT au moment de l'appel.
import type { AsstProposalDto } from '@archivage/types';
import { AssistantApiError, assistantErrorMessage } from '../../../lib/assistant-api';
import type { ChatAction, ChatState } from './chat-state';
import { findProposal } from './conversation-logic';
import {
  canConfirm,
  canRefuse,
  confirmPayload,
  resolveProposalError,
  type CardNotice,
  type createSubmitLock,
} from './proposal-logic';
import { isAbortError, toUiError } from './ui-error';

/** Avis affiché quand la relecture d'une proposition échoue. */
export const RELOAD_NEEDED: CardNotice = {
  kind: 'reload-needed',
  message: 'Impossible de relire la proposition. Rechargez-la avant de continuer.',
};

export interface ProposalApi {
  confirm(id: string, argsHash: string): Promise<AsstProposalDto>;
  refuse(id: string): Promise<AsstProposalDto>;
  get(id: string): Promise<AsstProposalDto>;
}

export interface ProposalActionDeps {
  api: ProposalApi;
  dispatch(a: ChatAction): void;
  /** État COURANT (jamais une copie figée au rendu). */
  getState(): ChatState;
  now(): number;
  lock: ReturnType<typeof createSubmitLock>;
  /** Génération au moment de l'appel ; toute réponse d'une autre génération est ignorée. */
  gen: number;
  isAlive(gen: number): boolean;
  /** Signale une erreur globale (503/501 verrouillent la saisie). */
  noteError(e: unknown): void;
}

/** Relit la proposition après une erreur « à recharger » ; en cas d'échec, invite à recharger manuellement. */
async function reloadAfterError(deps: ProposalActionDeps, proposalId: string, notice: CardNotice): Promise<void> {
  try {
    const fresh = await deps.api.get(proposalId);
    if (!deps.isAlive(deps.gen)) return;
    deps.dispatch({ type: 'proposalReplaced', proposal: fresh, notice });
  } catch (e) {
    if (!deps.isAlive(deps.gen)) return;
    if (!isAbortError(e)) deps.noteError(e);
    deps.dispatch({ type: 'proposalBusy', id: proposalId, busy: null });
    deps.dispatch({ type: 'proposalNotice', id: proposalId, notice: RELOAD_NEEDED });
  }
}

/** Traduit l'échec d'un POST selon les tables 3.3 / 3.4 puis applique le résultat. */
async function handleFailure(
  deps: ProposalActionDeps,
  proposalId: string,
  kind: 'confirm' | 'refuse',
  e: unknown,
): Promise<void> {
  const api = e instanceof AssistantApiError ? e : null;
  const outcome = resolveProposalError(kind, {
    status: api?.status ?? 0,
    errorCode: api?.errorCode ?? null,
    message: api ? assistantErrorMessage(api) : toUiError(e).message,
    proposal: api?.proposal ?? null,
  });
  switch (outcome.kind) {
    case 'replace':
      deps.dispatch({ type: 'proposalReplaced', proposal: outcome.proposal, notice: outcome.notice });
      break;
    case 'reload':
      await reloadAfterError(deps, proposalId, outcome.notice);
      break;
    case 'remove':
      deps.dispatch({ type: 'proposalRemoved', id: proposalId });
      break;
    case 'notice':
      deps.dispatch({ type: 'proposalBusy', id: proposalId, busy: null });
      deps.dispatch({ type: 'proposalNotice', id: proposalId, notice: outcome.notice });
      break;
  }
}

/**
 * Confirme ou refuse une proposition. Retourne `null` si l'appel est ignoré (proposition absente, occupée,
 * échue ou non en attente, verrou déjà pris) : aucun appel réseau. Sinon, une promesse qui ne rejette jamais.
 * Le verrou est pris de façon synchrone et relâché dans tous les cas.
 */
export function runProposalAction(
  deps: ProposalActionDeps,
  proposalId: string,
  kind: 'confirm' | 'refuse',
): Promise<void> | null {
  const state = deps.getState();
  const proposal = findProposal(state.current.messages, proposalId);
  if (!proposal) return null;
  const busy = state.proposals[proposalId]?.busy ?? null;
  const nowMs = deps.now();
  const allowed = kind === 'confirm' ? canConfirm(proposal, nowMs, busy) : canRefuse(proposal, nowMs, busy);
  if (!allowed) return null;
  if (!deps.lock.tryAcquire(proposalId)) return null;

  deps.dispatch({ type: 'proposalBusy', id: proposalId, busy: kind });
  // argsHash de la proposition AFFICHÉE à cet instant, tel que reçu (jamais recalculé).
  const argsHash = confirmPayload(proposal).argsHash;

  return (async () => {
    try {
      const res = kind === 'confirm' ? await deps.api.confirm(proposalId, argsHash) : await deps.api.refuse(proposalId);
      if (!deps.isAlive(deps.gen)) return;
      deps.dispatch({ type: 'proposalReplaced', proposal: res });
    } catch (e) {
      if (!deps.isAlive(deps.gen)) return;
      deps.noteError(e);
      await handleFailure(deps, proposalId, kind, e);
    } finally {
      deps.lock.release(proposalId);
    }
  })();
}

/**
 * Relecture manuelle d'une proposition (bouton « Recharger »). Retourne `null` si une relecture est déjà en cours.
 * 404 : la proposition est retirée ; autre échec : avis « à recharger ».
 */
export function reloadProposalAction(deps: ProposalActionDeps, proposalId: string): Promise<void> | null {
  const key = `reload:${proposalId}`;
  if (!deps.lock.tryAcquire(key)) return null;
  return (async () => {
    try {
      const fresh = await deps.api.get(proposalId);
      if (!deps.isAlive(deps.gen)) return;
      deps.dispatch({ type: 'proposalReplaced', proposal: fresh });
    } catch (e) {
      if (!deps.isAlive(deps.gen) || isAbortError(e)) return;
      deps.noteError(e);
      if (e instanceof AssistantApiError && e.status === 404) {
        deps.dispatch({ type: 'proposalRemoved', id: proposalId });
      } else {
        deps.dispatch({ type: 'proposalNotice', id: proposalId, notice: RELOAD_NEEDED });
      }
    } finally {
      deps.lock.release(key);
    }
  })();
}
