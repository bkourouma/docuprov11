'use client';

import { useCallback, useState } from 'react';
import { useFeedback } from '../../components/feedback';
import {
  connecteursApi,
  type ConnectorTestResult,
  type GedConnectorView,
} from '../../lib/connecteurs';

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Actions d'un connecteur partagées par la liste et le détail : tester, synchroniser,
 * activer/désactiver. `busy` vaut `<action>:<id>` pendant l'appel (un bouton par ligne s'y accroche).
 */
export function useConnectorActions(onChanged: () => void | Promise<void>) {
  const { message, confirm } = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async <T>(key: string, fn: () => Promise<T>, failure: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        return await fn();
      } catch (e) {
        message.error(errorText(e, failure));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [message],
  );

  const test = useCallback(
    async (c: GedConnectorView): Promise<ConnectorTestResult | undefined> => {
      const result = await run(
        `test:${c.gedSourceConnectorId}`,
        () => connecteursApi.test(c.gedSourceConnectorId),
        'Test de connexion impossible',
      );
      if (result) {
        if (result.ok) message.success(result.message || 'Connexion réussie');
        else message.error(result.message || 'Connexion refusée');
      }
      return result;
    },
    [run, message],
  );

  const sync = useCallback(
    async (c: GedConnectorView) => {
      const r = await run(
        `sync:${c.gedSourceConnectorId}`,
        () => connecteursApi.sync(c.gedSourceConnectorId),
        'Synchronisation impossible',
      );
      if (r) {
        message.success('Synchronisation demandée : elle démarre en arrière-plan.');
        await onChanged();
      }
    },
    [run, message, onChanged],
  );

  const toggle = useCallback(
    (c: GedConnectorView) => {
      const id = c.gedSourceConnectorId;
      const apply = async () => {
        const r = await run(
          `toggle:${id}`,
          () => (c.isActive ? connecteursApi.deactivate(id) : connecteursApi.activate(id)),
          c.isActive ? 'Désactivation impossible' : 'Activation impossible',
        );
        if (r) {
          message.success(c.isActive ? 'Connecteur désactivé' : 'Connecteur activé');
          await onChanged();
        }
      };
      if (!c.isActive) return apply();
      confirm({
        title: `Désactiver « ${c.label} » ?`,
        content:
          'Plus aucune synchronisation ne sera lancée tant que le connecteur n’est pas réactivé.',
        okText: 'Désactiver',
        danger: true,
        onOk: apply,
      });
    },
    [run, message, confirm, onChanged],
  );

  return { busy, test, sync, toggle };
}
