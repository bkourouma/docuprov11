'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WfEvalRunDto } from '@archivage/types';
import { workflowErrorMessage, workflowsApi } from '../../../../lib/workflows-api';
import { pollDelayMs, shouldKeepPolling } from '../../../_lib/eval-logic';

const MAX_CONSECUTIVE_FAILURES = 3;

export interface UseEvalRunPollingOptions {
  /** Appelé à chaque relecture (run mis à jour). */
  onUpdate: (run: WfEvalRunDto) => void;
  /** Appelé une fois quand le run n'est plus « en cours » (terminé, en erreur) ou quand le suivi est abandonné. */
  onSettled: (run: WfEvalRunDto | null) => void;
}

/**
 * Suivi d'un run en arrière-plan : relecture périodique (`pollDelayMs`) tant que `shouldKeepPolling`.
 * Un seul suivi à la fois. Au démontage : minuterie effacée, plus aucun rappel ni mise à jour d'état.
 */
export function useEvalRunPolling(options: UseEvalRunPollingOptions) {
  const [watchedId, setWatchedId] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const token = useRef(0);
  const opts = useRef(options);

  useEffect(() => {
    opts.current = options;
  });

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      token.current += 1;
      clear();
    };
  }, [clear]);

  const stop = useCallback(() => {
    token.current += 1;
    clear();
    if (alive.current) setWatchedId(null);
  }, [clear]);

  /** Démarre le suivi d'un run « en cours » (remplace tout suivi précédent). */
  const watch = useCallback(
    (run: WfEvalRunDto) => {
      token.current += 1;
      const mine = token.current;
      clear();
      if (!alive.current) return;
      setPollError(null);
      setWatchedId(run.wfEvalRunId);
      const startedAt = Date.now();
      let attempt = 0;
      let failures = 0;
      let last = run;

      const settle = (r: WfEvalRunDto | null) => {
        if (!alive.current || token.current !== mine) return;
        setWatchedId(null);
        opts.current.onSettled(r);
      };

      const schedule = () => {
        timer.current = setTimeout(async () => {
          timer.current = null;
          if (!alive.current || token.current !== mine) return;
          try {
            const next = await workflowsApi.getEvalRun(run.wfEvalRunId);
            if (!alive.current || token.current !== mine) return;
            failures = 0;
            last = next;
            opts.current.onUpdate(next);
            attempt += 1;
            if (shouldKeepPolling(next, Date.now() - startedAt)) schedule();
            else settle(next);
          } catch (e) {
            if (!alive.current || token.current !== mine) return;
            failures += 1;
            attempt += 1;
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
              setPollError(`Le suivi automatique est interrompu : ${workflowErrorMessage(e)} Actualisez la page pour relire l’état.`);
              settle(last);
            } else {
              schedule();
            }
          }
        }, pollDelayMs(attempt));
      };

      if (shouldKeepPolling(run, 0)) schedule();
      else settle(run);
    },
    [clear],
  );

  return { watchedId, pollError, watch, stop, running: watchedId !== null };
}
