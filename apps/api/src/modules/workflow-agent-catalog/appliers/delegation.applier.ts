import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_TOOL_KEYS,
  EffectRefusedError,
  WF_IMPUTABLE_ACTORS,
  declaredDelegatesSchema,
  delegationArgsSchema,
  type ActionApplier,
  type ApplierContext,
  type ApplierResult,
  type DelegationArgs,
  type ImputableActorsPort,
} from '../catalog.contracts';
import { parseStrict } from './extra/extra-applier.utils';
import { IMPUTATION_MENU_KEYS } from './imputable-actors.service';

/**
 * `proposer_delegation` : crée une NOUVELLE imputation vers un délégataire déclaré par le concepteur
 * (`step.config.delegates`). L'imputation source n'est ni modifiée ni supprimée. Notification in-app seulement.
 */
@Injectable()
export class DelegationApplier implements ActionApplier<DelegationArgs> {
  readonly toolKey = CATALOG_TOOL_KEYS.proposerDelegation;
  readonly sideEffect = 1 as const;

  constructor(@Inject(WF_IMPUTABLE_ACTORS) private readonly actors: ImputableActorsPort) {}

  parse(args: unknown): DelegationArgs {
    return parseStrict(delegationArgsSchema, args, this.toolKey);
  }

  async apply(ctx: ApplierContext, args: DelegationArgs): Promise<ApplierResult> {
    await ctx.rights.requireMailReadable(args.mailId);

    const source = await ctx.tx.mailInputation.findUnique({
      where: { mailInputationId: args.mailInputationId },
      select: {
        mailId: true,
        userId: true,
        dateTreated: true,
        deadline: true,
        instructions: true,
        mailInputationTypeId: true,
      },
    });
    if (!source || source.mailId !== args.mailId) {
      throw new EffectRefusedError('Délégation refusée : imputation introuvable pour ce courrier.', 'inputation_not_found');
    }
    if (source.dateTreated !== null) {
      throw new EffectRefusedError('Délégation refusée : imputation déjà traitée.', 'inputation_treated');
    }

    this.assertDeclared(ctx, args.delegateUserGroupId, source.userId);

    await ctx.rights.requireAnyMenu(IMPUTATION_MENU_KEYS, 'imputer un courrier');
    for (const [role, user] of [
      ['valideur', ctx.rights.validator],
      ['lanceur', ctx.rights.launcher],
    ] as const) {
      if (!(await this.actors.canImpute(user))) {
        throw new EffectRefusedError(`Délégation refusée : le ${role} ne peut pas imputer.`, 'cannot_impute');
      }
      if (!(await this.actors.isImputable(user, args.delegateUserGroupId))) {
        throw new EffectRefusedError(
          `Délégation refusée : le délégataire n’est pas imputable par le ${role} (compte inactif ou hors périmètre).`,
          'delegate_not_imputable',
        );
      }
    }

    const createdBy = ctx.rights.validator.userGroupId;
    if (createdBy == null) {
      throw new EffectRefusedError('Délégation refusée : le valideur n’a pas de profil actif.', 'validator_no_profile');
    }

    // Doublon : même courrier, même acteur, même type, imputation encore ouverte.
    const existing = await ctx.tx.mailInputation.findFirst({
      where: {
        mailId: args.mailId,
        userId: args.delegateUserGroupId,
        mailInputationTypeId: source.mailInputationTypeId,
        dateTreated: null,
      },
      select: { mailInputationId: true },
    });
    if (existing) {
      return {
        effects: [
          {
            tool: this.toolKey,
            summary: {
              status: 'already_present',
              mailId: args.mailId,
              mailInputationId: existing.mailInputationId,
              delegateUserGroupId: args.delegateUserGroupId,
            },
          },
        ],
      };
    }

    const created = await ctx.tx.mailInputation.create({
      data: {
        mailId: args.mailId,
        userId: args.delegateUserGroupId,
        mailInputationTypeId: source.mailInputationTypeId,
        instructions: source.instructions,
        deadline: source.deadline,
        createdBy,
      },
      select: { mailInputationId: true },
    });

    const mail = await ctx.tx.mail.findUnique({ where: { mailId: args.mailId }, select: { title: true } });
    await ctx.tx.notification.create({
      data: {
        recipientUserGroupId: args.delegateUserGroupId,
        message: `Courrier imputé : ${mail?.title ?? `#${args.mailId}`}`,
        targetType: 'mail',
        targetId: args.mailId,
      },
    });

    return {
      effects: [
        {
          tool: this.toolKey,
          summary: {
            status: 'created',
            mailId: args.mailId,
            sourceMailInputationId: args.mailInputationId,
            mailInputationId: created.mailInputationId,
            delegateUserGroupId: args.delegateUserGroupId,
          },
        },
      ],
    };
  }

  private assertDeclared(ctx: ApplierContext, delegateUserGroupId: number, sourceUserGroupId: number): void {
    const parsed = declaredDelegatesSchema.safeParse(ctx.stepConfig['delegates']);
    const ok =
      parsed.success &&
      parsed.data.some(
        (d) =>
          d.userGroupId === delegateUserGroupId &&
          (d.forUserGroupId === undefined || d.forUserGroupId === sourceUserGroupId),
      );
    if (!ok) throw new EffectRefusedError('Délégation refusée : délégataire non déclaré.', 'delegate_not_declared');
  }
}
