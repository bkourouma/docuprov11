import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../auth/auth.types';
import {
  AgentIdentityError,
  WF_AGENT_IDENTITY,
  type WfAgentIdentityPort,
} from '../../workflow-agents/agent.contracts';
import {
  WfEffectApplyError,
  type WfEffectApplierPort,
  type WfEffectApplyInput,
  type WfEffectApplyOutput,
  type WfEffectSummary,
  type WfPrincipal,
} from '../../workflows/engine/engine.types';
import { EffectRefusedError, type ApplierContext, type ApplierRights } from '../catalog.contracts';
import { ActionApplierRegistry } from './action-applier.registry';
import { ApplierRightsService } from './applier-rights';

const LAUNCHER_REFUSAL: Record<string, string> = {
  not_found: 'Le lanceur du workflow est introuvable',
  disabled: 'Le compte du lanceur du workflow est désactivé',
  no_launch_right: "Le lanceur du workflow n'a plus le droit de lancer un workflow",
  invalid: 'Identité du lanceur du workflow invalide',
};

/** Fabrique des droits conjoints (injectée : remplaçable en test). */
export interface ApplierRightsFactory {
  create(validator: AuthUser, launcher: AuthUser, db: Pick<Prisma.TransactionClient, 'appUser'>): ApplierRights;
}

/**
 * Applicateur des actions validées (port `WfEffectApplierPort` du moteur), appelé DANS la transaction de la
 * validation humaine :
 *  1. identité du LANCEUR relue en base (compte actif, droit de lancer, `isAdmin` réel) et du VALIDEUR (compte
 *     actif, cohérence acteur/utilisateur, `isAdmin` réel) : toute anomalie => refus explicable ;
 *  0. AVANT tout : chaque action doit avoir un applicateur enregistré, sinon refus `no_applier` (rien appliqué) ;
 *  2. pour chaque action : applicateur retrouvé par `tool`, arguments revalidés STRICTEMENT (`parse`) ;
 *  3. application séquentielle dans `tx`, avec une mémoire `scratch` partagée par le lot ;
 *  4. collecte des compensations (effets non transactionnels).
 * Tout refus ou échec lève `WfEffectApplyError` (portant les compensations déjà collectées) : le moteur annule
 * la transaction. Les messages ne contiennent jamais de contenu de courrier ; les logs, seulement l'outil et le
 * type d'erreur.
 */
@Injectable()
export class EffectDispatcher implements WfEffectApplierPort {
  private readonly logger = new Logger(EffectDispatcher.name);

  constructor(
    private readonly registry: ActionApplierRegistry,
    @Inject(WF_AGENT_IDENTITY) private readonly identity: WfAgentIdentityPort,
    @Inject(ApplierRightsService) private readonly rightsFactory: ApplierRightsFactory,
  ) {}

  async apply(input: WfEffectApplyInput): Promise<WfEffectApplyOutput> {
    // Échec fermé : toutes les actions doivent avoir un applicateur, sinon RIEN n'est appliqué.
    const missing = input.actions.find((a) => !this.registry.has(a.tool));
    if (missing) throw noApplier(missing.tool);
    const launcher = await this.resolveLauncher(input.launcherUserGroupId);
    const validator = await this.resolveValidator(input.tx, input.validator);
    const rights = this.rightsFactory.create(validator, launcher, input.tx);
    const ctx: ApplierContext = {
      tx: input.tx,
      now: input.now,
      instanceId: input.instanceId,
      taskId: input.taskId,
      stepKey: input.stepKey,
      definitionVersionId: input.definitionVersionId,
      subject: { ...input.subject },
      input: input.input,
      stepConfig: input.stepConfig,
      validatorPrincipal: input.validator,
      rights,
      scratch: new Map<string, unknown>(),
    };

    const effects: WfEffectSummary[] = [];
    const compensations: Array<() => Promise<void>> = [];
    for (const action of input.actions) {
      const applier = this.registry.get(action.tool);
      // Filet (registre modifié pendant le lot) : même refus, compensations déjà collectées portées par l'erreur.
      if (!applier) throw noApplier(action.tool, combine(compensations));
      try {
        let args: unknown;
        try {
          args = applier.parse(action.arguments);
        } catch (err) {
          if (err instanceof EffectRefusedError) throw err;
          throw new EffectRefusedError(
            `Arguments invalides pour l'action « ${action.tool} » : aucune action n'a été appliquée.`,
            'invalid_arguments',
          );
        }
        const result = await applier.apply(ctx, args);
        if (typeof result?.compensate === 'function') compensations.push(result.compensate);
        for (const e of Array.isArray(result?.effects) ? result.effects : []) {
          effects.push({ tool: typeof e.tool === 'string' ? e.tool : action.tool, summary: { ...(e.summary ?? {}) } });
        }
      } catch (err) {
        const compensate = combine(compensations);
        if (err instanceof EffectRefusedError) {
          throw new WfEffectApplyError(err.message, err.code, action.tool, compensate);
        }
        this.logger.error(`application de « ${action.tool} » en échec (tâche ${input.taskId}) : ${errorName(err)}`);
        throw new WfEffectApplyError(
          `L'action « ${action.tool} » n'a pas pu être appliquée (erreur technique) : rien n'a été enregistré.`,
          'effect_failed',
          action.tool,
          compensate,
        );
      }
    }
    return { effects, ...(compensations.length > 0 ? { compensate: combine(compensations) } : {}) };
  }

  private async resolveLauncher(userGroupId: number): Promise<AuthUser> {
    try {
      return (await this.identity.resolve(userGroupId)).user;
    } catch (err) {
      if (err instanceof AgentIdentityError) {
        const base = LAUNCHER_REFUSAL[err.code] ?? 'Identité du lanceur du workflow refusée';
        throw new WfEffectApplyError(`${base} : aucune action n'a été appliquée.`, `launcher_${err.code}`);
      }
      throw err;
    }
  }

  /** Valideur relu en base (pas le jeton) : acteur existant, cohérent avec le principal, compte actif. */
  private async resolveValidator(tx: Prisma.TransactionClient, principal: WfPrincipal): Promise<AuthUser> {
    const refuse = (code: string, what: string): never => {
      throw new WfEffectApplyError(`${what} : aucune action n'a été appliquée.`, `validator_${code}`);
    };
    if (!principal || !Number.isSafeInteger(principal.userGroupId) || principal.userGroupId < 1) {
      return refuse('invalid', 'Identité du valideur invalide');
    }
    const row = await tx.appUserGroup.findUnique({
      where: { userGroupId: principal.userGroupId },
      select: { userId: true, user: { select: { username: true, fullName: true, isAdmin: true, isDisabled: true } } },
    });
    if (!row || !row.user) return refuse('not_found', 'Le valideur est introuvable');
    if (row.userId !== principal.userId) return refuse('invalid', 'Identité du valideur incohérente');
    if (row.user.isDisabled) return refuse('disabled', 'Le compte du valideur est désactivé');
    return {
      userId: row.userId,
      username: row.user.username,
      isAdmin: row.user.isAdmin === true,
      userGroupId: principal.userGroupId,
      fullName: row.user.fullName ?? null,
    };
  }
}

/** Compensations en ordre inverse, chacune isolée : ne lève jamais. */
function combine(compensations: ReadonlyArray<() => Promise<void>>): (() => Promise<void>) | undefined {
  if (compensations.length === 0) return undefined;
  const list = [...compensations].reverse();
  return async () => {
    for (const fn of list) {
      try {
        await fn();
      } catch {
        // une compensation défaillante n'empêche pas les suivantes
      }
    }
  };
}

/** Refus d'une action sans applicateur : jamais ignorée en silence. */
function noApplier(tool: string, compensate?: () => Promise<void>): WfEffectApplyError {
  return new WfEffectApplyError(
    `Aucun applicateur pour l'action « ${tool} » : elle ne peut pas être appliquée et rien n'a été enregistré. Refuser la proposition ou la modifier sans cette action.`,
    'no_applier',
    tool,
    compensate,
  );
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'erreur inconnue';
}
