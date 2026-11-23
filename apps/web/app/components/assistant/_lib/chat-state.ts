// Réducteur PUR de l'état du chat de l'assistant (aucun React, DOM ni fetch).
// Toutes les transitions sont immuables ; une action sans effet renvoie la MÊME référence d'état.
import { ASST_MESSAGE_MAX_CHARS } from '@archivage/types';
import type {
  AsstConversationDto,
  AsstMessageDto,
  AsstPostMessageResponse,
  AsstProposalDto,
} from '@archivage/types';
import {
  hasPendingProposal,
  mergePostMessageResponse,
  removeProposal,
  replaceProposal,
  sortConversations,
} from './conversation-logic';
import type { Busy, CardNotice } from './proposal-logic';
import type { UiError } from './ui-error';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProposalUiState {
  busy: Busy;
  notice: CardNotice | null;
}

export interface ChatState {
  view: 'list' | 'chat';
  list: { items: AsstConversationDto[]; total: number; status: LoadStatus; error: UiError | null };
  current: {
    conversation: AsstConversationDto | null;
    messages: AsstMessageDto[];
    status: LoadStatus;
    error: UiError | null;
  };
  send: { status: 'idle' | 'sending' | 'error'; pendingText: string | null; error: UiError | null };
  /** Interface globalement bloquée : 503 assistant_unavailable ou 501 not_implemented vus sur une route. */
  blocked: UiError | null;
  /** État d'UI par proposition : appel en cours + avis à afficher. */
  proposals: Record<string, ProposalUiState>;
  /** Échec de suppression d'une conversation (hors 404), affiché dans la liste. */
  deleteError: UiError | null;
}

export type ChatAction =
  | { type: 'listLoading' }
  | { type: 'listLoaded'; items: AsstConversationDto[]; total: number }
  | { type: 'listFailed'; error: UiError }
  | { type: 'openList' }
  | { type: 'newConversation' }
  | { type: 'conversationLoading'; id: string }
  | { type: 'conversationLoaded'; conversation: AsstConversationDto; messages: AsstMessageDto[] }
  | { type: 'conversationFailed'; error: UiError }
  | { type: 'conversationCreated'; conversation: AsstConversationDto }
  | { type: 'sendStarted'; text: string }
  | { type: 'sendSucceeded'; res: AsstPostMessageResponse }
  | { type: 'sendFailed'; error: UiError }
  | { type: 'sendCancelled' }
  | { type: 'proposalBusy'; id: string; busy: Busy }
  | { type: 'proposalReplaced'; proposal: AsstProposalDto; notice?: CardNotice }
  | { type: 'proposalRemoved'; id: string }
  | { type: 'proposalNotice'; id: string; notice: CardNotice | null }
  | { type: 'conversationDeleted'; id: string }
  | { type: 'deleteFailed'; error: UiError }
  | { type: 'deleteErrorCleared' }
  | { type: 'blocked'; error: UiError | null }
  /** Chargements GET abandonnés (fermeture du panneau) : ils ne doivent pas rester « en cours ». */
  | { type: 'loadsAborted' };

const EMPTY_CURRENT: ChatState['current'] = { conversation: null, messages: [], status: 'ready', error: null };
const IDLE_SEND: ChatState['send'] = { status: 'idle', pendingText: null, error: null };

export const initialChatState: ChatState = {
  view: 'list',
  list: { items: [], total: 0, status: 'idle', error: null },
  current: { conversation: null, messages: [], status: 'idle', error: null },
  send: IDLE_SEND,
  blocked: null,
  proposals: {},
  deleteError: null,
};

/** Erreurs qui désactivent toute la saisie. */
export function isBlockingError(e: UiError): boolean {
  return e.kind === 'unavailable' || e.kind === 'not_implemented';
}

function withBlocked(state: ChatState, error: UiError): ChatState {
  return isBlockingError(error) ? { ...state, blocked: error } : state;
}

/** Remplace dans la liste la conversation de même identifiant (puis retrie) ; liste inchangée si absente. */
function updateInList(items: AsstConversationDto[], conv: AsstConversationDto): AsstConversationDto[] {
  if (!items.some((c) => c.conversationId === conv.conversationId)) return items;
  return sortConversations(items.map((c) => (c.conversationId === conv.conversationId ? conv : c)));
}

/** Passage à une AUTRE conversation : propositions et envoi repartent de zéro. */
function switchTo(state: ChatState, current: ChatState['current']): ChatState {
  return { ...state, view: 'chat', current, send: IDLE_SEND, proposals: {} };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'listLoading':
      return { ...state, list: { ...state.list, status: 'loading', error: null } };
    case 'listLoaded':
      return {
        ...state,
        list: { items: sortConversations(action.items), total: action.total, status: 'ready', error: null },
        deleteError: null,
      };
    case 'listFailed':
      return withBlocked({ ...state, list: { ...state.list, status: 'error', error: action.error } }, action.error);

    case 'openList':
      return state.view === 'list' && state.deleteError === null ? state : { ...state, view: 'list', deleteError: null };
    case 'newConversation':
      return switchTo(state, EMPTY_CURRENT);

    case 'conversationLoading':
      return switchTo(state, { conversation: null, messages: [], status: 'loading', error: null });
    case 'conversationLoaded': {
      const same = state.current.conversation?.conversationId === action.conversation.conversationId;
      const current: ChatState['current'] = {
        conversation: action.conversation,
        messages: [...action.messages].sort((a, b) => a.position - b.position),
        status: 'ready',
        error: null,
      };
      // Même conversation (rechargement) : l'état d'UI des propositions est conservé.
      const next = same ? { ...state, view: 'chat' as const, current } : switchTo(state, current);
      return { ...next, list: { ...next.list, items: updateInList(next.list.items, action.conversation) } };
    }
    case 'conversationFailed':
      return withBlocked(
        { ...state, current: { ...state.current, status: 'error', error: action.error } },
        action.error,
      );

    case 'conversationCreated':
      // La conversation est connue AVANT l'envoi du message : un réessai la réutilise.
      return {
        ...state,
        view: 'chat',
        current: { ...state.current, conversation: action.conversation, status: 'ready', error: null },
      };

    case 'sendStarted':
      return { ...state, send: { status: 'sending', pendingText: action.text, error: null } };
    case 'sendSucceeded': {
      const conv = state.current.conversation;
      // Réponse d'une autre conversation (envoi tardif) : ignorée.
      if (conv && conv.conversationId !== action.res.conversation.conversationId) return state;
      // Seule une limite de débit se lève d'elle-même ; une indisponibilité reste affichée.
      const blocked = state.blocked?.kind === 'rate_limited' ? null : state.blocked;
      return {
        ...state,
        view: 'chat',
        blocked,
        current: {
          conversation: action.res.conversation,
          messages: mergePostMessageResponse(state.current.messages, action.res),
          status: 'ready',
          error: null,
        },
        send: IDLE_SEND,
        list: { ...state.list, items: updateInList(state.list.items, action.res.conversation) },
      };
    }
    case 'sendFailed':
      return withBlocked(
        { ...state, send: { status: 'error', pendingText: state.send.pendingText, error: action.error } },
        action.error,
      );
    case 'sendCancelled':
      return state.send.status === 'idle' && state.send.pendingText === null ? state : { ...state, send: IDLE_SEND };

    case 'proposalBusy': {
      const prev = state.proposals[action.id];
      if (!action.busy && !prev) return state;
      // Un nouvel appel efface l'avis précédent ; la fin d'appel le conserve.
      const notice = action.busy ? null : (prev?.notice ?? null);
      return { ...state, proposals: { ...state.proposals, [action.id]: { busy: action.busy, notice } } };
    }
    case 'proposalReplaced':
      return {
        ...state,
        current: { ...state.current, messages: replaceProposal(state.current.messages, action.proposal) },
        proposals: {
          ...state.proposals,
          [action.proposal.proposalId]: { busy: null, notice: action.notice ?? null },
        },
      };
    case 'proposalRemoved': {
      const { [action.id]: _removed, ...rest } = state.proposals;
      return {
        ...state,
        current: { ...state.current, messages: removeProposal(state.current.messages, action.id) },
        proposals: rest,
      };
    }
    case 'proposalNotice': {
      const prev = state.proposals[action.id];
      if (action.notice === null && !prev) return state;
      return {
        ...state,
        proposals: { ...state.proposals, [action.id]: { busy: prev?.busy ?? null, notice: action.notice } },
      };
    }

    case 'conversationDeleted': {
      const inList = state.list.items.some((c) => c.conversationId === action.id);
      const list = inList
        ? {
            ...state.list,
            items: state.list.items.filter((c) => c.conversationId !== action.id),
            total: Math.max(0, state.list.total - 1),
          }
        : state.list;
      if (state.current.conversation?.conversationId === action.id) {
        return { ...state, list, view: 'list', current: EMPTY_CURRENT, send: IDLE_SEND, proposals: {}, deleteError: null };
      }
      return { ...state, list, deleteError: null };
    }
    case 'deleteFailed':
      return withBlocked({ ...state, deleteError: action.error }, action.error);
    case 'deleteErrorCleared':
      return state.deleteError === null ? state : { ...state, deleteError: null };

    case 'blocked':
      return state.blocked === action.error ? state : { ...state, blocked: action.error };

    case 'loadsAborted': {
      let next = state;
      if (next.list.status === 'loading') next = { ...next, list: { ...next.list, status: 'idle' } };
      if (next.current.status === 'loading') next = { ...next, view: 'list', current: EMPTY_CURRENT };
      return next;
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Fonctions pures de décision (utilisées par le hook, testées ici)
// ---------------------------------------------------------------------------

/** La liste se charge à l'ouverture tant qu'elle n'a jamais été chargée ou qu'elle est en erreur. */
export function shouldLoadList(state: ChatState, open: boolean): boolean {
  return open && (state.list.status === 'idle' || state.list.status === 'error');
}

export type SendRefusal = 'empty' | 'too_long' | 'busy' | 'blocked';

/** Décide d'un envoi : texte nettoyé (trim) à transmettre, ou motif de refus. */
export function canSendNow(
  state: ChatState,
  text: string,
): { ok: true; text: string } | { ok: false; reason: SendRefusal } {
  if (state.blocked && isBlockingError(state.blocked)) return { ok: false, reason: 'blocked' };
  if (state.send.status === 'sending') return { ok: false, reason: 'busy' };
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (trimmed.length > ASST_MESSAGE_MAX_CHARS) return { ok: false, reason: 'too_long' };
  return { ok: true, text: trimmed };
}

/** L'horloge de 1 s ne tourne que panneau ouvert ET proposition « proposée » non expirée affichée. */
export function shouldTick(state: ChatState, open: boolean, nowMs: number): boolean {
  return open && hasPendingProposal(state.current.messages, nowMs);
}
