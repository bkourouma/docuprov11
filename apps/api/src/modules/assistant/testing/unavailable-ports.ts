import { AsstError, type AsstConversationsPort, type AsstExecutorPort } from '../assistant.contracts';

// Doublures de test « fonction non disponible » : chaque méthode échoue en `not_implemented` (HTTP 501).
// Réservées aux specs ; la production câble les vrais ports dans `assistant.module.ts`.

const unavailable = (): Promise<never> =>
  Promise.reject(new AsstError('not_implemented', 'Fonction pas encore disponible.'));

export class UnavailableConversations implements AsstConversationsPort {
  create = unavailable;
  list = unavailable;
  detail = unavailable;
  postMessage = unavailable;
  remove = unavailable;
}

export class UnavailableExecutor implements AsstExecutorPort {
  confirm = unavailable;
  refuse = unavailable;
  get = unavailable;
  expireDue = unavailable;
}
