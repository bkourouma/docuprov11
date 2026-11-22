// Erreur « prête à afficher » : traduit une erreur du client API en une forme que les composants affichent
// sans rien connaître du HTTP. Le message est TOUJOURS en français et jamais un détail technique brut.
import {
  AssistantApiError,
  assistantErrorMessage,
  isAssistantNotImplemented,
  isAssistantUnavailable,
  isRateLimited,
} from '../../../lib/assistant-api';

export type UiErrorKind =
  | 'rate_limited' // 429 : plafond ou limite de débit (avec délai éventuel)
  | 'unavailable' // 503 : IA désactivée ou arrêt d'urgence
  | 'not_implemented' // 501 : brique non branchée
  | 'forbidden' // 401/403 : pas d'accès
  | 'not_found' // 404 : introuvable
  | 'network' // pas de réponse du serveur
  | 'generic';

export interface UiError {
  kind: UiErrorKind;
  message: string;
  /** Délai conseillé avant de réessayer (en-tête Retry-After), sinon null. */
  retryAfterSeconds: number | null;
  /** Vrai si un nouvel essai identique a un sens (réseau, 429 après délai, erreur serveur). */
  retryable: boolean;
}

/** Une annulation volontaire (AbortError) n'est pas une erreur à afficher. */
export function isAbortError(e: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') ||
    (e instanceof Error && e.name === 'AbortError')
  );
}

export function toUiError(e: unknown): UiError {
  if (!(e instanceof AssistantApiError)) {
    return {
      kind: 'generic',
      message: 'Une erreur est survenue. Réessayez dans un instant.',
      retryAfterSeconds: null,
      retryable: true,
    };
  }
  const message = assistantErrorMessage(e);
  const retryAfterSeconds = e.retryAfterSeconds;
  if (isRateLimited(e)) return { kind: 'rate_limited', message, retryAfterSeconds, retryable: true };
  if (isAssistantUnavailable(e)) return { kind: 'unavailable', message, retryAfterSeconds, retryable: false };
  if (isAssistantNotImplemented(e)) return { kind: 'not_implemented', message, retryAfterSeconds, retryable: false };
  if (e.status === 401 || e.status === 403) return { kind: 'forbidden', message, retryAfterSeconds, retryable: false };
  if (e.status === 404) return { kind: 'not_found', message, retryAfterSeconds, retryable: false };
  if (e.kind === 'network') return { kind: 'network', message, retryAfterSeconds, retryable: true };
  return { kind: 'generic', message, retryAfterSeconds, retryable: e.status >= 500 || e.status === 0 };
}
