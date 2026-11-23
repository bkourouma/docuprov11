import { HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GedSpacePermission } from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import { MailSearchService } from '../../courriers/mail-search.service';
import { MailsService } from '../../courriers/mails.service';
import { DRAFT_TEMPLATES } from '../../drafting/drafting-templates';
import { DraftingService } from '../../drafting/drafting.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SpacesService } from '../../spaces/spaces.service';
import { ImputableActorsService } from '../../workflow-agent-catalog/appliers/imputable-actors.service';
import { WF_CATALOG_DATA, type CatalogDataPort } from '../../workflow-agent-catalog/tools/catalog-data.port';
import { AgentDataAdapter } from '../../workflow-agents/tools/agent-data.adapter';
import {
  PLANNER_SEARCH_MAX_LIMIT,
  type AsstPlannerDataPort,
  type PlannerActorView,
  type PlannerDraftResult,
  type PlannerDraftTemplateView,
  type PlannerInputationTypeView,
  type PlannerInputationView,
  type PlannerMailHit,
  type PlannerMailView,
  type PlannerSpaceView,
} from './planner.types';

/** Courriers candidats lus avant filtrage par droits (de quoi en garder `limit` même si certains sont refusés). */
const SEARCH_CANDIDATE_FACTOR = 3;
const SEARCH_CANDIDATE_MAX = 30;
/** Pièces du courrier utilisées comme contexte d'un brouillon. */
const DRAFT_CONTEXT_DOCUMENTS_MAX = 3;
/** Imputations d'un courrier lues au plus. */
const INPUTATIONS_MAX = 100;

const MSG_DRAFT_DENIED = 'Brouillon refusé : modèle, courrier ou document inaccessible.';
const MSG_DRAFT_INVALID = 'Brouillon refusé : la demande de rédaction est invalide.';
const MSG_DRAFT_FAILED = 'Génération du brouillon impossible pour le moment.';

/**
 * Adaptateur de données du planificateur de l'assistant. LECTURE SEULE, toujours au nom de l'utilisateur
 * (relu en base par l'identité) : réutilise les services existants et leurs règles de droits. Refus et
 * inexistant donnent la même réponse (`null`, liste vide). Aucun contenu n'est journalisé.
 *
 * Échec fermé : une exception inattendue vaut refus. Pour les contrôles de doublon et de plafond, la valeur
 * de repli est celle qui BLOQUE la proposition (imputation ouverte = oui, relances du jour = plafond atteint).
 */
@Injectable()
export class AsstPlannerDataAdapter implements AsstPlannerDataPort {
  private readonly logger = new Logger(AsstPlannerDataAdapter.name);

  constructor(
    private readonly agentData: AgentDataAdapter,
    @Inject(WF_CATALOG_DATA) private readonly catalog: CatalogDataPort,
    private readonly imputables: ImputableActorsService,
    private readonly mailSearch: MailSearchService,
    private readonly spaces: SpacesService,
    private readonly drafting: DraftingService,
    private readonly prisma: PrismaService,
    private readonly mails: MailsService,
  ) {}

  // -------------------------------------------------------------------------
  // Courriers
  // -------------------------------------------------------------------------

  async readMail(user: AuthUser, mailId: number, maxChars: number): Promise<PlannerMailView | null> {
    if (!hasActor(user) || !validId(mailId)) return null;
    try {
      const view = await this.agentData.readMail(user, mailId, Math.max(0, maxChars));
      if (!view) return null;
      return {
        mailId: view.mailId,
        reference: view.reference,
        title: view.title,
        date: view.date,
        senderLabel: view.senderLabel,
        natureLabel: view.natureLabel,
        objetLabel: view.objetLabel,
        confidentialiteLabel: view.confidentialiteLabel,
        text: view.text,
      };
    } catch (err) {
      this.warn('lecture du courrier', err);
      return null;
    }
  }

  async searchMails(user: AuthUser, query: string, limit: number): Promise<PlannerMailHit[]> {
    if (!hasActor(user)) return [];
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) return [];
    const bound = clamp(limit, 1, PLANNER_SEARCH_MAX_LIMIT);
    try {
      const found = await this.mailSearch.search({
        fullText: text,
        page: 1,
        pageSize: Math.min(SEARCH_CANDIDATE_MAX, bound * SEARCH_CANDIDATE_FACTOR),
        sort: [{ field: 'date', dir: 'desc' }],
      });
      const out: PlannerMailHit[] = [];
      const seen = new Set<number>();
      for (const row of found.rows) {
        if (out.length >= bound) break;
        if (seen.has(row.mailId)) continue;
        seen.add(row.mailId);
        // Droit de lecture de l'utilisateur appliqué à CHAQUE résultat.
        const readable = await this.agentData.readMail(user, row.mailId, 0);
        if (!readable) continue;
        out.push({
          mailId: readable.mailId,
          reference: readable.reference,
          title: readable.title,
          date: readable.date,
          senderLabel: readable.senderLabel,
        });
      }
      return out;
    } catch (err) {
      this.warn('recherche de courriers', err);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Acteurs et types d'imputation
  // -------------------------------------------------------------------------

  async listActors(user: AuthUser, opts: { search?: string; limit: number }): Promise<PlannerActorView[]> {
    if (!hasActor(user)) return [];
    const bound = clamp(opts.limit, 1, PLANNER_SEARCH_MAX_LIMIT);
    try {
      const rows = await this.imputables.list(user, { search: opts.search, limit: bound });
      // Projection stricte : aucun e-mail, aucun identifiant de connexion.
      return rows.slice(0, bound).map((a) => ({
        userGroupId: a.userGroupId,
        label: a.label,
        roleName: a.roleName,
        organigrammeLabel: a.organigrammeLabel,
      }));
    } catch (err) {
      this.warn('liste des acteurs', err);
      return [];
    }
  }

  async listInputationTypes(): Promise<PlannerInputationTypeView[]> {
    try {
      const rows = await this.prisma.mailInputationType.findMany({
        where: { isActive: true },
        orderBy: { mailInputationTypeId: 'asc' },
        select: { mailInputationTypeId: true, label: true, suivi: true },
      });
      return rows.map((r) => ({ id: r.mailInputationTypeId, label: r.label, suivi: r.suivi }));
    } catch (err) {
      this.warn('liste des types d’imputation', err);
      return [];
    }
  }

  async canImpute(user: AuthUser): Promise<boolean> {
    if (!hasActor(user)) return false;
    try {
      return this.catalog.canImpute ? await this.catalog.canImpute(user) : await this.imputables.canImpute(user);
    } catch (err) {
      this.warn('droit d’imputer', err);
      return false;
    }
  }

  async resolveImputableActor(user: AuthUser, userGroupId: number): Promise<{ userGroupId: number; label: string } | null> {
    if (!hasActor(user) || !validId(userGroupId)) return null;
    try {
      return await this.catalog.resolveImputableActor(user, userGroupId);
    } catch (err) {
      this.warn('résolution de l’acteur', err);
      return null;
    }
  }

  async getActiveInputationType(typeId: number): Promise<PlannerInputationTypeView | null> {
    if (!validId(typeId)) return null;
    try {
      return await this.catalog.getActiveInputationType(typeId);
    } catch (err) {
      this.warn('lecture du type d’imputation', err);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Imputations
  // -------------------------------------------------------------------------

  async listInputations(user: AuthUser, mailId: number, now: Date, limit: number): Promise<PlannerInputationView[] | null> {
    const all = await this.loadInputations(user, mailId, now);
    return all ? all.slice(0, clamp(limit, 1, INPUTATIONS_MAX)) : null;
  }

  async hasOpenImputation(mailId: number, userGroupId: number, typeId: number): Promise<boolean> {
    try {
      return await this.catalog.hasOpenImputation(mailId, userGroupId, typeId);
    } catch (err) {
      this.warn('recherche d’une imputation ouverte', err);
      return true; // échec fermé : traité comme un doublon
    }
  }

  async readInputation(user: AuthUser, mailId: number, mailInputationId: number, now: Date): Promise<PlannerInputationView | null> {
    const all = await this.loadInputations(user, mailId, now);
    return all?.find((i) => i.mailInputationId === mailInputationId) ?? null;
  }

  async countTargetRelancesToday(mailId: number, recipientUserGroupId: number, now: Date): Promise<number> {
    try {
      const counts = await this.catalog.countRelances(mailId, recipientUserGroupId, null, now);
      return counts.target;
    } catch (err) {
      this.warn('comptage des relances', err);
      return Number.MAX_SAFE_INTEGER; // échec fermé : plafond considéré comme atteint
    }
  }

  /**
   * Imputations d'un courrier LISIBLE, vues de l'utilisateur (même chaîne restreinte que les écrans de suivi :
   * `MailsService.getById`). `null` si le courrier est illisible ou introuvable.
   */
  private async loadInputations(user: AuthUser, mailId: number, now: Date): Promise<PlannerInputationView[] | null> {
    if (!hasActor(user) || !validId(mailId)) return null;
    try {
      const readable = await this.agentData.readMail(user, mailId, 0);
      if (!readable) return null;
      let mail;
      try {
        mail = await this.mails.getById(mailId, user, true);
      } catch (err) {
        if (err instanceof NotFoundException) return null;
        throw err;
      }
      if (!mail) return null;
      const rows = [...mail.inputations].sort((a, b) => a.mailInputationId - b.mailInputationId);
      const actors = await this.actorDirectory(rows.map((i) => i.userId));
      return rows.map((i) => {
        const actor = actors.get(i.userId);
        const deadline = i.deadline instanceof Date ? i.deadline : null;
        const treated = i.dateTreated != null;
        return {
          mailInputationId: i.mailInputationId,
          mailId,
          actorUserGroupId: i.userId,
          actorLabel: actor?.label ?? `Acteur n°${i.userId}`,
          actorActive: actor?.active ?? false,
          typeId: i.mailInputationTypeId,
          typeLabel: i.type?.label ?? '',
          deadline,
          treated,
          late: deadline !== null && !treated && deadline.getTime() < now.getTime(),
          createdBy: i.createdBy ?? null,
        };
      });
    } catch (err) {
      this.warn('lecture des imputations', err);
      return null;
    }
  }

  /** Libellé « Nom — Groupe » (même construction que la liste des acteurs imputables) et état du compte. */
  private async actorDirectory(userGroupIds: number[]): Promise<Map<number, { label: string; active: boolean }>> {
    const ids = [...new Set(userGroupIds)];
    const out = new Map<number, { label: string; active: boolean }>();
    if (ids.length === 0) return out;
    const rows = await this.prisma.appUserGroup.findMany({
      where: { userGroupId: { in: ids } },
      select: {
        userGroupId: true,
        group: { select: { name: true } },
        user: { select: { fullName: true, firstName: true, lastName: true, isDisabled: true } },
      },
    });
    for (const r of rows) {
      const name =
        r.user.fullName?.trim() || `${r.user.firstName ?? ''} ${r.user.lastName ?? ''}`.trim() || `Acteur n°${r.userGroupId}`;
      out.set(r.userGroupId, { label: r.group?.name ? `${name} — ${r.group.name}` : name, active: !r.user.isDisabled });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Rédaction et espaces
  // -------------------------------------------------------------------------

  listDraftTemplates(): PlannerDraftTemplateView[] {
    return DRAFT_TEMPLATES.map((t) => ({ id: t.id, label: t.label }));
  }

  async listWritableSpaces(user: AuthUser, limit: number): Promise<PlannerSpaceView[]> {
    if (!hasActor(user)) return [];
    try {
      const all = await this.spaces.list(user); // espaces ACTIFS visibles
      const out: PlannerSpaceView[] = [];
      for (const s of all) {
        if (out.length >= clamp(limit, 1, PLANNER_SEARCH_MAX_LIMIT)) break;
        // Échec fermé : seuls le propriétaire et les niveaux Contribution/Gestion peuvent déposer.
        const canContribute =
          s.myAccess === 'owner' || (typeof s.myAccess === 'number' && s.myAccess >= GedSpacePermission.Contribution);
        if (s.isActive && canContribute) out.push({ spaceId: s.gedSpaceId, label: s.label });
      }
      return out;
    } catch (err) {
      this.warn('liste des espaces', err);
      return [];
    }
  }

  async generateDraft(
    user: AuthUser,
    request: { templateId: string; instruction: string; mailId?: number },
    _requestedBy: number,
  ): Promise<PlannerDraftResult> {
    if (!hasActor(user)) return { status: 'refused', message: MSG_DRAFT_DENIED };
    try {
      let contextDocumentIds: number[] | undefined;
      if (request.mailId !== undefined) {
        // Contexte = au plus 3 pièces ACCESSIBLES d'un courrier LISIBLE ; sinon refus (jamais de contexte partiel muet).
        const mail = await this.agentData.readMail(user, request.mailId, 0);
        if (!mail) return { status: 'refused', message: MSG_DRAFT_DENIED };
        const ids = mail.documents.slice(0, DRAFT_CONTEXT_DOCUMENTS_MAX).map((d) => d.documentId);
        if (ids.length > 0) contextDocumentIds = ids;
      }
      const res = await this.drafting.generate(
        {
          templateId: request.templateId,
          instruction: request.instruction,
          ...(contextDocumentIds ? { contextDocumentIds } : {}),
        },
        user,
      );
      if (res.disabled) return { status: 'disabled', message: res.message };
      return { status: 'ok', draftHtml: res.draftHtml, decisionId: res.decisionId };
    } catch (err) {
      if (err instanceof HttpException) {
        const status = err.getStatus();
        const message = status === 400 ? MSG_DRAFT_INVALID : status === 403 || status === 404 ? MSG_DRAFT_DENIED : MSG_DRAFT_FAILED;
        return { status: 'refused', message };
      }
      this.warn('génération du brouillon', err);
      return { status: 'refused', message: MSG_DRAFT_FAILED };
    }
  }

  /** Journal sans contenu : nom de l'opération et type d'erreur seulement. */
  private warn(operation: string, err: unknown): void {
    this.logger.warn(`${operation} en échec : ${err instanceof Error ? err.name : 'erreur'}`);
  }
}

function hasActor(user: AuthUser | null | undefined): user is AuthUser {
  return !!user && !user.isScanAgent && user.userGroupId != null;
}

function validId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 1;
}

function clamp(n: number, min: number, max: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
