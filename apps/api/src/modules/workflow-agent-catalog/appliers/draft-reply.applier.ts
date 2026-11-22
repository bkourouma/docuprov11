import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { DiskFileStore } from '@archivage/storage';
import { createHash } from 'node:crypto';
import type { AuthUser } from '../../auth/auth.types';
import { CollabDocumentsService } from '../../collab/documents/collab-documents.service';
import { findDraftTemplate } from '../../drafting/drafting-templates';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveSpaceAccess, type SpaceActor } from '../../spaces/domain';
import {
  BASE_TOOL_KEYS,
  CATALOG_TOOL_KEYS,
  DRAFT_HTML_MAX_CHARS,
  EffectRefusedError,
  brouillonReponseArgsSchema,
  reponseBaseArgsSchema,
  type ActionApplier,
  type ApplierContext,
  type ApplierResult,
  type BrouillonReponseArgs,
  type ReponseBaseArgs,
} from '../catalog.contracts';
import { parseStrict } from './extra/extra-applier.utils';

const NO_ACTOR: SpaceActor = Object.freeze({ userGroupIds: [], roleId: null, isAdmin: false });
const NO_SPACE_MESSAGE = 'Aucun espace de destination : renseigner draftSpaceId au lancement.';
const SCRATCH_PREFIX = 'draft-reply:';

/** Échappement des caractères sensibles en HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Texte brut -> HTML : un paragraphe par bloc séparé d'une ligne vide, retours simples en `<br>`, tout échappé. */
export function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

interface DraftRequest {
  readonly label: string;
  readonly html: string;
  readonly mailId: number | undefined;
  readonly spaceId: number | undefined;
  readonly templateId: string | null;
}

/**
 * Logique commune : crée un document brouillon (jamais envoyé ni publié) dans un espace, au nom du VALIDEUR,
 * après avoir vérifié que le valideur ET le lanceur peuvent contribuer à l'espace.
 *
 * Droit d'espace : `CollabDocumentsService.assertCanContribute` est privé ; la règle (domaine pur
 * `resolveSpaceAccess`) est donc reproduite ici, par lecture directe via `ctx.tx`, pour les DEUX utilisateurs.
 * Le service refait ensuite son propre contrôle pour le valideur à la création.
 *
 * Non transactionnel : `createDocumentFromHtml` écrit via son propre client et sur disque. `compensate` supprime
 * le document (et ses binaires) ; le moteur doit l'appeler si la transaction échoue après l'application.
 */
abstract class DraftApplierBase {
  private readonly logger = new Logger(DraftApplierBase.name);

  protected constructor(
    private readonly collabDocuments: CollabDocumentsService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  protected async createDraft(ctx: ApplierContext, tool: string, req: DraftRequest): Promise<ApplierResult> {
    const spaceId = req.spaceId ?? this.spaceFromInput(ctx);
    if (spaceId === undefined) throw new EffectRefusedError(NO_SPACE_MESSAGE, 'no_space');
    if (req.html.length > DRAFT_HTML_MAX_CHARS) {
      throw new EffectRefusedError('Brouillon refusé : contenu trop volumineux.', 'draft_too_large');
    }
    if (req.mailId !== undefined) await ctx.rights.requireMailReadable(req.mailId);

    await this.assertCanContribute(ctx.tx, spaceId, ctx.rights.validator, 'valideur');
    await this.assertCanContribute(ctx.tx, spaceId, ctx.rights.launcher, 'lanceur');

    // Doublon dans le lot : même brouillon, même espace => on ne crée rien de plus.
    const fingerprint = createHash('sha256').update(`${spaceId}\u0000${req.label}\u0000${req.html}`).digest('hex');
    const memo = ctx.scratch.get(SCRATCH_PREFIX + fingerprint);
    if (typeof memo === 'number') {
      return {
        effects: [
          { tool, summary: { documentId: memo, spaceId, templateId: req.templateId, status: 'already_present' } },
        ],
      };
    }

    let created: { documentId: number };
    try {
      created = await this.collabDocuments.createDocumentFromHtml(spaceId, req.label, req.html, ctx.rights.validator);
    } catch (e) {
      throw this.translate(e);
    }
    const documentId = created.documentId;
    ctx.scratch.set(SCRATCH_PREFIX + fingerprint, documentId);

    let compensated = false;
    return {
      effects: [{ tool, summary: { documentId, spaceId, templateId: req.templateId } }],
      compensate: async () => {
        if (compensated) return;
        compensated = true;
        await this.removeDocument(documentId);
      },
    };
  }

  private spaceFromInput(ctx: ApplierContext): number | undefined {
    const raw = ctx.input['draftSpaceId'];
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 2_147_483_647 ? raw : undefined;
  }

  private translate(e: unknown): Error {
    if (e instanceof ForbiddenException || e instanceof NotFoundException) {
      return new EffectRefusedError(
        'Brouillon refusé : droit de contribution requis sur l’espace de destination.',
        'space_denied',
      );
    }
    const status = (e as { getStatus?: () => number } | null)?.getStatus?.();
    if (status === 400) {
      return new EffectRefusedError('Brouillon refusé : le contenu ne peut pas être converti en document.', 'draft_invalid');
    }
    return e instanceof Error ? e : new Error('Erreur inconnue lors de la création du brouillon');
  }

  /** Même règle que `CollabDocumentsService.assertCanContribute` (espace invisible ou sans droit de contribution = refus). */
  private async assertCanContribute(
    tx: Prisma.TransactionClient,
    spaceId: number,
    user: AuthUser,
    role: 'valideur' | 'lanceur',
  ): Promise<void> {
    const denied = (): EffectRefusedError =>
      new EffectRefusedError(
        `Brouillon refusé : le ${role} ne peut pas contribuer à l’espace de destination.`,
        'space_denied',
      );
    if (user.isScanAgent || user.userGroupId == null) throw denied();
    const actor = await this.resolveActor(tx, user);
    const space = await tx.gedSpace.findUnique({
      where: { gedSpaceId: spaceId },
      select: {
        kind: true,
        isActive: true,
        ownerUserGroupId: true,
        members: {
          where: {
            OR: [
              { userGroupId: { in: [...actor.userGroupIds] } },
              ...(actor.roleId != null ? [{ roleId: actor.roleId }] : []),
            ],
          },
          select: { userGroupId: true, roleId: true, permission: true },
        },
      },
    });
    if (!space) throw denied();
    const decision = resolveSpaceAccess(
      { kind: space.kind, isActive: space.isActive, ownerUserGroupId: space.ownerUserGroupId, members: space.members },
      actor,
    );
    if (!decision.visible || !decision.canContribute) throw denied();
  }

  private async resolveActor(tx: Prisma.TransactionClient, user: AuthUser): Promise<SpaceActor> {
    const [groups, account] = await Promise.all([
      tx.appUserGroup.findMany({ where: { userId: user.userId }, select: { userGroupId: true } }),
      tx.appUser.findUnique({
        where: { userId: user.userId },
        select: { isDisabled: true, roleId: true, role: { select: { isActive: true } } },
      }),
    ]);
    if (!account || account.isDisabled) return NO_ACTOR;
    return {
      userGroupIds: groups.map((g) => g.userGroupId),
      roleId: account.roleId != null && account.role?.isActive ? account.roleId : null,
      isAdmin: user.isAdmin,
    };
  }

  /** Suppression idempotente et silencieuse (journal : identifiant et type d'erreur seulement, jamais de contenu). */
  private async removeDocument(documentId: number): Promise<void> {
    try {
      const doc = await this.prisma.document.findUnique({
        where: { documentId },
        select: { versions: { select: { files: { select: { fileId: true, fileExtension: true } } } } },
      });
      if (!doc) return;
      const files = doc.versions.flatMap((v) => v.files);
      await this.prisma.document.delete({ where: { documentId } });
      try {
        const store = new DiskFileStore(this.config.getOrThrow<string>('ARCHIVES_PATH'));
        await Promise.all(files.map((f) => store.remove(f.fileId, f.fileExtension)));
      } catch (e) {
        this.logger.warn(`Binaires du brouillon ${documentId} non retirés : ${(e as Error).name}`);
      }
    } catch (e) {
      this.logger.error(`Annulation du brouillon ${documentId} impossible, à nettoyer à la main : ${(e as Error).name}`);
    }
  }
}

/** `preparer_brouillon_reponse` : brouillon issu d'un modèle de rédaction (HTML déjà généré à la préparation). */
@Injectable()
export class DraftReplyApplier extends DraftApplierBase implements ActionApplier<BrouillonReponseArgs> {
  readonly toolKey = CATALOG_TOOL_KEYS.preparerBrouillonReponse;
  readonly sideEffect = 1 as const;

  constructor(
    @Inject(CollabDocumentsService) collabDocuments: CollabDocumentsService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    super(collabDocuments, prisma, config);
  }

  parse(args: unknown): BrouillonReponseArgs {
    return parseStrict(brouillonReponseArgsSchema, args, this.toolKey);
  }

  apply(ctx: ApplierContext, args: BrouillonReponseArgs): Promise<ApplierResult> {
    if (!findDraftTemplate(args.templateId)) {
      return Promise.reject(new EffectRefusedError('Brouillon refusé : modèle de rédaction inconnu.', 'unknown_template'));
    }
    return this.createDraft(ctx, this.toolKey, {
      label: args.label,
      html: args.draftHtml,
      mailId: args.mailId,
      spaceId: args.spaceId,
      templateId: args.templateId,
    });
  }
}

/** `proposer_reponse` (outil de base) : objet + texte brut, converti en HTML ; espace = `draftSpaceId` du lancement. */
@Injectable()
export class DraftReplyBaseApplier extends DraftApplierBase implements ActionApplier<ReponseBaseArgs> {
  readonly toolKey = BASE_TOOL_KEYS.proposerReponse;
  readonly sideEffect = 1 as const;

  constructor(
    @Inject(CollabDocumentsService) collabDocuments: CollabDocumentsService,
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    super(collabDocuments, prisma, config);
  }

  parse(args: unknown): ReponseBaseArgs {
    return parseStrict(reponseBaseArgsSchema, args, this.toolKey);
  }

  apply(ctx: ApplierContext, args: ReponseBaseArgs): Promise<ApplierResult> {
    return this.createDraft(ctx, this.toolKey, {
      label: args.subject,
      html: plainTextToHtml(args.bodyText),
      mailId: args.mailId,
      spaceId: undefined,
      templateId: null,
    });
  }
}
