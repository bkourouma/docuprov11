'use client';
// Hook du chat de l'assistant : orchestre les appels API autour du réducteur pur (_lib/chat-state.ts).
// Règles : aucun journal console, aucun stockage local des propositions ni de l'argsHash,
// réponses tardives ignorées (démontage, changement de conversation), POST confirm/refuse jamais abandonnés.
import type { AsstPageContext } from '@archivage/types';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  AssistantApiError,
  confirmProposal,
  createConversation,
  deleteConversation as apiDeleteConversation,
  getConversation,
  getProposal,
  listConversations,
  postMessage,
  refuseProposal,
} from '../../lib/assistant-api';
import {
  canSendNow,
  chatReducer,
  initialChatState,
  isBlockingError,
  shouldLoadList,
  shouldTick,
  type ChatState,
} from './_lib/chat-state';
import { reloadProposalAction, runProposalAction, type ProposalActionDeps } from './_lib/proposal-actions';
import { createSubmitLock } from './_lib/proposal-logic';
import { isAbortError, toUiError } from './_lib/ui-error';

const LIST_LIMIT = 20;

export interface UseAssistantChat {
  state: ChatState;
  /** Horloge (ms) : avance chaque seconde uniquement si le panneau est ouvert et une proposition en attente est affichée. */
  nowMs: number;
  openList(): void;
  reloadList(): void;
  openConversation(id: string): void;
  newConversation(): void;
  send(text: string): void;
  retrySend(): void;
  cancelSend(): void;
  confirm(proposalId: string): void;
  refuse(proposalId: string): void;
  reloadProposal(proposalId: string): void;
  deleteConversation(id: string): Promise<boolean>;
  /** Efface l'erreur de suppression affichée dans la liste. */
  clearDeleteError(): void;
}

export function useAssistantChat(opts: { open: boolean; pageContext: AsstPageContext | null }): UseAssistantChat {
  const { open, pageContext } = opts;
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Dernières valeurs pour les gestionnaires (évite les fermetures périmées).
  const stateRef = useRef(state);
  stateRef.current = state;
  const pageContextRef = useRef(pageContext);
  pageContextRef.current = pageContext;

  const mountedRef = useRef(false);
  /** Génération : change à chaque changement de conversation ; toute réponse d'une autre génération est ignorée. */
  const genRef = useRef(0);
  const lockRef = useRef(createSubmitLock());
  const sendingRef = useRef(false);
  const sendCtrlRef = useRef<AbortController | null>(null);
  const listCtrlRef = useRef<AbortController | null>(null);
  const convCtrlRef = useRef<AbortController | null>(null);
  /** Tous les GET en cours (annulés à la fermeture). Les POST confirm/refuse n'y figurent JAMAIS. */
  const getCtrlsRef = useRef<Set<AbortController>>(new Set());

  const alive = useCallback((gen: number): boolean => mountedRef.current && genRef.current === gen, []);

  /** Crée un contrôleur de GET suivi ; `release` le retire de l'ensemble. */
  const newGetCtrl = useCallback((): { ctrl: AbortController; release: () => void } => {
    const ctrl = new AbortController();
    getCtrlsRef.current.add(ctrl);
    return { ctrl, release: () => getCtrlsRef.current.delete(ctrl) };
  }, []);

  /** Une erreur 503/501 verrouille la saisie, quelle que soit la route. */
  const noteError = useCallback((e: unknown): void => {
    if (isAbortError(e)) return;
    const ui = toUiError(e);
    if (isBlockingError(ui)) dispatch({ type: 'blocked', error: ui });
  }, []);

  const abortConvLoad = useCallback((): void => {
    convCtrlRef.current?.abort();
    convCtrlRef.current = null;
  }, []);

  /** Changement de conversation : les réponses en vol de l'ancienne deviennent caduques. */
  const bumpGen = useCallback((): void => {
    genRef.current += 1;
    sendCtrlRef.current = null;
    sendingRef.current = false;
  }, []);

  // --- Montage / ouverture / fermeture -----------------------------------------------------------

  useEffect(() => {
    mountedRef.current = true;
    const getCtrls = getCtrlsRef.current;
    return () => {
      mountedRef.current = false;
      for (const c of getCtrls) c.abort();
      getCtrls.clear();
    };
  }, []);

  const loadList = useCallback((): void => {
    listCtrlRef.current?.abort();
    const { ctrl, release } = newGetCtrl();
    listCtrlRef.current = ctrl;
    dispatch({ type: 'listLoading' });
    listConversations({ limit: LIST_LIMIT }, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted || !mountedRef.current) return;
        dispatch({ type: 'listLoaded', items: res.items, total: res.total });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || isAbortError(e) || !mountedRef.current) return;
        noteError(e);
        dispatch({ type: 'listFailed', error: toUiError(e) });
      })
      .finally(() => {
        release();
        if (listCtrlRef.current === ctrl) listCtrlRef.current = null;
      });
  }, [newGetCtrl, noteError]);

  useEffect(() => {
    if (!open) return;
    const loadingOrphan = stateRef.current.list.status === 'loading' && listCtrlRef.current === null;
    if (shouldLoadList(stateRef.current, true) || loadingOrphan) loadList();
    // Fermeture : on abandonne les GET en cours (jamais les POST) et on remet leur état à plat.
    return () => {
      for (const c of getCtrlsRef.current) c.abort();
      getCtrlsRef.current.clear();
      listCtrlRef.current = null;
      convCtrlRef.current = null;
      dispatch({ type: 'loadsAborted' });
    };
  }, [open, loadList]);

  // --- Horloge -------------------------------------------------------------------------------------

  const ticking = shouldTick(state, open, nowMs);
  useEffect(() => {
    if (!ticking) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // --- Navigation ----------------------------------------------------------------------------------

  const reloadList = useCallback((): void => loadList(), [loadList]);

  const openList = useCallback((): void => {
    abortConvLoad();
    dispatch({ type: 'loadsAborted' });
    dispatch({ type: 'openList' });
    loadList();
  }, [abortConvLoad, loadList]);

  const newConversation = useCallback((): void => {
    abortConvLoad();
    bumpGen();
    dispatch({ type: 'newConversation' });
  }, [abortConvLoad, bumpGen]);

  const openConversation = useCallback(
    (id: string): void => {
      abortConvLoad();
      bumpGen();
      const gen = genRef.current;
      const { ctrl, release } = newGetCtrl();
      convCtrlRef.current = ctrl;
      dispatch({ type: 'conversationLoading', id });
      getConversation(id, ctrl.signal)
        .then((res) => {
          if (ctrl.signal.aborted || !alive(gen)) return;
          dispatch({ type: 'conversationLoaded', conversation: res.conversation, messages: res.messages });
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted || isAbortError(e) || !alive(gen)) return;
          noteError(e);
          dispatch({ type: 'conversationFailed', error: toUiError(e) });
        })
        .finally(() => {
          release();
          if (convCtrlRef.current === ctrl) convCtrlRef.current = null;
        });
    },
    [abortConvLoad, alive, bumpGen, newGetCtrl, noteError],
  );

  // --- Envoi ---------------------------------------------------------------------------------------

  /** Recharge silencieusement la conversation courante (le serveur a pu traiter un envoi abandonné). */
  const refreshCurrent = useCallback(
    (conversationId: string, gen: number): void => {
      const { ctrl, release } = newGetCtrl();
      getConversation(conversationId, ctrl.signal)
        .then((res) => {
          if (ctrl.signal.aborted || !alive(gen)) return;
          dispatch({ type: 'conversationLoaded', conversation: res.conversation, messages: res.messages });
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted || isAbortError(e) || !alive(gen)) return;
          noteError(e);
        })
        .finally(release);
    },
    [alive, newGetCtrl, noteError],
  );

  const runSend = useCallback(
    (text: string): void => {
      const gen = genRef.current;
      const ctrl = new AbortController();
      sendCtrlRef.current = ctrl;
      sendingRef.current = true;
      dispatch({ type: 'sendStarted', text });
      const ctx = pageContextRef.current;

      void (async () => {
        try {
          let conv = stateRef.current.current.conversation;
          if (!conv) {
            conv = await createConversation(ctx ? { pageContext: ctx } : {}, ctrl.signal);
            if (ctrl.signal.aborted || !alive(gen)) return;
            // Connue AVANT l'envoi : en cas d'échec, le réessai réutilise cette conversation.
            dispatch({ type: 'conversationCreated', conversation: conv });
          }
          const res = await postMessage(
            conv.conversationId,
            ctx ? { content: text, pageContext: ctx } : { content: text },
            ctrl.signal,
          );
          if (ctrl.signal.aborted || !alive(gen)) return;
          dispatch({ type: 'sendSucceeded', res });
        } catch (e) {
          if (ctrl.signal.aborted || isAbortError(e) || !alive(gen)) return;
          noteError(e);
          dispatch({ type: 'sendFailed', error: toUiError(e) });
        } finally {
          if (sendCtrlRef.current === ctrl) {
            sendCtrlRef.current = null;
            sendingRef.current = false;
          }
        }
      })();
    },
    [alive, noteError],
  );

  const send = useCallback(
    (text: string): void => {
      if (sendingRef.current) return;
      const verdict = canSendNow(stateRef.current, text);
      if (!verdict.ok) return;
      runSend(verdict.text);
    },
    [runSend],
  );

  const retrySend = useCallback((): void => {
    const s = stateRef.current.send;
    if (sendingRef.current || s.status !== 'error' || s.pendingText === null) return;
    const verdict = canSendNow(stateRef.current, s.pendingText);
    if (!verdict.ok) return;
    runSend(verdict.text);
  }, [runSend]);

  const cancelSend = useCallback((): void => {
    const ctrl = sendCtrlRef.current;
    if (!ctrl || !sendingRef.current) return;
    ctrl.abort();
    sendCtrlRef.current = null;
    sendingRef.current = false;
    dispatch({ type: 'sendCancelled' });
    // Le serveur a pu traiter le message : on relit la conversation.
    const conv = stateRef.current.current.conversation;
    if (conv) refreshCurrent(conv.conversationId, genRef.current);
  }, [refreshCurrent]);

  // --- Propositions ----------------------------------------------------------------------------------

  /** Dépendances de _lib/proposal-actions (la logique vit là, sans React). Les POST ne sont jamais annulés ; les GET le sont. */
  const proposalDeps = useCallback(
    (): ProposalActionDeps => ({
      api: {
        confirm: (id, argsHash) => confirmProposal(id, argsHash),
        refuse: (id) => refuseProposal(id),
        get: async (id) => {
          const { ctrl, release } = newGetCtrl();
          try {
            return await getProposal(id, ctrl.signal);
          } finally {
            release();
          }
        },
      },
      dispatch,
      getState: () => stateRef.current,
      now: Date.now,
      lock: lockRef.current,
      gen: genRef.current,
      isAlive: alive,
      noteError,
    }),
    [alive, newGetCtrl, noteError],
  );

  const confirm = useCallback((proposalId: string): void => {
    void runProposalAction(proposalDeps(), proposalId, 'confirm');
  }, [proposalDeps]);
  const refuse = useCallback((proposalId: string): void => {
    void runProposalAction(proposalDeps(), proposalId, 'refuse');
  }, [proposalDeps]);
  const reloadProposal = useCallback((proposalId: string): void => {
    void reloadProposalAction(proposalDeps(), proposalId);
  }, [proposalDeps]);

  // --- Suppression ---------------------------------------------------------------------------------

  const clearDeleteError = useCallback((): void => dispatch({ type: 'deleteErrorCleared' }), []);

  const deleteConversation = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await apiDeleteConversation(id);
      } catch (e) {
        // 404 : déjà supprimée, le résultat voulu est atteint.
        if (!(e instanceof AssistantApiError && e.status === 404)) {
          if (mountedRef.current) {
            noteError(e);
            dispatch({ type: 'deleteFailed', error: toUiError(e) });
          }
          return false;
        }
      }
      if (!mountedRef.current) return true;
      if (stateRef.current.current.conversation?.conversationId === id) {
        abortConvLoad();
        bumpGen();
      }
      dispatch({ type: 'conversationDeleted', id });
      return true;
    },
    [abortConvLoad, bumpGen, noteError],
  );

  return {
    state,
    nowMs,
    openList,
    reloadList,
    openConversation,
    newConversation,
    send,
    retrySend,
    cancelSend,
    confirm,
    refuse,
    reloadProposal,
    deleteConversation,
    clearDeleteError,
  };
}
