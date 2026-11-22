import { WfInboxItemKind, type WfStep } from '@archivage/types';
import { z } from 'zod';
import {
  WfEffectApplyError,
  WfEngineError,
  type WfEffectAction,
  type WfEffectApplierPort,
  type WfEffectApplierSource,
} from './engine.types';
import { canonicalJson, isPlainObject } from './interpreter';

// Docu-Flow (lot W6) — support de l'applicateur d'effets côté moteur : support mutable (le moteur est
// construit en usine AVANT le module du catalogue qui y branche son applicateur), sélection STRICTE des
// actions validées, traduction des refus en erreur du moteur, appel des compensations. Aucune écriture ici.

/** Plafond d'actions appliquées par validation (au-delà : refus, rien n'est appliqué). */
export const WF_EFFECT_ACTIONS_MAX = 20;

const TOOL_KEY = /^[a-z0-9_.]{1,100}$/;

/**
 * Support mutable de l'applicateur (comme le registre d'exécuteurs). Refuse un second branchement d'un AUTRE
 * applicateur (jamais de remplacement silencieux) ; rebrancher le même est sans effet.
 */
export class WfEffectApplierHolder implements WfEffectApplierSource {
  private port: WfEffectApplierPort | undefined;

  set(port: WfEffectApplierPort): void {
    if (!port || typeof port.apply !== 'function') {
      throw new Error("Applicateur d'effets invalide : méthode apply absente.");
    }
    if (this.port && this.port !== port) throw new Error("Un applicateur d'effets est déjà branché sur le moteur.");
    this.port = port;
  }

  get(): WfEffectApplierPort | undefined {
    return this.port;
  }
}

const actionSchema = z.object({
  tool: z.string().regex(TOOL_KEY),
  arguments: z.record(z.unknown()),
  sideEffect: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  requiresValidation: z.boolean().default(true),
  preview: z.string().max(2000).default(''),
});

export interface WfEffectSelection {
  itemId: bigint;
  outcome: 'accepted' | 'modified';
  actions: WfEffectAction[];
}

/**
 * Actions à appliquer lors de la validation HUMAINE d'une proposition d'agent (élément de boîte kind 1).
 * Renvoie null si rien n'est applicable :
 *  - étape autre qu'« agent », pas d'élément kind 1, proposition qui n'est pas `mode: 'action'` (niveau 0 :
 *    `suggestedActions` ne s'appliquent jamais), proposition signalée `suspicion_injection` ;
 * « accepted » (résultat identique à la proposition) : actions de la proposition STOCKÉE en base ;
 * « modified » : `result.preparedActions` (absent => rien appliqué), chaque outil devant figurer dans la
 * proposition stockée, jamais plus de fois qu'il n'y figure. Toute action illisible : `INVALID_INPUT`.
 */
export function selectValidatedActions(
  step: Pick<WfStep, 'type'>,
  items: ReadonlyArray<{ wfInboxItemId: bigint; kind: number; proposal: unknown }>,
  result: Record<string, unknown>,
): WfEffectSelection | null {
  if (step.type !== 'agent') return null;
  const item = items.find((i) => i.kind === WfInboxItemKind.AgentValidation);
  if (!item) return null;
  const proposal = item.proposal;
  if (!isPlainObject(proposal) || proposal.mode !== 'action') return null;
  if (proposal.suspicion_injection !== false) return null; // absent ou vrai : jamais d'effet (échec fermé)

  const stored = parseActions(proposal.preparedActions, 'la proposition enregistrée');
  const outcome = canonicalJson(proposal) === canonicalJson(result) ? 'accepted' : 'modified';
  if (outcome === 'accepted') return { itemId: item.wfInboxItemId, outcome, actions: stored };

  if (result.preparedActions === undefined) return { itemId: item.wfInboxItemId, outcome, actions: [] };
  const requested = parseActions(result.preparedActions, 'le résultat modifié');
  const allowed = new Map<string, number>();
  for (const a of stored) allowed.set(a.tool, (allowed.get(a.tool) ?? 0) + 1);
  for (const a of requested) {
    const left = allowed.get(a.tool) ?? 0;
    if (left <= 0) {
      throw new WfEngineError(
        'INVALID_INPUT',
        `Action « ${a.tool} » non proposée par l'agent (ou en nombre supérieur) : une modification ne peut pas ajouter d'action. Rien n'a été enregistré.`,
        { code: 'action_not_proposed', tool: a.tool },
      );
    }
    allowed.set(a.tool, left - 1);
  }
  return { itemId: item.wfInboxItemId, outcome, actions: requested };
}

function parseActions(raw: unknown, where: string): WfEffectAction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new WfEngineError('INVALID_INPUT', `Actions préparées illisibles dans ${where} : rien n'a été enregistré.`, {
      code: 'actions_invalid',
      tool: null,
    });
  }
  if (raw.length > WF_EFFECT_ACTIONS_MAX) {
    throw new WfEngineError(
      'INVALID_INPUT',
      `Trop d'actions préparées dans ${where} (au plus ${WF_EFFECT_ACTIONS_MAX}) : rien n'a été enregistré.`,
      { code: 'actions_too_many', tool: null },
    );
  }
  return raw.map((entry, index) => {
    const parsed = actionSchema.safeParse(entry);
    if (!parsed.success) {
      throw new WfEngineError(
        'INVALID_INPUT',
        `Action préparée n°${index + 1} illisible dans ${where} : rien n'a été enregistré.`,
        { code: 'action_invalid', tool: null },
      );
    }
    return parsed.data;
  });
}

/** Message générique d'un échec technique (jamais le texte de l'erreur : il peut contenir des données). */
export const WF_EFFECT_TECHNICAL_MESSAGE =
  "Les actions validées n'ont pas pu être appliquées (erreur technique) : rien n'a été enregistré, réessayer ou refuser la proposition.";

/** Traduit une erreur de l'applicateur en erreur du moteur (refus explicable ou échec technique générique). */
export function toEffectEngineError(err: unknown): WfEngineError {
  if (err instanceof WfEngineError) return err;
  if (err instanceof WfEffectApplyError) {
    return new WfEngineError('INVALID_INPUT', err.message, { code: err.code, tool: err.tool });
  }
  return new WfEngineError('INVALID_INPUT', WF_EFFECT_TECHNICAL_MESSAGE, { code: 'effect_failed', tool: null });
}

/** Action retenue sans applicateur (port absent ou action ignorée) : refus, jamais d'acceptation silencieuse. */
export function noApplierError(tool: string): WfEngineError {
  return new WfEngineError(
    'INVALID_INPUT',
    `Aucun applicateur pour l'action « ${tool} » : elle ne peut pas être appliquée et rien n'a été enregistré. Refuser la proposition ou la modifier sans cette action.`,
    { code: 'no_applier', tool },
  );
}

/** Compensation éventuelle portée par une erreur de l'applicateur. */
export function compensationOf(err: unknown): (() => Promise<void>) | undefined {
  return err instanceof WfEffectApplyError && typeof err.compensate === 'function' ? err.compensate : undefined;
}

/** Appelle les compensations (ordre inverse), sans jamais lever ; chaque erreur est remise à `onError`. */
export async function runCompensations(
  compensations: ReadonlyArray<() => Promise<void>>,
  onError: (err: unknown) => void,
): Promise<void> {
  for (const fn of [...compensations].reverse()) {
    try {
      await fn();
    } catch (err) {
      try {
        onError(err);
      } catch {
        // jamais de levée
      }
    }
  }
}
