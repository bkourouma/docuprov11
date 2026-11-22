import { z } from 'zod';
import type {
  WfAgentSource,
  WfPreparedAction,
  WfTool,
  WfToolContext,
  WfToolResult,
} from '../agent.contracts';
import type { WfAgentDataPort } from './agent-data.port';

/** Bornes de lecture (caractères) : jamais un document ou un courrier entier dans le contexte du modèle. */
export const DOCUMENT_READ_MAX_CHARS = 4000;
export const MAIL_READ_MAX_CHARS = 4000;
const SEARCH_DEFAULT_LIMIT = 5;
const SOURCE_EXCERPT_MAX = 300;

/** Même message pour « inexistant » et « interdit » : jamais de distinction. */
export const DOCUMENT_NOT_FOUND_MESSAGE = 'Document introuvable ou non accessible.';
export const MAIL_NOT_FOUND_MESSAGE = 'Courrier introuvable ou non accessible.';
const TARGET_NOT_FOUND_MESSAGE = 'Destinataire introuvable.';

const idSchema = z.number().int().positive().max(2_147_483_647);

function cut(text: string | null | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const chars = Array.from(text.trim());
  if (chars.length === 0) return undefined;
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

function documentSource(id: number, label: string, excerpt?: string | null): WfAgentSource {
  const source: WfAgentSource = { kind: 'document', id, label: cut(label, 200) ?? `Document ${id}` };
  const e = cut(excerpt, SOURCE_EXCERPT_MAX);
  if (e) source.excerpt = e;
  return source;
}

function mailSource(id: number, reference: string | null, title: string | null): WfAgentSource {
  return { kind: 'mail', id, label: cut(reference || title || `Courrier ${id}`, 200) };
}

// ---------------------------------------------------------------------------
// rechercher_documents
// ---------------------------------------------------------------------------
const searchSchema = z
  .object({
    query: z.string().min(1).max(300),
    limit: z.number().int().min(1).max(10).optional(), // défaut 5 appliqué à l'exécution
  })
  .strict();

function searchTool(data: WfAgentDataPort): WfTool<z.infer<typeof searchSchema>> {
  return {
    key: 'rechercher_documents',
    label: 'Rechercher des documents',
    description:
      'Recherche des documents accessibles au lanceur du workflow et renvoie leur identifiant, leur libellé et un extrait.',
    sideEffect: 0,
    requiresValidation: false,
    inputSchema: searchSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 300 },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: SEARCH_DEFAULT_LIMIT },
      },
    },
    async execute(ctx: WfToolContext, input): Promise<WfToolResult> {
      const hits = await data.searchDocuments(ctx.identity.user, input.query, input.limit ?? SEARCH_DEFAULT_LIMIT);
      const bounded = hits.slice(0, input.limit ?? SEARCH_DEFAULT_LIMIT);
      return {
        output: {
          hits: bounded.map((h) => ({
            documentId: h.documentId,
            label: cut(h.label, 200) ?? '',
            excerpt: cut(h.excerpt, SOURCE_EXCERPT_MAX) ?? '',
          })),
        },
        sources: bounded.map((h) => documentSource(h.documentId, h.label, h.excerpt)),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// lire_document
// ---------------------------------------------------------------------------
const readDocumentSchema = z.object({ documentId: idSchema }).strict();

function readDocumentTool(data: WfAgentDataPort): WfTool<z.infer<typeof readDocumentSchema>> {
  return {
    key: 'lire_document',
    label: 'Lire un document',
    description:
      'Lit les informations et des extraits bornés d’un document accessible au lanceur. Un document inexistant ou interdit donne la même réponse.',
    sideEffect: 0,
    requiresValidation: false,
    inputSchema: readDocumentSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['documentId'],
      properties: { documentId: { type: 'integer', minimum: 1 } },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const doc = await data.readDocument(ctx.identity.user, input.documentId, DOCUMENT_READ_MAX_CHARS);
      if (!doc) return { output: { found: false, message: DOCUMENT_NOT_FOUND_MESSAGE }, sources: [] };
      return {
        output: {
          found: true,
          documentId: doc.documentId,
          label: doc.label,
          documentType: doc.documentTypeLabel,
          documentDate: doc.documentDate,
          cote: doc.cote,
          overview: doc.overview,
          excerpts: doc.excerpts,
        },
        sources: [documentSource(doc.documentId, doc.label, doc.overview ?? doc.excerpts[0])],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// lire_courrier
// ---------------------------------------------------------------------------
const readMailSchema = z.object({ mailId: idSchema }).strict();

function readMailTool(data: WfAgentDataPort): WfTool<z.infer<typeof readMailSchema>> {
  return {
    key: 'lire_courrier',
    label: 'Lire un courrier',
    description:
      'Lit les champs et le texte borné d’un courrier lisible par le lanceur. Un courrier inexistant ou interdit donne la même réponse.',
    sideEffect: 0,
    requiresValidation: false,
    inputSchema: readMailSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mailId'],
      properties: { mailId: { type: 'integer', minimum: 1 } },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const mail = await data.readMail(ctx.identity.user, input.mailId, MAIL_READ_MAX_CHARS);
      if (!mail) return { output: { found: false, message: MAIL_NOT_FOUND_MESSAGE }, sources: [] };
      return {
        output: {
          found: true,
          mailId: mail.mailId,
          reference: mail.reference,
          title: mail.title,
          date: mail.date,
          sender: mail.senderLabel,
          nature: mail.natureLabel,
          objet: mail.objetLabel,
          confidentialite: mail.confidentialiteLabel,
          documents: mail.documents,
          text: mail.text,
        },
        sources: [mailSource(mail.mailId, mail.reference, mail.title)],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// proposer_imputation (n'écrit RIEN : prépare une action soumise à validation humaine)
// ---------------------------------------------------------------------------
const proposeImputationSchema = z
  .object({
    mailId: idSchema,
    target: z.object({ kind: z.enum(['user', 'role']), id: idSchema }).strict(),
    imputationType: z.string().min(1).max(100).optional(),
    rationale: z.string().min(1).max(500),
  })
  .strict();

function proposeImputationTool(data: WfAgentDataPort): WfTool<z.infer<typeof proposeImputationSchema>> {
  return {
    key: 'proposer_imputation',
    label: 'Proposer une imputation',
    description:
      'Prépare l’imputation d’un courrier à un utilisateur ou à un rôle. N’écrit rien : la proposition attend la validation d’un humain.',
    sideEffect: 1,
    requiresValidation: true,
    inputSchema: proposeImputationSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['mailId', 'target', 'rationale'],
      properties: {
        mailId: { type: 'integer', minimum: 1 },
        target: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'id'],
          properties: {
            kind: { type: 'string', enum: ['user', 'role'] },
            id: { type: 'integer', minimum: 1 },
          },
        },
        imputationType: { type: 'string', minLength: 1, maxLength: 100 },
        rationale: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const mail = await data.readMail(ctx.identity.user, input.mailId, 1);
      if (!mail) return { output: { prepared: false, message: MAIL_NOT_FOUND_MESSAGE }, sources: [] };
      if (!(await data.targetExists(input.target.kind, input.target.id))) {
        return { output: { prepared: false, message: TARGET_NOT_FOUND_MESSAGE }, sources: [] };
      }
      const cible = input.target.kind === 'user' ? 'l’utilisateur' : 'le rôle';
      const type = input.imputationType ? ` (type : ${input.imputationType})` : '';
      const args: Record<string, unknown> = {
        mailId: input.mailId,
        target: { kind: input.target.kind, id: input.target.id },
        rationale: input.rationale,
      };
      if (input.imputationType) args.imputationType = input.imputationType;
      const prepared: WfPreparedAction = {
        tool: 'proposer_imputation',
        arguments: args,
        sideEffect: 1,
        requiresValidation: true,
        preview: `Imputer le courrier n° ${input.mailId} à ${cible} n° ${input.target.id}${type}. Motif : ${input.rationale}`,
      };
      return {
        output: { prepared: true },
        sources: [mailSource(mail.mailId, mail.reference, mail.title)],
        prepared,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// proposer_reponse (n'écrit RIEN)
// ---------------------------------------------------------------------------
const proposeReplySchema = z
  .object({
    mailId: idSchema.optional(),
    subject: z.string().min(1).max(200),
    bodyText: z.string().min(1).max(4000),
  })
  .strict();

function proposeReplyTool(data: WfAgentDataPort): WfTool<z.infer<typeof proposeReplySchema>> {
  return {
    key: 'proposer_reponse',
    label: 'Proposer une réponse',
    description:
      'Prépare le brouillon d’une réponse (objet et texte), éventuellement liée à un courrier. N’écrit ni n’envoie rien : un humain valide.',
    sideEffect: 1,
    requiresValidation: true,
    inputSchema: proposeReplySchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'bodyText'],
      properties: {
        mailId: { type: 'integer', minimum: 1 },
        subject: { type: 'string', minLength: 1, maxLength: 200 },
        bodyText: { type: 'string', minLength: 1, maxLength: 4000 },
      },
    },
    async execute(ctx, input): Promise<WfToolResult> {
      const sources: WfAgentSource[] = [];
      if (input.mailId !== undefined) {
        const mail = await data.readMail(ctx.identity.user, input.mailId, 1);
        if (!mail) return { output: { prepared: false, message: MAIL_NOT_FOUND_MESSAGE }, sources: [] };
        sources.push(mailSource(mail.mailId, mail.reference, mail.title));
      }
      const args: Record<string, unknown> = { subject: input.subject, bodyText: input.bodyText };
      if (input.mailId !== undefined) args.mailId = input.mailId;
      const lien = input.mailId !== undefined ? ` au courrier n° ${input.mailId}` : '';
      const prepared: WfPreparedAction = {
        tool: 'proposer_reponse',
        arguments: args,
        sideEffect: 1,
        requiresValidation: true,
        preview: `Préparer une réponse${lien} intitulée « ${input.subject} ».`,
      };
      return { output: { prepared: true }, sources, prepared };
    },
  };
}

/**
 * Les cinq outils de base. Aucun n'écrit hors proposition : `dryRun` ne change donc rien (les lectures
 * restent soumises aux droits du lanceur, les `proposer_*` ne font que préparer).
 */
export function createBaseTools(data: WfAgentDataPort): WfTool[] {
  return [
    searchTool(data),
    readDocumentTool(data),
    readMailTool(data),
    proposeImputationTool(data),
    proposeReplyTool(data),
  ] as WfTool[];
}
