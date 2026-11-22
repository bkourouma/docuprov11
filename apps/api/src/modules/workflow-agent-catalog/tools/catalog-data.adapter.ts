import { HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DocumentState, wfGraphSchema } from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import { MailSearchService } from '../../courriers/mail-search.service';
import { MailsService } from '../../courriers/mails.service';
import { DocumentsService } from '../../documents/documents.service';
import { DraftingService } from '../../drafting/drafting.service';
import { findDraftTemplate } from '../../drafting/drafting-templates';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AgentBlockedError,
  WF_AGENT_GATE,
  type AgentReservation,
  type AgentUsage,
  type WfAgentGate,
} from '../../workflow-agents/agent.contracts';
import { AgentDataAdapter } from '../../workflow-agents/tools/agent-data.adapter';
import {
  WF_IMPUTABLE_ACTORS,
  declaredDelegatesSchema,
  type DeclaredDelegates,
  type ImputableActorsPort,
} from '../catalog.contracts';
import { countInstanceRelancesToday, countTargetRelancesToday } from '../shared/relance-cap';
import type {
  CatalogDataPort,
  CatalogMailRef,
  DraftGenerationRequest,
  DraftGenerationResult,
  DraftTemplateView,
  ImputableOverview,
  InputationTypeView,
  InputationView,
  PieceFields,
  PieceTarget,
  PieceView,
  RelanceCounts,
  SimilarMail,
} from './catalog-data.port';
import { classifyMetadataLabel, type CompareField } from './piece-fields';
import { isoDay } from './tool-utils';

/** Estimation réservée avant la génération (jetons), réglée à l'identique ensuite (comme la suggestion de rédaction). */
const ESTIMATE_PROMPT_TOKENS = 4000;
const ESTIMATE_COMPLETION_TOKENS = 3000;

/** Courriers candidats lus (avant filtrage par droits) : de quoi en garder `limit` même si beaucoup sont refusés. */
const SIMILAR_CANDIDATE_FACTOR = 3;
const SIMILAR_CANDIDATE_MAX = 30;
const SIMILAR_TERMS_MAX = 8;
const SIMILAR_TERM_MIN_CHARS = 4;
const ACCESS_CONCURRENCY = 5;
const DOSSIER_SCAN_ROWS = 60;
const MS_PER_DAY = 86_400_000;
const INSTANCE_ID_PATTERN = /^[1-9]\d{0,17}$/;

const STOP_WORDS = new Set([
  'dans', 'pour', 'avec', 'sans', 'sous', 'vers', 'chez', 'entre', 'cette', 'votre', 'notre', 'leur', 'leurs',
  'concernant', 'objet', 'suite', 'demande', 'courrier', 'lettre', 'relatif', 'relative', 'madame', 'monsieur',
  'merci', 'bonjour', 'ainsi', 'dont', 'aux', 'des', 'les', 'une', 'sur', 'par', 'que', 'qui',
]);

type DocRow = {
  documentId: number;
  label: string;
  documentDate: Date | null;
  cote: string | null;
  documentType: { label: string } | null;
  versions: Array<{ files: Array<{ pageCount: number | null }> }>;
};

const DOC_SELECT = {
  documentId: true,
  label: true,
  documentDate: true,
  cote: true,
  documentType: { select: { label: true } },
  versions: {
    where: { isCurrent: true },
    take: 1,
    select: { files: { select: { pageCount: true } } },
  },
} as const;

/**
 * Adaptateur de données des outils du catalogue. TOUT passe par l'utilisateur LANCEUR (jamais un
 * administrateur par défaut) ; refus et inexistant donnent la même réponse (`null`, liste vide). Aucun
 * contenu (courrier, pièce, brouillon) n'est journalisé.
 */
@Injectable()
export class CatalogDataAdapter implements CatalogDataPort {
  private readonly logger = new Logger(CatalogDataAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mails: MailsService,
    private readonly mailSearch: MailSearchService,
    private readonly documents: DocumentsService,
    private readonly drafting: DraftingService,
    private readonly agentData: AgentDataAdapter,
    @Inject(WF_IMPUTABLE_ACTORS) private readonly imputables: ImputableActorsPort,
    @Inject(WF_AGENT_GATE) private readonly gate: WfAgentGate,
  ) {}

  // -------------------------------------------------------------------------
  // Courriers
  // -------------------------------------------------------------------------

  async readMail(user: AuthUser, mailId: number): Promise<CatalogMailRef | null> {
    const view = await this.agentData.readMail(user, mailId, 1);
    return view ? { mailId: view.mailId, reference: view.reference, title: view.title } : null;
  }

  async findSimilarMails(user: AuthUser, mailId: number, limit: number): Promise<SimilarMail[] | null> {
    const source = await this.agentData.readMail(user, mailId, 1);
    if (!source) return null;
    const query = buildSimilarityQuery(source.title);
    if (!query) return [];

    const pageSize = Math.min(SIMILAR_CANDIDATE_MAX, Math.max(1, limit * SIMILAR_CANDIDATE_FACTOR));
    const found = await this.mailSearch.search({
      fullText: query,
      page: 1,
      pageSize,
      sort: [{ field: 'date', dir: 'desc' }],
    });

    const out: SimilarMail[] = [];
    for (const row of found.rows) {
      if (out.length >= limit) break;
      if (row.mailId === mailId) continue;
      // Règle de droits du lanceur appliquée à CHAQUE résultat (périmètre, confidentialité, courrier actif).
      const readable = await this.agentData.readMail(user, row.mailId, 1);
      if (!readable) continue;
      const full = await this.loadMailForUser(row.mailId, user);
      if (!full) continue;
      const labels = await this.actorLabels(full.inputations.map((i) => i.userId));
      out.push({
        mailId: readable.mailId,
        reference: readable.reference,
        title: readable.title,
        natureLabel: readable.natureLabel,
        date: readable.date,
        imputations: full.inputations.map((i) => ({
          mailInputationId: i.mailInputationId,
          actorUserGroupId: i.userId,
          actorLabel: labels.get(i.userId) ?? `Acteur ${i.userId}`,
          typeId: i.mailInputationTypeId,
          typeLabel: i.type?.label ?? '',
          delayDays: delayInDays(i.createdAt, i.deadline),
          treated: i.dateTreated != null,
        })),
      });
    }
    return out;
  }

  async readInputation(user: AuthUser, mailId: number, mailInputationId: number): Promise<InputationView | null> {
    const readable = await this.agentData.readMail(user, mailId, 1);
    if (!readable) return null;
    const mail = await this.loadMailForUser(mailId, user);
    if (!mail) return null;
    const inputation = mail.inputations.find((i) => i.mailInputationId === mailInputationId);
    if (!inputation) return null;
    const actor = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId: inputation.userId },
      select: { user: { select: { fullName: true, username: true, isDisabled: true } } },
    });
    return {
      mailInputationId: inputation.mailInputationId,
      mailId: readable.mailId,
      mailReference: readable.reference,
      mailTitle: readable.title,
      userGroupId: inputation.userId,
      actorLabel: actor ? (actor.user.fullName ?? actor.user.username) : `Acteur ${inputation.userId}`,
      actorActive: !!actor && !actor.user.isDisabled,
      typeLabel: inputation.type?.label ?? '',
      deadline: inputation.deadline ?? null,
      dateTreated: inputation.dateTreated ?? null,
      createdBy: inputation.createdBy ?? null,
    };
  }

  async countRelances(
    mailId: number,
    recipientUserGroupId: number,
    instanceId: string | null,
    now: Date,
  ): Promise<RelanceCounts> {
    const target = await countTargetRelancesToday(this.prisma, mailId, recipientUserGroupId, now);
    const instance = instanceId ? await countInstanceRelancesToday(this.prisma, instanceId, now) : 0;
    return { target, instance };
  }

  /** Courrier avec ses imputations VUES du lanceur (chaîne restreinte comme les écrans de suivi). */
  private async loadMailForUser(mailId: number, user: AuthUser) {
    try {
      return await this.mails.getById(mailId, user, true);
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  private async actorLabels(userGroupIds: number[]): Promise<Map<number, string>> {
    const ids = [...new Set(userGroupIds)];
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.appUserGroup.findMany({
      where: { userGroupId: { in: ids } },
      select: { userGroupId: true, user: { select: { fullName: true, username: true } } },
    });
    return new Map(rows.map((r) => [r.userGroupId, r.user.fullName ?? r.user.username]));
  }

  // -------------------------------------------------------------------------
  // Acteurs et types d'imputation
  // -------------------------------------------------------------------------

  async readImputables(user: AuthUser, opts: { search?: string; limit: number }): Promise<ImputableOverview> {
    const types = await this.activeTypes();
    if (!(await this.imputables.canImpute(user))) return { actors: [], types };
    const actors = await this.imputables.list(user, { search: opts.search, limit: opts.limit });
    return {
      // Projection stricte : aucun e-mail, aucun identifiant de connexion.
      actors: actors.slice(0, opts.limit).map((a) => ({
        userGroupId: a.userGroupId,
        label: a.label,
        roleName: a.roleName,
        organigrammeLabel: a.organigrammeLabel,
      })),
      types,
    };
  }

  async canImpute(user: AuthUser): Promise<boolean> {
    if (!hasActor(user)) return false;
    return this.imputables.canImpute(user);
  }

  async resolveImputableActor(user: AuthUser, userGroupId: number): Promise<{ userGroupId: number; label: string } | null> {
    if (!Number.isSafeInteger(userGroupId) || userGroupId < 1) return null;
    if (!(await this.imputables.canImpute(user))) return null;
    if (!(await this.imputables.isImputable(user, userGroupId))) return null;
    return this.resolveActiveActor(userGroupId);
  }

  async resolveActiveActor(userGroupId: number): Promise<{ userGroupId: number; label: string } | null> {
    if (!Number.isSafeInteger(userGroupId) || userGroupId < 1) return null;
    const row = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId },
      select: { user: { select: { fullName: true, username: true, isDisabled: true } } },
    });
    if (!row || row.user.isDisabled) return null;
    return { userGroupId, label: row.user.fullName ?? row.user.username };
  }

  async getActiveInputationType(id: number): Promise<InputationTypeView | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const row = await this.prisma.mailInputationType.findFirst({
      where: { mailInputationTypeId: id, isActive: true },
      select: { mailInputationTypeId: true, label: true, suivi: true },
    });
    return row ? { id: row.mailInputationTypeId, label: row.label, suivi: row.suivi } : null;
  }

  async hasOpenImputation(mailId: number, userGroupId: number, typeId: number): Promise<boolean> {
    const n = await this.prisma.mailInputation.count({
      where: { mailId, userId: userGroupId, mailInputationTypeId: typeId, dateTreated: null },
    });
    return n > 0;
  }

  private async activeTypes(): Promise<InputationTypeView[]> {
    const rows = await this.prisma.mailInputationType.findMany({
      where: { isActive: true },
      orderBy: { mailInputationTypeId: 'asc' },
      select: { mailInputationTypeId: true, label: true, suivi: true },
    });
    return rows.map((r) => ({ id: r.mailInputationTypeId, label: r.label, suivi: r.suivi }));
  }

  // -------------------------------------------------------------------------
  // Pièces
  // -------------------------------------------------------------------------

  async listPieces(user: AuthUser, target: PieceTarget, limit: number): Promise<PieceView[] | null> {
    if (!hasActor(user)) return null;
    let ids: number[];
    if ('mailId' in target) {
      // `readMail` ne renvoie déjà que les pièces accessibles (canAccess) du courrier lisible.
      const mail = await this.agentData.readMail(user, target.mailId, 1);
      if (!mail) return null;
      ids = mail.documents.map((d) => d.documentId);
    } else if ('documentId' in target) {
      if (!(await this.documents.canAccess(target.documentId, user))) return null;
      ids = await this.linkedDocumentIds(target.documentId, user, limit);
    } else {
      ids = await this.accessibleDossierDocuments(target.dossierId, user, limit);
      if (ids.length === 0) return null;
    }
    const rows = await this.loadDocs(ids.slice(0, limit));
    const meta = await this.metadataFields(rows.map((r) => r.documentId));
    return rows.map((r) => ({
      documentId: r.documentId,
      label: r.label,
      documentTypeLabel: r.documentType?.label ?? null,
      documentDate: isoDay(r.documentDate),
      cote: r.cote,
      pageCount: pageCountOf(r),
      metadataExcerpt: excerptOf(meta.get(r.documentId), r.documentDate),
    }));
  }

  async readPieceFields(user: AuthUser, documentIds: number[]): Promise<PieceFields[]> {
    if (!hasActor(user)) return [];
    const unique = [...new Set(documentIds)].filter((id) => Number.isSafeInteger(id) && id >= 1);
    const verdicts = await mapLimited(unique, ACCESS_CONCURRENCY, (id) => this.documents.canAccess(id, user));
    const allowed = unique.filter((_, i) => verdicts[i] === true);
    if (allowed.length === 0) return [];
    const rows = await this.loadDocs(allowed);
    const meta = await this.metadataFields(rows.map((r) => r.documentId));
    return rows.map((r) => {
      const values: PieceFields['values'] = { ...(meta.get(r.documentId) ?? {}) };
      const date = isoDay(r.documentDate);
      if (!values.date && date) values.date = { raw: date, evidence: `Date du document : ${date}` };
      return { documentId: r.documentId, label: r.label, values };
    });
  }

  /** Documents partageant un courrier avec `documentId`, filtrés par `canAccess`. */
  private async linkedDocumentIds(documentId: number, user: AuthUser, limit: number): Promise<number[]> {
    const mailLinks = await this.prisma.mailDocument.findMany({
      where: { documentId },
      select: { mailId: true },
      take: 50,
    });
    if (mailLinks.length === 0) return [];
    const siblings = await this.prisma.mailDocument.findMany({
      where: { mailId: { in: mailLinks.map((m) => m.mailId) }, documentId: { not: documentId } },
      select: { documentId: true },
      orderBy: { documentId: 'asc' },
      take: DOSSIER_SCAN_ROWS,
    });
    const candidates = [...new Set(siblings.map((s) => s.documentId))];
    return this.filterAccessible(candidates, user, limit);
  }

  private async accessibleDossierDocuments(dossierId: number, user: AuthUser, limit: number): Promise<number[]> {
    const candidates = await this.prisma.document.findMany({
      where: { dossierId, documentState: { not: DocumentState.Epure } },
      select: { documentId: true },
      orderBy: [{ documentDate: { sort: 'asc', nulls: 'last' } }, { documentId: 'asc' }],
      take: DOSSIER_SCAN_ROWS,
    });
    return this.filterAccessible(
      candidates.map((c) => c.documentId),
      user,
      limit,
    );
  }

  private async filterAccessible(candidates: number[], user: AuthUser, limit: number): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < candidates.length && out.length < limit; i += ACCESS_CONCURRENCY) {
      const slice = candidates.slice(i, i + ACCESS_CONCURRENCY);
      const verdicts = await Promise.all(slice.map((id) => this.documents.canAccess(id, user)));
      slice.forEach((id, k) => {
        if (verdicts[k] === true && out.length < limit) out.push(id);
      });
    }
    return out;
  }

  /** Documents (hors épurés), dans l'ordre demandé. */
  private async loadDocs(ids: number[]): Promise<DocRow[]> {
    if (ids.length === 0) return [];
    const rows = (await this.prisma.document.findMany({
      where: { documentId: { in: ids }, documentState: { not: DocumentState.Epure } },
      select: DOC_SELECT,
    })) as DocRow[];
    const byId = new Map(rows.map((r) => [r.documentId, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      return r ? [r] : [];
    });
  }

  /** Valeurs de métadonnées classées par champ comparable (premier libellé reconnu par champ). */
  private async metadataFields(documentIds: number[]): Promise<Map<number, PieceFields['values']>> {
    const out = new Map<number, PieceFields['values']>();
    if (documentIds.length === 0) return out;
    const rows = await this.prisma.documentMetadataValue.findMany({
      where: { documentId: { in: documentIds }, metaData: { isActive: true } },
      orderBy: { metaDataId: 'asc' },
      select: {
        documentId: true,
        value: true,
        metaData: { select: { label: true } },
        metaDataListItem: { select: { label: true } },
      },
    });
    for (const r of rows) {
      const raw = (r.value ?? r.metaDataListItem?.label ?? '').trim();
      if (!raw) continue;
      const field: CompareField | null = classifyMetadataLabel(r.metaData.label);
      if (!field) continue;
      const values = out.get(r.documentId) ?? {};
      if (!values[field]) values[field] = { raw, evidence: `${r.metaData.label} : ${raw}` };
      out.set(r.documentId, values);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Délégataires déclarés
  // -------------------------------------------------------------------------

  async readDeclaredDelegates(instanceId: string, stepKey: string): Promise<DeclaredDelegates> {
    if (!INSTANCE_ID_PATTERN.test(instanceId)) return [];
    const instance = await this.prisma.wfInstance.findUnique({
      where: { wfInstanceId: BigInt(instanceId) },
      select: { definitionVersion: { select: { graph: true } } },
    });
    if (!instance) return [];
    const graph = wfGraphSchema.safeParse(instance.definitionVersion.graph);
    if (!graph.success) return [];
    const step = graph.data.steps.find((s) => s.key === stepKey);
    const raw = step?.config?.delegates;
    if (raw === undefined) return [];
    const parsed = declaredDelegatesSchema.safeParse(raw);
    return parsed.success ? parsed.data : []; // invalide ou absent : aucun délégataire
  }

  // -------------------------------------------------------------------------
  // Rédaction
  // -------------------------------------------------------------------------

  async getDraftTemplate(templateId: string): Promise<DraftTemplateView | null> {
    const t = findDraftTemplate(templateId);
    return t ? { id: t.id, label: t.label, skeletonHtml: t.skeletonHtml } : null;
  }

  async generateDraft(
    user: AuthUser,
    request: DraftGenerationRequest,
    instanceId: string | null,
  ): Promise<DraftGenerationResult> {
    const definitionId = await this.definitionIdOf(instanceId);
    if (definitionId === null) {
      return { status: 'refused', message: 'Définition du workflow inconnue : brouillon impossible.' };
    }
    const scope = { definitionId };

    // Garde puis réservation (même schéma que la suggestion de rédaction).
    let reservation: AgentReservation;
    const estimate: AgentUsage = {
      promptTokens: ESTIMATE_PROMPT_TOKENS,
      completionTokens: ESTIMATE_COMPLETION_TOKENS,
      cost: this.gate.costOf({ promptTokens: ESTIMATE_PROMPT_TOKENS, completionTokens: ESTIMATE_COMPLETION_TOKENS }),
    };
    try {
      await this.gate.assertRunnable(scope);
      reservation = await this.gate.reserve(scope, estimate);
    } catch (err) {
      if (err instanceof AgentBlockedError) {
        return err.reason === 'ai_disabled'
          ? { status: 'disabled', message: err.message }
          : { status: 'refused', message: err.message };
      }
      throw err;
    }

    let res;
    try {
      res = await this.drafting.generate(request, user);
    } catch (err) {
      await this.releaseQuietly(reservation);
      // Erreurs HTTP de la rédaction : messages en français sans contenu (modèle, document, IA indisponible).
      if (err instanceof HttpException) {
        return { status: 'refused', message: httpMessage(err) };
      }
      throw err;
    }
    if (res.disabled) {
      await this.releaseQuietly(reservation);
      return { status: 'disabled', message: res.message };
    }
    try {
      await this.gate.settle(reservation, estimate);
    } catch (err) {
      // Le brouillon est produit ; un échec de règlement ne doit pas le perdre (journal sans contenu).
      this.logger.warn(`règlement du budget en échec : ${err instanceof Error ? err.name : 'erreur'}`);
    }
    return {
      status: 'ok',
      draftHtml: res.draftHtml,
      decisionId: res.decisionId,
      contextDocumentCount: res.contextDocumentCount,
    };
  }

  private async definitionIdOf(instanceId: string | null): Promise<number | null> {
    if (!instanceId || !INSTANCE_ID_PATTERN.test(instanceId)) return null;
    const row = await this.prisma.wfInstance.findUnique({
      where: { wfInstanceId: BigInt(instanceId) },
      select: { definitionId: true },
    });
    const id = row?.definitionId;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
  }

  private async releaseQuietly(reservation: AgentReservation): Promise<void> {
    try {
      await this.gate.release(reservation);
    } catch (err) {
      this.logger.warn(`libération de la réservation en échec : ${err instanceof Error ? err.name : 'erreur'}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------

function hasActor(user: AuthUser | null | undefined): user is AuthUser {
  return !!user && !user.isScanAgent && user.userGroupId != null;
}

/** Requête plein texte (`websearch_to_tsquery`) : mots significatifs de l'objet, reliés par « or ». */
export function buildSimilarityQuery(title: string | null): string | null {
  if (!title) return null;
  const words = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= SIMILAR_TERM_MIN_CHARS && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  const unique = [...new Set(words)].slice(0, SIMILAR_TERMS_MAX);
  return unique.length > 0 ? unique.join(' or ') : null;
}

/** Délai en jours calendaires entre la création et l'échéance (arrondi au jour supérieur), `null` sans échéance. */
export function delayInDays(createdAt: Date | null, deadline: Date | null): number | null {
  if (!(deadline instanceof Date) || !(createdAt instanceof Date)) return null;
  const diff = deadline.getTime() - createdAt.getTime();
  if (!Number.isFinite(diff)) return null;
  return Math.max(0, Math.ceil(diff / MS_PER_DAY));
}

function pageCountOf(row: DocRow): number | null {
  const counts = (row.versions[0]?.files ?? []).map((f) => f.pageCount).filter((n): n is number => typeof n === 'number');
  return counts.length > 0 ? Math.max(...counts) : null;
}

function excerptOf(values: PieceFields['values'] | undefined, date: Date | null): string | null {
  const parts: string[] = [];
  if (values?.montant) parts.push(`montant : ${values.montant.raw}`);
  const d = values?.date?.raw ?? isoDay(date);
  if (d) parts.push(`date : ${d}`);
  if (values?.objet) parts.push(`objet : ${values.objet.raw}`);
  return parts.length > 0 ? parts.join(' ; ') : null;
}

function httpMessage(err: HttpException): string {
  const response = err.getResponse();
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'message' in response) {
    const m = (response as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m) && typeof m[0] === 'string') return m[0];
  }
  return 'Génération du brouillon impossible.';
}

/** `Promise.all` par lots de `limit` : ordre des résultats conservé. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}
