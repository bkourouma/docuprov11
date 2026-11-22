import { z } from 'zod';
import type {
  WfAgentSource,
  WfPreparedAction,
  WfTool,
  WfToolContext,
  WfToolRegistryPort,
  WfToolResult,
} from '../../workflow-agents/agent.contracts';
import { RELANCE_MESSAGE_PREFIX } from '../shared/relance-cap';
import {
  CATALOG_TOOL_KEYS,
  DRAFT_HTML_MAX_CHARS,
  IMPUTATION_DELAY_DAYS_MAX,
  IMPUTATION_INSTRUCTIONS_MAX,
  IMPUTATION_RECIPIENTS_MAX,
  RELANCE_MAX_PER_INSTANCE_PER_DAY,
  RELANCE_MAX_PER_TARGET_PER_DAY,
  RELANCE_MESSAGE_MAX,
  brouillonReponseArgsSchema,
  declaredDelegatesSchema,
  delegationArgsSchema,
  imputationCourrierArgsSchema,
  relanceArgsSchema,
} from '../catalog.contracts';
import type { CatalogDataPort } from './catalog-data.port';
import { COMPARE_FIELDS, normalizeField, type CompareField } from './piece-fields';
import {
  DOCUMENT_NOT_FOUND_MESSAGE,
  DRAFT_EXCERPT_MAX,
  INPUTATION_NOT_FOUND_MESSAGE,
  LABEL_MAX,
  MAIL_NOT_FOUND_MESSAGE,
  PIECES_NOT_FOUND_MESSAGE,
  SOURCE_EXCERPT_MAX,
  cut,
  cutOrEmpty,
  documentSource,
  htmlToPlainText,
  isoDay,
  mailSource,
} from './tool-utils';

const idSchema = z.number().int().positive().max(2_147_483_647);

const SIMILAR_DEFAULT_LIMIT = 5;
const SIMILAR_MAX_LIMIT = 10;
const ORGANIGRAMME_DEFAULT_LIMIT = 20;
const ORGANIGRAMME_MAX_LIMIT = 50;
const PIECES_MAX = 30;
const COMPARE_MIN_DOCS = 2;
const COMPARE_MAX_DOCS = 6;
const DRAFT_CONTEXT_MAX_DOCS = 5;
const DRAFT_INSTRUCTION_MIN = 3;
const DRAFT_INSTRUCTION_MAX = 2000;
/** Mémoire bornée des relances déjà préparées dans un run (clé : instance + tâche). */
const RUN_MEMORY_MAX_ENTRIES = 500;

export interface CatalogToolsOptions {
  /** Horloge injectable (tests). */
  now?: () => Date;
}

const refuse = (message: string, sources: WfAgentSource[] = []): WfToolResult => ({
  output: { prepared: false, message },
  sources,
});

// ---------------------------------------------------------------------------
// 1. lister_courriers_similaires (effet 0)
// ---------------------------------------------------------------------------
const similarSchema = z
  .object({ mailId: idSchema, limit: z.number().int().min(1).max(SIMILAR_MAX_LIMIT).optional() })
  .strict();

function similarMailsTool(data: CatalogDataPort): WfTool<z.infer<typeof similarSchema>> {
  return {
    key: CATALOG_TOOL_KEYS.listerCourriersSimilaires,
    label: 'Lister les courriers similaires',
    description:
      'Cherche dans l’historique archivé les courriers semblables à un courrier lisible par le lanceur et renvoie, pour chacun, son objet, sa nature, sa date et ses imputations (acteur, type, délai, traité). Seuls les courriers que le lanceur peut lire sont renvoyés.',
    sideEffect: 0,
    requiresValidation: false,
    inputSchema: similarSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mailId'],
      properties: {
        mailId: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: SIMILAR_MAX_LIMIT, default: SIMILAR_DEFAULT_LIMIT },
      },
    },
    async execute(ctx: WfToolContext, input): Promise<WfToolResult> {
      const limit = input.limit ?? SIMILAR_DEFAULT_LIMIT;
      const base = await data.readMail(ctx.identity.user, input.mailId);
      if (!base) return { output: { found: false, message: MAIL_NOT_FOUND_MESSAGE }, sources: [] };
      const found = await data.findSimilarMails(ctx.identity.user, input.mailId, limit);
      if (!found) return { output: { found: false, message: MAIL_NOT_FOUND_MESSAGE }, sources: [] };
      const mails = found.slice(0, limit);
      return {
        output: {
          found: true,
          mails: mails.map((m) => ({
            mailId: m.mailId,
            reference: cut(m.reference, LABEL_MAX) ?? null,
            objet: cutOrEmpty(m.title, LABEL_MAX),
            nature: cut(m.natureLabel, LABEL_MAX) ?? null,
            date: m.date,
            imputations: m.imputations.slice(0, 20).map((i) => ({
              acteurId: i.actorUserGroupId,
              acteur: cutOrEmpty(i.actorLabel, LABEL_MAX),
              typeImputation: { id: i.typeId, libelle: cutOrEmpty(i.typeLabel, LABEL_MAX) },
              delaiJours: i.delayDays,
              traitee: i.treated,
            })),
          })),
        },
        sources: [
          mailSource(base.mailId, base.reference, base.title),
          ...mails.map((m) => mailSource(m.mailId, m.reference, m.title)),
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 2. lire_organigramme_imputable (effet 0)
// ---------------------------------------------------------------------------
const organigrammeSchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(ORGANIGRAMME_MAX_LIMIT).optional(),
  })
  .strict();

function organigrammeTool(data: CatalogDataPort): WfTool<z.infer<typeof organigrammeSchema>> {
  return {
    key: CATALOG_TOOL_KEYS.lireOrganigrammeImputable,
    label: 'Lire les acteurs imputables',
    description:
      'Liste les acteurs que le lanceur peut imputer (identifiant, libellé, rôle, nœud d’organigramme), les types d’imputation actifs et la borne de délai. Aucun e-mail ni identifiant de connexion.',
    sideEffect: 0,
    requiresValidation: false,
    inputSchema: organigrammeSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        search: { type: 'string', minLength: 1, maxLength: 100 },
        limit: { type: 'integer', minimum: 1, maximum: ORGANIGRAMME_MAX_LIMIT, default: ORGANIGRAMME_DEFAULT_LIMIT },
      },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const limit = input.limit ?? ORGANIGRAMME_DEFAULT_LIMIT;
      const view = await data.readImputables(ctx.identity.user, { search: input.search, limit });
      return {
        output: {
          acteurs: view.actors.slice(0, limit).map((a) => ({
            userGroupId: a.userGroupId,
            libelle: cutOrEmpty(a.label, LABEL_MAX),
            role: cut(a.roleName, LABEL_MAX) ?? null,
            noeudOrganigramme: cut(a.organigrammeLabel, LABEL_MAX) ?? null,
          })),
          typesImputation: view.types.slice(0, 50).map((t) => ({
            id: t.id,
            libelle: cutOrEmpty(t.label, LABEL_MAX),
            suivi: t.suivi,
          })),
          delaiMaxJours: IMPUTATION_DELAY_DAYS_MAX,
        },
        sources: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 3. lister_pieces (effet 0)
// ---------------------------------------------------------------------------
const piecesSchema = z
  .object({ mailId: idSchema.optional(), documentId: idSchema.optional(), dossierId: idSchema.optional() })
  .strict()
  .refine((v) => [v.mailId, v.documentId, v.dossierId].filter((x) => x !== undefined).length === 1, {
    message: 'Indiquez exactement un des paramètres mailId, documentId ou dossierId.',
  });

function piecesTool(data: CatalogDataPort): WfTool<z.infer<typeof piecesSchema>> {
  return {
    key: CATALOG_TOOL_KEYS.listerPieces,
    label: 'Lister les pièces',
    description:
      'Liste les pièces (documents) d’un courrier, d’un dossier ou liées à un document, limitées à celles que le lanceur peut ouvrir : libellé, type, date, cote, pages, extrait des métadonnées. Aucun contenu binaire. Indiquer exactement un identifiant.',
    sideEffect: 0,
    requiresValidation: false,
    inputSchema: piecesSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      description: 'Exactement un des trois identifiants.',
      properties: {
        mailId: { type: 'integer', minimum: 1 },
        documentId: { type: 'integer', minimum: 1 },
        dossierId: { type: 'integer', minimum: 1 },
      },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const target =
        input.mailId !== undefined
          ? { mailId: input.mailId }
          : input.documentId !== undefined
            ? { documentId: input.documentId }
            : { dossierId: input.dossierId as number };
      const pieces = await data.listPieces(ctx.identity.user, target, PIECES_MAX);
      if (!pieces) return { output: { found: false, message: PIECES_NOT_FOUND_MESSAGE }, sources: [] };
      const bounded = pieces.slice(0, PIECES_MAX);
      return {
        output: {
          found: true,
          pieces: bounded.map((p) => ({
            documentId: p.documentId,
            libelle: cutOrEmpty(p.label, LABEL_MAX),
            typeDocument: cut(p.documentTypeLabel, LABEL_MAX) ?? null,
            date: p.documentDate,
            cote: cut(p.cote, 50) ?? null,
            pages: p.pageCount,
            extrait: cut(p.metadataExcerpt, SOURCE_EXCERPT_MAX) ?? null,
          })),
        },
        sources: bounded.map((p) => documentSource(p.documentId, p.label, p.metadataExcerpt)),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 4. comparer_champs (effet 0) : le drapeau `discordant` est calculé EN CODE
// ---------------------------------------------------------------------------
const compareSchema = z
  .object({
    documentIds: z
      .array(idSchema)
      .min(COMPARE_MIN_DOCS)
      .max(COMPARE_MAX_DOCS)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Identifiants de documents en double.' }),
    fields: z
      .array(z.enum(COMPARE_FIELDS))
      .min(1)
      .max(COMPARE_FIELDS.length)
      .refine((f) => new Set(f).size === f.length, { message: 'Champs en double.' }),
  })
  .strict();

function compareTool(data: CatalogDataPort): WfTool<z.infer<typeof compareSchema>> {
  return {
    key: CATALOG_TOOL_KEYS.comparerChamps,
    label: 'Comparer des champs entre pièces',
    description:
      'Compare des champs (montant, date, reference, objet, tiers) entre 2 à 6 pièces accessibles au lanceur. Chaque valeur est accompagnée d’un extrait comme preuve ; l’indicateur « discordant » est calculé par l’application (montants à 2 décimales, dates ISO, références normalisées). Une pièce inaccessible est omise.',
    sideEffect: 0,
    requiresValidation: false,
    inputSchema: compareSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['documentIds', 'fields'],
      properties: {
        documentIds: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          minItems: COMPARE_MIN_DOCS,
          maxItems: COMPARE_MAX_DOCS,
          uniqueItems: true,
        },
        fields: {
          type: 'array',
          items: { type: 'string', enum: [...COMPARE_FIELDS] },
          minItems: 1,
          maxItems: COMPARE_FIELDS.length,
          uniqueItems: true,
        },
      },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const read = await data.readPieceFields(ctx.identity.user, input.documentIds);
      // Seules les pièces demandées ET renvoyées (donc accessibles) comptent ; ordre de la demande conservé.
      const byId = new Map(read.map((p) => [p.documentId, p]));
      const pieces = input.documentIds.flatMap((id) => {
        const p = byId.get(id);
        return p ? [p] : [];
      });
      if (pieces.length === 0) {
        return { output: { found: false, message: DOCUMENT_NOT_FOUND_MESSAGE }, sources: [] };
      }

      const comparisons = input.fields.map((field: CompareField) => {
        const values = pieces.flatMap((p) => {
          const v = p.values[field];
          if (!v || v.raw.trim() === '') return [];
          return [
            {
              documentId: p.documentId,
              valeur: cutOrEmpty(v.raw, LABEL_MAX),
              normalisee: cutOrEmpty(normalizeField(field, v.raw), LABEL_MAX),
              preuve: cutOrEmpty(v.evidence, SOURCE_EXCERPT_MAX),
            },
          ];
        });
        const distinct = new Set(values.map((v) => v.normalisee));
        const statut = values.length < 2 ? 'insuffisant' : distinct.size > 1 ? 'discordant' : 'concordant';
        const withValue = new Set(values.map((v) => v.documentId));
        return {
          champ: field,
          valeurs: values,
          sansValeur: pieces.map((p) => p.documentId).filter((id) => !withValue.has(id)),
          statut,
          discordant: statut === 'discordant',
        };
      });

      return {
        output: { found: true, pieces: pieces.map((p) => p.documentId), comparaisons: comparisons },
        sources: pieces.map((p) => {
          const firstEvidence = input.fields.map((f) => p.values[f]?.evidence).find((e) => !!e);
          return documentSource(p.documentId, p.label, firstEvidence);
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 5. proposer_imputation_courrier (effet 1, validation) : n'écrit RIEN
// ---------------------------------------------------------------------------
function proposeImputationTool(data: CatalogDataPort): WfTool<z.infer<typeof imputationCourrierArgsSchema>> {
  return {
    key: CATALOG_TOOL_KEYS.proposerImputationCourrier,
    label: 'Proposer une imputation de courrier',
    description:
      'Prépare l’imputation d’un courrier à un ou plusieurs acteurs (type du référentiel, délai en jours, instructions). Les destinataires doivent exister, être actifs et imputables par le lanceur ; sinon la proposition est rejetée. N’écrit rien : un humain valide.',
    sideEffect: 1,
    requiresValidation: true,
    inputSchema: imputationCourrierArgsSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mailId', 'recipients', 'rationale'],
      properties: {
        mailId: { type: 'integer', minimum: 1 },
        recipients: {
          type: 'array',
          minItems: 1,
          maxItems: IMPUTATION_RECIPIENTS_MAX,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['userGroupId', 'mailInputationTypeId'],
            properties: {
              userGroupId: { type: 'integer', minimum: 1 },
              mailInputationTypeId: { type: 'integer', minimum: 1 },
              instructions: { type: 'string', minLength: 1, maxLength: IMPUTATION_INSTRUCTIONS_MAX },
              delayDays: { type: 'integer', minimum: 1, maximum: IMPUTATION_DELAY_DAYS_MAX },
            },
          },
        },
        rationale: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const user = ctx.identity.user;
      const mail = await data.readMail(user, input.mailId);
      if (!mail) return refuse(MAIL_NOT_FOUND_MESSAGE);
      const sources = [mailSource(mail.mailId, mail.reference, mail.title)];

      const seenActors = new Set<number>();
      const parts: string[] = [];
      for (const r of input.recipients) {
        if (seenActors.has(r.userGroupId)) {
          return refuse(
            `Destinataire en double (acteur n° ${r.userGroupId}) : proposition rejetée, aucune imputation préparée.`,
            sources,
          );
        }
        seenActors.add(r.userGroupId);

        const actor = await data.resolveImputableActor(user, r.userGroupId);
        if (!actor) {
          return refuse(
            `L’acteur n° ${r.userGroupId} n’existe pas, est inactif ou n’est pas imputable par le lanceur : proposition rejetée, aucune imputation préparée.`,
            sources,
          );
        }
        const type = await data.getActiveInputationType(r.mailInputationTypeId);
        if (!type) {
          return refuse(
            `Le type d’imputation n° ${r.mailInputationTypeId} n’existe pas ou est inactif : proposition rejetée, aucune imputation préparée.`,
            sources,
          );
        }
        if (await data.hasOpenImputation(input.mailId, r.userGroupId, r.mailInputationTypeId)) {
          return refuse(
            `Le courrier est déjà imputé à l’acteur n° ${r.userGroupId} avec ce type (imputation non traitée) : proposition rejetée.`,
            sources,
          );
        }
        const delay = r.delayDays !== undefined ? `, délai ${r.delayDays} jour${r.delayDays > 1 ? 's' : ''}` : '';
        parts.push(`à ${cutOrEmpty(actor.label, 100)} (${cutOrEmpty(type.label, 100)}${delay})`);
      }

      const args = {
        mailId: input.mailId,
        recipients: input.recipients.map((r) => ({ ...r })),
        rationale: input.rationale,
      };
      const prepared: WfPreparedAction = {
        tool: CATALOG_TOOL_KEYS.proposerImputationCourrier,
        arguments: args,
        sideEffect: 1,
        requiresValidation: true,
        preview: `Imputer le courrier n° ${input.mailId} ${parts.join(' ; ')}. Motif : ${input.rationale}`,
      };
      return { output: { prepared: true, destinataires: parts.length }, sources, prepared };
    },
  };
}

// ---------------------------------------------------------------------------
// 6. preparer_brouillon_reponse (effet 1, validation) : génère, n'écrit ni n'envoie RIEN
// ---------------------------------------------------------------------------
const draftSchema = z
  .object({
    templateId: z.string().min(1).max(100),
    instruction: z.string().trim().min(DRAFT_INSTRUCTION_MIN).max(DRAFT_INSTRUCTION_MAX),
    mailId: idSchema.optional(),
    contextDocumentIds: z.array(idSchema).max(DRAFT_CONTEXT_MAX_DOCS).optional(),
    dossierId: idSchema.optional(),
    label: z.string().trim().min(1).max(200),
    spaceId: idSchema.optional(),
  })
  .strict();

function draftTool(data: CatalogDataPort): WfTool<z.infer<typeof draftSchema>> {
  return {
    key: CATALOG_TOOL_KEYS.preparerBrouillonReponse,
    label: 'Préparer un brouillon de réponse',
    description:
      'Génère, avec les droits du lanceur, un brouillon de réponse à partir d’un des modèles de rédaction. Le brouillon est une proposition à relire : rien n’est enregistré ni envoyé avant la validation d’un humain. Ne renvoie qu’un extrait court.',
    sideEffect: 1,
    requiresValidation: true,
    inputSchema: draftSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['templateId', 'instruction', 'label'],
      properties: {
        templateId: { type: 'string', minLength: 1, maxLength: 100 },
        instruction: { type: 'string', minLength: DRAFT_INSTRUCTION_MIN, maxLength: DRAFT_INSTRUCTION_MAX },
        mailId: { type: 'integer', minimum: 1 },
        contextDocumentIds: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          maxItems: DRAFT_CONTEXT_MAX_DOCS,
        },
        dossierId: { type: 'integer', minimum: 1 },
        label: { type: 'string', minLength: 1, maxLength: 200 },
        spaceId: { type: 'integer', minimum: 1 },
      },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const user = ctx.identity.user;
      const template = await data.getDraftTemplate(input.templateId);
      if (!template) return refuse(`Modèle de rédaction inconnu : « ${cutOrEmpty(input.templateId, 60)} ».`);

      const sources: WfAgentSource[] = [];
      if (input.mailId !== undefined) {
        const mail = await data.readMail(user, input.mailId);
        if (!mail) return refuse(MAIL_NOT_FOUND_MESSAGE);
        sources.push(mailSource(mail.mailId, mail.reference, mail.title));
      }

      let draftHtml: string;
      let decisionId: string | null = null;
      if (ctx.dryRun) {
        // Évaluation : aucun appel IA, aucun coût ; squelette statique du modèle.
        draftHtml = template.skeletonHtml;
      } else {
        const res = await data.generateDraft(
          user,
          {
            templateId: template.id,
            instruction: input.instruction,
            ...(input.contextDocumentIds?.length ? { contextDocumentIds: input.contextDocumentIds } : {}),
            ...(input.dossierId !== undefined ? { dossierId: input.dossierId } : {}),
          },
          ctx.instanceId,
        );
        if (res.status !== 'ok') return refuse(res.message, sources);
        draftHtml = res.draftHtml;
        decisionId = res.decisionId;
        for (const id of input.contextDocumentIds ?? []) sources.push(documentSource(id, null));
      }

      if (draftHtml.length > DRAFT_HTML_MAX_CHARS) {
        return refuse(
          `Le brouillon dépasse la taille autorisée (${DRAFT_HTML_MAX_CHARS} caractères) : il est refusé, aucun brouillon préparé.`,
          sources,
        );
      }
      const candidate: Record<string, unknown> = {
        templateId: template.id,
        label: input.label,
        draftHtml,
      };
      if (input.mailId !== undefined) candidate.mailId = input.mailId;
      if (input.spaceId !== undefined) candidate.spaceId = input.spaceId;
      if (decisionId && /^\d{1,18}$/.test(decisionId)) candidate.decisionId = decisionId;
      const parsed = brouillonReponseArgsSchema.safeParse(candidate);
      if (!parsed.success) return refuse('Le brouillon obtenu est invalide : aucun brouillon préparé.', sources);

      const lien = input.mailId !== undefined ? ` au courrier n° ${input.mailId}` : '';
      const origine = ctx.dryRun ? 'squelette du modèle (évaluation)' : 'brouillon généré par l’IA, à relire';
      const prepared: WfPreparedAction = {
        tool: CATALOG_TOOL_KEYS.preparerBrouillonReponse,
        arguments: { ...parsed.data },
        sideEffect: 1,
        requiresValidation: true,
        preview: `Créer le document « ${cutOrEmpty(input.label, 100)} » (modèle ${cutOrEmpty(template.label, 100)}) en réponse${lien} : ${origine}.`,
      };
      return {
        output: {
          prepared: true,
          modele: template.id,
          libelle: cutOrEmpty(input.label, LABEL_MAX),
          extrait: cutOrEmpty(htmlToPlainText(draftHtml), DRAFT_EXCERPT_MAX),
        },
        sources,
        prepared,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 7. proposer_relance (effet 1, validation) : n'envoie RIEN, jamais d'e-mail
// ---------------------------------------------------------------------------
const relanceInputSchema = z
  .object({
    mailId: idSchema,
    mailInputationId: idSchema,
    message: z.string().trim().min(1).max(RELANCE_MESSAGE_MAX),
    escalateToUserGroupId: idSchema.optional(),
  })
  .strict();

/** Mémoire bornée des relances préparées par run (instance + tâche) : plafond d'instance « hors base ». */
class RunMemory {
  private readonly map = new Map<string, Set<number>>();

  get(key: string): Set<number> {
    return this.map.get(key) ?? new Set<number>();
  }

  add(key: string, mailInputationId: number): void {
    let set = this.map.get(key);
    if (!set) {
      if (this.map.size >= RUN_MEMORY_MAX_ENTRIES) {
        const oldest = this.map.keys().next();
        if (!oldest.done) this.map.delete(oldest.value);
      }
      set = new Set<number>();
      this.map.set(key, set);
    }
    set.add(mailInputationId);
  }
}

function relanceTool(
  data: CatalogDataPort,
  now: () => Date,
  memory: RunMemory,
): WfTool<z.infer<typeof relanceInputSchema>> {
  return {
    key: CATALOG_TOOL_KEYS.proposerRelance,
    label: 'Proposer une relance',
    description: `Prépare une relance INTERNE (notification, jamais d’e-mail) à l’imputé en retard d’un courrier. Refusée si l’imputation est traitée ou pas en retard, ou si un plafond journalier est atteint. L’escalade n’est possible que vers l’auteur de l’imputation. Le message est préfixé par l’application (« ${RELANCE_MESSAGE_PREFIX.trim()} »).`,
    sideEffect: 1,
    requiresValidation: true,
    inputSchema: relanceInputSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mailId', 'mailInputationId', 'message'],
      properties: {
        mailId: { type: 'integer', minimum: 1 },
        mailInputationId: { type: 'integer', minimum: 1 },
        message: { type: 'string', minLength: 1, maxLength: RELANCE_MESSAGE_MAX },
        escalateToUserGroupId: { type: 'integer', minimum: 1 },
      },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const inputation = await data.readInputation(ctx.identity.user, input.mailId, input.mailInputationId);
      if (!inputation) return refuse(INPUTATION_NOT_FOUND_MESSAGE);
      const sources = [mailSource(inputation.mailId, inputation.mailReference, inputation.mailTitle)];

      // Droit de relancer : droit d'imputation du lanceur (menus ou administrateur) OU auteur de l'imputation ; jamais plus.
      const user = ctx.identity.user;
      const isAuthor = inputation.createdBy !== null && inputation.createdBy === user.userGroupId;
      // Port sans `canImpute` : échec fermé (seul l'auteur peut relancer).
      if (!isAuthor && !((await data.canImpute?.(user)) ?? false)) {
        return refuse(
          'Le lanceur n’a ni le droit d’imputer ni la qualité d’auteur de cette imputation : relance refusée.',
          sources,
        );
      }
      if (inputation.dateTreated) return refuse('L’imputation est déjà traitée : relance refusée.', sources);
      const at = now();
      if (!inputation.deadline) {
        return refuse('L’imputation n’a pas d’échéance : elle n’est pas en retard, relance refusée.', sources);
      }
      if (inputation.deadline.getTime() >= at.getTime()) {
        return refuse('L’imputation n’est pas en retard (échéance non dépassée) : relance refusée.', sources);
      }
      if (!inputation.actorActive) {
        return refuse('Le destinataire de l’imputation n’est plus actif : relance refusée.', sources);
      }
      if (input.escalateToUserGroupId !== undefined && input.escalateToUserGroupId !== inputation.createdBy) {
        return refuse(
          `L’escalade n’est possible que vers l’auteur de l’imputation : l’acteur n° ${input.escalateToUserGroupId} est refusé.`,
          sources,
        );
      }

      const runKey = `${ctx.instanceId ?? ''}:${ctx.taskId ?? ctx.stepKey}`;
      if (!ctx.dryRun) {
        const already = memory.get(runKey);
        if (already.has(inputation.mailInputationId)) {
          return refuse('Une relance est déjà préparée pour cette imputation dans cette exécution.', sources);
        }
        const counts = await data.countRelances(inputation.mailId, inputation.userGroupId, ctx.instanceId, at);
        if (counts.target >= RELANCE_MAX_PER_TARGET_PER_DAY) {
          return refuse(
            `Plafond atteint : ${RELANCE_MAX_PER_TARGET_PER_DAY} relance(s) par imputation et par jour. Relance refusée.`,
            sources,
          );
        }
        if (counts.instance + already.size >= RELANCE_MAX_PER_INSTANCE_PER_DAY) {
          return refuse(
            `Plafond atteint : ${RELANCE_MAX_PER_INSTANCE_PER_DAY} relances par workflow et par jour. Relance refusée.`,
            sources,
          );
        }
      }

      const args: Record<string, unknown> = {
        mailId: inputation.mailId,
        mailInputationId: inputation.mailInputationId,
        recipientUserGroupId: inputation.userGroupId,
        message: input.message,
      };
      if (input.escalateToUserGroupId !== undefined) args.escalateToUserGroupId = input.escalateToUserGroupId;
      const parsed = relanceArgsSchema.safeParse(args);
      if (!parsed.success) return refuse('La relance est invalide : aucune action préparée.', sources);

      if (!ctx.dryRun) memory.add(runKey, inputation.mailInputationId);
      const escalade =
        input.escalateToUserGroupId !== undefined
          ? ` L’auteur de l’imputation (acteur n° ${input.escalateToUserGroupId}) sera aussi prévenu.`
          : '';
      const prepared: WfPreparedAction = {
        tool: CATALOG_TOOL_KEYS.proposerRelance,
        arguments: { ...parsed.data },
        sideEffect: 1,
        requiresValidation: true,
        preview: `Relancer ${cutOrEmpty(inputation.actorLabel, 100)} (notification interne) pour le courrier n° ${inputation.mailId}, échéance dépassée depuis le ${isoDay(inputation.deadline)} : « ${input.message} ».${escalade}`,
      };
      return { output: { prepared: true, destinataire: cutOrEmpty(inputation.actorLabel, LABEL_MAX) }, sources, prepared };
    },
  };
}

// ---------------------------------------------------------------------------
// 8. proposer_delegation (effet 1, validation) : n'écrit RIEN
// ---------------------------------------------------------------------------
const delegationInputSchema = z
  .object({
    mailId: idSchema,
    mailInputationId: idSchema,
    delegateUserGroupId: idSchema,
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

const NO_DELEGATE_MESSAGE = 'Aucun délégataire déclaré pour cette étape.';

/**
 * Évaluation (`dry_run`) : aucune lecture de base. Les délégataires déclarés viennent du contexte du cas
 * (`ctx.evalContext`, fourni par le runner en `dry_run` seulement, jamais par le modèle). Le résultat est
 * SIMULÉ : même règle de correspondance qu'en réel (délégataire déclaré, `forUserGroupId` = imputé si connu).
 */
function simulateDelegation(baseCtx: WfToolContext, input: z.infer<typeof delegationInputSchema>): WfToolResult {
  // `evalContext` : champ optionnel du contexte d'outil, posé par le runner en `dry_run` seulement.
  const ctx = baseCtx as WfToolContext & { evalContext?: Readonly<Record<string, unknown>> };
  const declared = declaredDelegatesSchema.safeParse(ctx.evalContext?.delegates);
  const list = declared.success ? declared.data : [];
  if (list.length === 0) return refuse(`${NO_DELEGATE_MESSAGE} (évaluation)`);
  const imputation = ctx.evalContext?.imputation;
  const rawRecipient =
    imputation && typeof imputation === 'object'
      ? ((imputation as Record<string, unknown>).recipientUserGroupId ?? (imputation as Record<string, unknown>).userGroupId)
      : undefined;
  const recipient = typeof rawRecipient === 'number' && Number.isInteger(rawRecipient) ? rawRecipient : undefined;
  const match = list.find(
    (d) =>
      d.userGroupId === input.delegateUserGroupId &&
      (d.forUserGroupId === undefined || recipient === undefined || d.forUserGroupId === recipient),
  );
  if (!match) {
    return refuse(`Le délégataire n° ${input.delegateUserGroupId} n’est pas déclaré pour cette imputation : délégation refusée.`);
  }
  if (recipient !== undefined && recipient === input.delegateUserGroupId) {
    return refuse('Le délégataire est déjà l’imputé : délégation refusée.');
  }
  const parsed = delegationArgsSchema.safeParse({
    mailId: input.mailId,
    mailInputationId: input.mailInputationId,
    delegateUserGroupId: input.delegateUserGroupId,
    rationale: input.rationale,
  });
  if (!parsed.success) return refuse('La délégation est invalide : aucune action préparée.');
  const prepared: WfPreparedAction = {
    tool: CATALOG_TOOL_KEYS.proposerDelegation,
    arguments: { ...parsed.data },
    sideEffect: 1,
    requiresValidation: true,
    preview: `Déléguer l’imputation n° ${input.mailInputationId} du courrier n° ${input.mailId} à l’acteur n° ${input.delegateUserGroupId} (simulation). Motif : ${input.rationale}`,
  };
  return { output: { prepared: true, simulated: true }, sources: [], prepared };
}

function delegationTool(data: CatalogDataPort): WfTool<z.infer<typeof delegationInputSchema>> {
  return {
    key: CATALOG_TOOL_KEYS.proposerDelegation,
    label: 'Proposer une délégation',
    description:
      'Prépare la redirection d’une imputation non traitée vers un délégataire DÉCLARÉ par le concepteur du workflow pour cette étape. Refusée si aucun délégataire déclaré ne correspond. N’écrit rien : un humain valide.',
    sideEffect: 1,
    requiresValidation: true,
    inputSchema: delegationInputSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mailId', 'mailInputationId', 'delegateUserGroupId', 'rationale'],
      properties: {
        mailId: { type: 'integer', minimum: 1 },
        mailInputationId: { type: 'integer', minimum: 1 },
        delegateUserGroupId: { type: 'integer', minimum: 1 },
        rationale: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      if (ctx.dryRun) return simulateDelegation(ctx, input);
      if (ctx.instanceId === null) return refuse('Instance du workflow inconnue : délégataires non disponibles.');
      const user = ctx.identity.user;
      const inputation = await data.readInputation(user, input.mailId, input.mailInputationId);
      if (!inputation) return refuse(INPUTATION_NOT_FOUND_MESSAGE);
      const sources = [mailSource(inputation.mailId, inputation.mailReference, inputation.mailTitle)];
      if (inputation.dateTreated) return refuse('L’imputation est déjà traitée : délégation refusée.', sources);

      const declared = await data.readDeclaredDelegates(ctx.instanceId, ctx.stepKey);
      if (declared.length === 0) return refuse(NO_DELEGATE_MESSAGE, sources);
      const match = declared.find(
        (d) =>
          d.userGroupId === input.delegateUserGroupId &&
          (d.forUserGroupId === undefined || d.forUserGroupId === inputation.userGroupId),
      );
      if (!match) {
        return refuse(
          `Aucun délégataire déclaré ne correspond à l’acteur n° ${input.delegateUserGroupId} pour cette imputation.`,
          sources,
        );
      }
      if (input.delegateUserGroupId === inputation.userGroupId) {
        return refuse('Le délégataire est déjà l’imputé : délégation refusée.', sources);
      }
      const delegate = await data.resolveImputableActor(user, input.delegateUserGroupId);
      if (!delegate) {
        return refuse(
          `Le délégataire n° ${input.delegateUserGroupId} est inactif ou n’est pas imputable par le lanceur : délégation refusée.`,
          sources,
        );
      }

      const parsed = delegationArgsSchema.safeParse({
        mailId: inputation.mailId,
        mailInputationId: inputation.mailInputationId,
        delegateUserGroupId: delegate.userGroupId,
        rationale: input.rationale,
      });
      if (!parsed.success) return refuse('La délégation est invalide : aucune action préparée.', sources);

      const prepared: WfPreparedAction = {
        tool: CATALOG_TOOL_KEYS.proposerDelegation,
        arguments: { ...parsed.data },
        sideEffect: 1,
        requiresValidation: true,
        preview: `Déléguer l’imputation du courrier n° ${inputation.mailId} de ${cutOrEmpty(inputation.actorLabel, 100)} à ${cutOrEmpty(delegate.label, 100)}. Motif : ${input.rationale}`,
      };
      return { output: { prepared: true, delegataire: cutOrEmpty(delegate.label, LABEL_MAX) }, sources, prepared };
    },
  };
}

/**
 * Les huit outils du catalogue. Le port de données est leur SEULE dépendance. Les outils d'écriture
 * (effet 1) PRÉPARENT seulement ; aucun ne distingue « inexistant » de « interdit ».
 */
export function createCatalogTools(data: CatalogDataPort, options: CatalogToolsOptions = {}): WfTool[] {
  const now = options.now ?? ((): Date => new Date());
  const memory = new RunMemory();
  return [
    similarMailsTool(data),
    organigrammeTool(data),
    piecesTool(data),
    compareTool(data),
    proposeImputationTool(data),
    draftTool(data),
    relanceTool(data, now, memory),
    delegationTool(data),
  ] as WfTool[];
}

/**
 * Enregistre les huit outils dans le registre. Idempotent : un outil de même clé déjà présent est ignoré
 * (jamais d'exception). Renvoie le nombre d'outils ajoutés.
 */
export function registerCatalogTools(
  registry: WfToolRegistryPort,
  data: CatalogDataPort,
  options?: CatalogToolsOptions,
): number {
  let added = 0;
  for (const tool of createCatalogTools(data, options)) {
    if (registry.get(tool.key)) continue;
    registry.register(tool);
    added += 1;
  }
  return added;
}
