import { AiDisabledError } from '../ai.types';
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from '../ai.types';

/**
 * Fournisseur « désactivé » (mode 0). Toute opération lève `AiDisabledError` : `AiService` court-circuite
 * avant d'arriver ici, ce fournisseur n'est qu'un filet de sécurité contre un appel direct.
 */
export class DisabledProvider implements AiModelProvider {
  readonly kind = 'disabled' as const;
  readonly name = 'disabled';
  readonly model = 'disabled';

  complete(_request: AiCompletionRequest): Promise<AiCompletionResult> {
    return Promise.reject(new AiDisabledError());
  }

  embed(_texts: string[]): Promise<number[][]> {
    return Promise.reject(new AiDisabledError());
  }
}
