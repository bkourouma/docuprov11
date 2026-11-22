import {
  AsstError,
  type AsstConversationsPort,
  type AsstExecutorPort,
} from './assistant.contracts';

// Implémentations par défaut « pas encore branché » : chaque méthode échoue en `not_implemented` (HTTP 501).
// Les lots A1 / A2 les remplacent dans `assistant.module.ts`.

const unavailable = (): Promise<never> =>
  Promise.reject(new AsstError('not_implemented', 'Fonction pas encore disponible.'));

export class NotImplementedConversations implements AsstConversationsPort {
  create = unavailable;
  list = unavailable;
  detail = unavailable;
  postMessage = unavailable;
  remove = unavailable;
}

export class NotImplementedExecutor implements AsstExecutorPort {
  confirm = unavailable;
  refuse = unavailable;
  get = unavailable;
  expireDue = unavailable;
}

