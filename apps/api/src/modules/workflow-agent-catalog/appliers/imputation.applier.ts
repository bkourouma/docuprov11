import { Inject, Injectable } from '@nestjs/common';
import type { ZodType } from 'zod';
import {
  BASE_TOOL_KEYS,
  CATALOG_TOOL_KEYS,
  EffectRefusedError,
  IMPUTATION_RECIPIENTS_MAX,
  MAIL_INPUTATION_TYPE_IDS,
  WF_IMPUTABLE_ACTORS,
  imputationBaseArgsSchema,
  imputationCourrierArgsSchema,
  type ActionApplier,
  type ApplierContext,
  type ApplierResult,
  type ImputableActorsPort,
  type ImputationBaseArgs,
  type ImputationCourrierArgs,
} from '../catalog.contracts';
import { IMPUTATION_MENU_KEYS } from './imputable-actors.service';

/**
 * Applicateurs d'IMPUTATION de courrier (après validation humaine, dans la transaction du moteur).
 *
 * Règles (échec fermé ; un refus annule TOUTE la validation, message sans contenu de courrier) :
 *  - le valideur ET le lanceur détiennent un menu d'imputation (garde de `POST /courriers/imputations`) et
 *    peuvent LIRE le courrier (règle de l'outil `lire_courrier`) ; courrier non supprimé ;
 *  - chaque destinataire est imputable par le valideur ET par le lanceur (`ImputableActorsPort`) : un seul
 *    destinataire refusé => aucune imputation ;
 *  - type d'imputation = ligne ACTIVE de `mail_inputation_type` ; pas de doublon (acteur + type) dans l'action ;
 *  - une imputation identique encore ouverte (même courrier, acteur, type, `dateTreated` nul) n'est pas
 *    dupliquée (effet `already_present`) ;
 *  - échéance = maintenant + `delayDays` jours ; par défaut +2 jours pour les validations DG (5) et Direction
 *    (14), comme `createValidation` (+48 h), sinon aucune ;
 *  - écritures par `ctx.tx` seulement : `mail_inputation` (auteur = VALIDEUR) puis notification IN-APP
 *    « Courrier imputé : <objet> ». JAMAIS d'e-mail (le service de notifications envoie des e-mails hors
 *    transaction : il n'est pas appelé).
 *
 * LIMITE : le contrôle bureau d'ordre automatique (§06, `MailsService.autoValiderOnImputation`) n'est PAS
 * rejoué (il n'est pas transactionnel) : le courrier garde son état de contrôle, à valider par l'interface.
 */

const DAY_MS = 24 * 3600 * 1000;
const VALIDATION_DEFAULT_DELAY_DAYS = 2;
const VALIDATION_TYPES: ReadonlySet<number> = new Set([
  MAIL_INPUTATION_TYPE_IDS.validationDG,
  MAIL_INPUTATION_TYPE_IDS.validationDirection,
]);
const NOTIFICATION_TITLE_MAX = 300;

/** Clé `scratch` : imputations créées par le lot en cours (identifiants). */
export const SCRATCH_IMPUTATIONS_CREATED = 'imputation.created';

function parseWith<T>(schema: ZodType<T>, args: unknown, toolKey: string): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new EffectRefusedError(
      `Arguments invalides pour l'action « ${toolKey} » : aucune imputation n'a été appliquée.`,
      'invalid_arguments',
    );
  }
  return parsed.data;
}

/** Cœur commun : applique une imputation (plusieurs destinataires) dans `ctx.tx`. */
export async function applyImputation(
  ctx: ApplierContext,
  args: ImputationCourrierArgs,
  toolKey: string,
  actors: ImputableActorsPort,
): Promise<ApplierResult> {
  const { tx, rights, now } = ctx;
  if (args.recipients.length < 1 || args.recipients.length > IMPUTATION_RECIPIENTS_MAX) {
    throw new EffectRefusedError(
      `Nombre de destinataires invalide (1 à ${IMPUTATION_RECIPIENTS_MAX}) : aucune imputation n'a été appliquée.`,
      'recipients_invalid',
    );
  }
  await rights.requireAnyMenu(IMPUTATION_MENU_KEYS, 'imputer un courrier');
  await rights.requireMailReadable(args.mailId);

  const mail = await tx.mail.findFirst({ where: { mailId: args.mailId, isDeleted: false }, select: { mailId: true, title: true } });
  if (!mail) {
    throw new EffectRefusedError(
      `Le courrier n°${args.mailId} est introuvable ou supprimé : aucune imputation n'a été appliquée.`,
      'mail_not_found',
    );
  }

  const seen = new Set<string>();
  for (const r of args.recipients) {
    const key = `${r.userGroupId}:${r.mailInputationTypeId}`;
    if (seen.has(key)) {
      throw new EffectRefusedError(
        `Le destinataire n°${r.userGroupId} figure deux fois avec le même type d'imputation : aucune imputation n'a été appliquée.`,
        'duplicate_recipient',
      );
    }
    seen.add(key);
  }

  for (const r of args.recipients) {
    const byValidator = await actors.isImputable(rights.validator, r.userGroupId);
    const byLauncher = byValidator && (await actors.isImputable(rights.launcher, r.userGroupId));
    if (!byValidator || !byLauncher) {
      throw new EffectRefusedError(
        `Le destinataire n°${r.userGroupId} n'est pas imputable (compte désactivé, sans accès au courrier, ou droits insuffisants du ${
          byValidator ? 'lanceur' : 'valideur'
        }) : aucune imputation n'a été appliquée.`,
        'recipient_not_imputable',
      );
    }
  }

  const typeIds = [...new Set(args.recipients.map((r) => r.mailInputationTypeId))];
  const activeTypes = await tx.mailInputationType.findMany({
    where: { mailInputationTypeId: { in: typeIds }, isActive: true },
    select: { mailInputationTypeId: true },
  });
  const active = new Set(activeTypes.map((t) => t.mailInputationTypeId));
  for (const id of typeIds) {
    if (!active.has(id)) {
      throw new EffectRefusedError(
        `Type d'imputation n°${id} inconnu ou inactif : aucune imputation n'a été appliquée.`,
        'inputation_type_invalid',
      );
    }
  }

  const validatorId = ctx.validatorPrincipal.userGroupId;
  const title = (mail.title ?? '').trim();
  const message = `Courrier imputé : ${title ? truncate(title, NOTIFICATION_TITLE_MAX) : `#${mail.mailId}`}`;
  const created: number[] = [];
  const alreadyPresent: number[] = [];
  for (const r of args.recipients) {
    const existing = await tx.mailInputation.findFirst({
      where: { mailId: mail.mailId, userId: r.userGroupId, mailInputationTypeId: r.mailInputationTypeId, dateTreated: null },
      select: { mailInputationId: true },
    });
    if (existing) {
      alreadyPresent.push(existing.mailInputationId);
      continue;
    }
    const delayDays =
      r.delayDays ?? (VALIDATION_TYPES.has(r.mailInputationTypeId) ? VALIDATION_DEFAULT_DELAY_DAYS : undefined);
    const row = await tx.mailInputation.create({
      data: {
        mailId: mail.mailId,
        userId: r.userGroupId,
        mailInputationTypeId: r.mailInputationTypeId,
        instructions: r.instructions ?? null,
        deadline: delayDays === undefined ? null : new Date(now.getTime() + delayDays * DAY_MS),
        createdBy: validatorId,
        createdAt: now,
      },
      select: { mailInputationId: true },
    });
    created.push(row.mailInputationId);
    await tx.notification.create({
      data: {
        recipientUserGroupId: r.userGroupId,
        message,
        targetType: 'mail',
        targetId: mail.mailId,
        createdAt: now,
      },
    });
  }

  const previous = ctx.scratch.get(SCRATCH_IMPUTATIONS_CREATED);
  ctx.scratch.set(SCRATCH_IMPUTATIONS_CREATED, [...(Array.isArray(previous) ? previous : []), ...created]);

  return {
    effects: [
      {
        tool: toolKey,
        summary: {
          status: created.length > 0 ? 'applied' : 'already_present',
          mailId: mail.mailId,
          recipients: args.recipients.length,
          created,
          alreadyPresent,
        },
      },
    ],
  };
}

/** `proposer_imputation_courrier` : imputation à plusieurs destinataires, type et délai. */
@Injectable()
export class ImputationCourrierApplier implements ActionApplier<ImputationCourrierArgs> {
  readonly toolKey = CATALOG_TOOL_KEYS.proposerImputationCourrier;
  readonly sideEffect = 1 as const;

  constructor(@Inject(WF_IMPUTABLE_ACTORS) private readonly actors: ImputableActorsPort) {}

  parse(args: unknown): ImputationCourrierArgs {
    return parseWith(imputationCourrierArgsSchema, args, this.toolKey);
  }

  apply(ctx: ApplierContext, args: ImputationCourrierArgs): Promise<ApplierResult> {
    return applyImputation(ctx, args, this.toolKey, this.actors);
  }
}

/**
 * `proposer_imputation` (outil de base W2) : un seul destinataire. Seul `target.kind = 'user'` est appliqué ;
 * `imputationType` (libellé libre) est rapproché, sans tenir compte de la casse, des types ACTIFS du
 * référentiel, sinon type 10 « Pour Suivi ». Mêmes règles que l'applicateur principal.
 */
@Injectable()
export class ImputationBaseApplier implements ActionApplier<ImputationBaseArgs> {
  readonly toolKey = BASE_TOOL_KEYS.proposerImputation;
  readonly sideEffect = 1 as const;

  constructor(@Inject(WF_IMPUTABLE_ACTORS) private readonly actors: ImputableActorsPort) {}

  parse(args: unknown): ImputationBaseArgs {
    return parseWith(imputationBaseArgsSchema, args, this.toolKey);
  }

  async apply(ctx: ApplierContext, args: ImputationBaseArgs): Promise<ApplierResult> {
    if (args.target.kind !== 'user') {
      throw new EffectRefusedError(
        'Imputation à un rôle non prise en charge : proposer des destinataires précis. Aucune imputation n’a été appliquée.',
        'target_role_unsupported',
      );
    }
    const typeId = await resolveTypeByLabel(ctx, args.imputationType);
    return applyImputation(
      ctx,
      { mailId: args.mailId, recipients: [{ userGroupId: args.target.id, mailInputationTypeId: typeId }], rationale: args.rationale },
      this.toolKey,
      this.actors,
    );
  }
}

/** Type actif de même libellé (casse et espaces ignorés), sinon « Pour Suivi » (10). */
async function resolveTypeByLabel(ctx: ApplierContext, label: string | undefined): Promise<number> {
  const wanted = normalizeLabel(label);
  if (!wanted) return MAIL_INPUTATION_TYPE_IDS.pourSuivi;
  const types = await ctx.tx.mailInputationType.findMany({
    where: { isActive: true },
    select: { mailInputationTypeId: true, label: true },
    orderBy: { mailInputationTypeId: 'asc' },
  });
  return types.find((t) => normalizeLabel(t.label) === wanted)?.mailInputationTypeId ?? MAIL_INPUTATION_TYPE_IDS.pourSuivi;
}

function normalizeLabel(label: string | undefined | null): string {
  return typeof label === 'string' ? label.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr') : '';
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}
