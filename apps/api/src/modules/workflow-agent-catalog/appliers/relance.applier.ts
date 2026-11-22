import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types';
import { effectiveMenuKeys } from '../../auth/menu-access';
import {
  CATALOG_TOOL_KEYS,
  EffectRefusedError,
  RELANCE_MAX_PER_INSTANCE_PER_DAY,
  RELANCE_MAX_PER_TARGET_PER_DAY,
  relanceArgsSchema,
  type ActionApplier,
  type ApplierContext,
  type ApplierResult,
  type RelanceArgs,
} from '../catalog.contracts';
import { RELANCE_MESSAGE_PREFIX, countInstanceRelancesToday, countTargetRelancesToday } from '../shared/relance-cap';
import { parseStrict } from './extra/extra-applier.utils';
import { IMPUTATION_MENU_KEYS } from './imputable-actors.service';

/** Compteur de relances du LOT de validation (clé de `ctx.scratch`). */
export const RELANCE_BATCH_COUNT_KEY = 'relance:batch-count';

/**
 * `proposer_relance` : relance INTERNE d'un imputé en retard. Notification applicative seulement
 * (`tx.notification.create`) : jamais d'appel au service Notifications, donc jamais d'e-mail.
 * Plafonds : par imputation et par jour UTC, par instance et par jour UTC (journal + lot en cours).
 * Un plafond atteint refuse l'action et annule donc tout le lot.
 */
@Injectable()
export class RelanceApplier implements ActionApplier<RelanceArgs> {
  readonly toolKey = CATALOG_TOOL_KEYS.proposerRelance;
  readonly sideEffect = 1 as const;

  parse(args: unknown): RelanceArgs {
    return parseStrict(relanceArgsSchema, args, this.toolKey);
  }

  async apply(ctx: ApplierContext, args: RelanceArgs): Promise<ApplierResult> {
    await ctx.rights.requireMailReadable(args.mailId);

    const inputation = await ctx.tx.mailInputation.findUnique({
      where: { mailInputationId: args.mailInputationId },
      select: { mailId: true, userId: true, dateTreated: true, deadline: true, createdBy: true },
    });
    if (!inputation || inputation.mailId !== args.mailId) {
      throw new EffectRefusedError('Relance refusée : imputation introuvable pour ce courrier.', 'inputation_not_found');
    }
    if (inputation.dateTreated !== null) {
      throw new EffectRefusedError('Relance refusée : imputation déjà traitée.', 'inputation_treated');
    }
    if (inputation.userId !== args.recipientUserGroupId) {
      throw new EffectRefusedError('Relance refusée : le destinataire n’est pas l’imputé.', 'recipient_mismatch');
    }
    await this.assertActiveAccount(ctx, args.recipientUserGroupId, 'l’imputé');
    await this.assertMayRemind(ctx, inputation.createdBy);

    if (inputation.deadline === null || inputation.deadline.getTime() >= ctx.now.getTime()) {
      throw new EffectRefusedError('Relance refusée : imputation pas en retard.', 'not_late');
    }

    const escalateTo = args.escalateToUserGroupId;
    if (escalateTo !== undefined) {
      if (inputation.createdBy === null || inputation.createdBy !== escalateTo) {
        throw new EffectRefusedError(
          'Relance refusée : seul l’auteur de l’imputation peut être prévenu en plus.',
          'escalation_not_author',
        );
      }
      await this.assertActiveAccount(ctx, escalateTo, 'l’auteur de l’imputation');
    }

    // Plafonds.
    const targetToday = await countTargetRelancesToday(ctx.tx, args.mailId, args.recipientUserGroupId, ctx.now);
    if (targetToday >= RELANCE_MAX_PER_TARGET_PER_DAY) {
      throw new EffectRefusedError(
        'Relance refusée : plafond quotidien atteint pour cet imputé sur ce courrier.',
        'relance_cap_target',
      );
    }
    const batchCount = this.batchCount(ctx);
    const instanceToday = await countInstanceRelancesToday(ctx.tx, ctx.instanceId, ctx.now);
    if (instanceToday + batchCount >= RELANCE_MAX_PER_INSTANCE_PER_DAY) {
      throw new EffectRefusedError(
        'Relance refusée : plafond quotidien de relances atteint pour ce workflow. Tout le lot est annulé.',
        'relance_cap_instance',
      );
    }

    const message = `${RELANCE_MESSAGE_PREFIX}${args.message}`;
    await ctx.tx.notification.create({
      data: {
        recipientUserGroupId: args.recipientUserGroupId,
        message,
        targetType: 'mail',
        targetId: args.mailId,
      },
    });
    if (escalateTo !== undefined && escalateTo !== args.recipientUserGroupId) {
      await ctx.tx.notification.create({
        data: {
          recipientUserGroupId: escalateTo,
          message: `${message} (copie à l’auteur de l’imputation)`,
          targetType: 'mail',
          targetId: args.mailId,
        },
      });
    }
    await ctx.tx.mailInputation.update({
      where: { mailInputationId: args.mailInputationId },
      data: { lastReminderSent: ctx.now },
    });
    ctx.scratch.set(RELANCE_BATCH_COUNT_KEY, batchCount + 1);

    return {
      effects: [
        {
          tool: this.toolKey,
          summary: {
            mailId: args.mailId,
            mailInputationId: args.mailInputationId,
            recipientUserGroupId: args.recipientUserGroupId,
            escalated: escalateTo !== undefined && escalateTo !== args.recipientUserGroupId,
          },
        },
      ],
    };
  }

  /**
   * Valideur ET lanceur : menu d'imputation (l'administrateur les a tous) OU auteur de l'imputation visée.
   * Menus relus en base via `ctx.tx`, même règle que les droits conjoints (`effectiveMenuKeys`).
   */
  private async assertMayRemind(ctx: ApplierContext, authorUserGroupId: number | null): Promise<void> {
    for (const [role, user] of [
      ['valideur', ctx.rights.validator],
      ['lanceur', ctx.rights.launcher],
    ] as const) {
      const isAuthor = authorUserGroupId !== null && user.userGroupId === authorUserGroupId;
      if (isAuthor) continue;
      if (!(await this.hasImputationMenu(ctx, user))) {
        throw new EffectRefusedError(
          `Relance refusée : le ${role} n’a ni le droit d’imputer ni la qualité d’auteur de l’imputation.`,
          'relance_not_allowed',
        );
      }
    }
  }

  private async hasImputationMenu(ctx: ApplierContext, user: AuthUser): Promise<boolean> {
    if (user.isScanAgent || user.userGroupId == null) return false;
    const row = await ctx.tx.appUser.findUnique({
      where: { userId: user.userId },
      select: {
        isAdmin: true,
        isDisabled: true,
        role: { select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } } },
      },
    });
    if (!row || row.isDisabled) return false;
    const granted = effectiveMenuKeys(row.isAdmin === true, row.role);
    return IMPUTATION_MENU_KEYS.some((k) => granted.includes(k));
  }

  private batchCount(ctx: ApplierContext): number {
    const raw = ctx.scratch.get(RELANCE_BATCH_COUNT_KEY);
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 0;
  }

  private async assertActiveAccount(ctx: ApplierContext, userGroupId: number, who: string): Promise<void> {
    const row = await ctx.tx.appUserGroup.findUnique({
      where: { userGroupId },
      select: { user: { select: { isDisabled: true } } },
    });
    if (!row || row.user.isDisabled) {
      throw new EffectRefusedError(`Relance refusée : le compte de ${who} n’est pas actif.`, 'account_inactive');
    }
  }
}
