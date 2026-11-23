import { z } from 'zod';
import type { AuthUser } from '../../auth/auth.types';
import {
  PLANNER_MAIL_TEXT_MAX_CHARS,
  PLANNER_READ_TOOLS,
  PLANNER_SEARCH_DEFAULT_LIMIT,
  PLANNER_SEARCH_MAX_LIMIT,
  emptyEvidence,
  type AsstPlannerDataPort,
  type PlannerEvidence,
  type PlannerReadTool,
  type PlannerToolbox,
  type PlannerToolboxContext,
  type PlannerToolCallResult,
  type PlannerToolDescriptor,
} from './planner.types';

const MSG_UNKNOWN_TOOL = 'Outil inconnu : appel ignoré.';
const MSG_BAD_ARGS = 'Arguments invalides pour cet outil.';
const MSG_NO_MAIL_OPEN = 'Aucun courrier ouvert : précisez le courrier concerné.';
// Courrier illisible ET courrier inexistant : exactement le même message.
const MSG_MAIL_UNAVAILABLE = 'Courrier introuvable ou inaccessible.';
const MSG_FAILED = 'Lecture impossible pour le moment.';

/** Imputations d'un courrier renvoyées au modèle au plus. */
const INPUTATIONS_OUTPUT_MAX = 50;
const ID_MAX = 2_147_483_647;

const mailIdSchema = z.number().int().min(1).max(ID_MAX);
const limitSchema = z.number().int().min(1);

const SCHEMAS = {
  lire_courrier: z.object({ mailId: mailIdSchema.optional() }).strict(),
  rechercher_courriers: z
    .object({ query: z.string().trim().min(1).max(200), limit: limitSchema.optional() })
    .strict(),
  acteurs_imputables: z
    .object({ search: z.string().trim().min(1).max(100).optional(), limit: limitSchema.optional() })
    .strict(),
  types_imputation: z.object({}).strict(),
  imputations_courrier: z.object({ mailId: mailIdSchema }).strict(),
  modeles_brouillon: z.object({}).strict(),
  espaces_ecriture: z.object({}).strict(),
} satisfies Record<PlannerReadTool, z.ZodTypeAny>;

const NO_ARGS_JSON_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

const DESCRIPTORS: Record<PlannerReadTool, PlannerToolDescriptor> = {
  lire_courrier: {
    key: 'lire_courrier',
    label: 'Lire un courrier',
    description:
      'Lit un courrier que l’utilisateur a le droit de voir (références, objet, expéditeur, extrait du texte). Sans identifiant, lit le courrier de la page ouverte.',
    jsonSchema: {
      type: 'object',
      properties: { mailId: { type: 'integer', minimum: 1, description: 'Identifiant du courrier (facultatif).' } },
      additionalProperties: false,
    },
  },
  rechercher_courriers: {
    key: 'rechercher_courriers',
    label: 'Rechercher des courriers',
    description: 'Recherche des courriers par mots-clés parmi ceux que l’utilisateur peut lire.',
    jsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: PLANNER_SEARCH_MAX_LIMIT },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  acteurs_imputables: {
    key: 'acteurs_imputables',
    label: 'Acteurs imputables',
    description:
      'Liste les acteurs auxquels l’utilisateur peut imputer un courrier. Le filtre texte porte sur le nom et le groupe (par exemple « DAF »).',
    jsonSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', minLength: 1, maxLength: 100 },
        limit: { type: 'integer', minimum: 1, maximum: PLANNER_SEARCH_MAX_LIMIT },
      },
      additionalProperties: false,
    },
  },
  types_imputation: {
    key: 'types_imputation',
    label: 'Types d’imputation',
    description: 'Liste les types d’imputation actifs.',
    jsonSchema: { ...NO_ARGS_JSON_SCHEMA },
  },
  imputations_courrier: {
    key: 'imputations_courrier',
    label: 'Imputations d’un courrier',
    description: 'Liste les imputations existantes d’un courrier (acteur, type, échéance, traitement, retard).',
    jsonSchema: {
      type: 'object',
      properties: { mailId: { type: 'integer', minimum: 1 } },
      required: ['mailId'],
      additionalProperties: false,
    },
  },
  modeles_brouillon: {
    key: 'modeles_brouillon',
    label: 'Modèles de brouillon',
    description: 'Liste les modèles de rédaction disponibles pour un brouillon.',
    jsonSchema: { ...NO_ARGS_JSON_SCHEMA },
  },
  espaces_ecriture: {
    key: 'espaces_ecriture',
    label: 'Espaces d’écriture',
    description: 'Liste les espaces où l’utilisateur peut déposer un brouillon.',
    jsonSchema: { ...NO_ARGS_JSON_SCHEMA },
  },
};

const fail = (output: string): PlannerToolCallResult => ({ ok: false, output });
const success = (output: unknown): PlannerToolCallResult => ({ ok: true, output });

/**
 * Boîte à outils de LECTURE du planificateur (une instance par message traité). Ne lève jamais ; ne fait que lire,
 * avec les droits de l'utilisateur ; recueille les preuves de ce que le modèle a vu. Tout texte de tiers renvoyé
 * est enregistré dans `evidence.untrustedTexts` (analysé contre l'injection) et reste de la DONNÉE.
 */
export class AsstPlannerToolbox implements PlannerToolbox {
  readonly evidence: PlannerEvidence = emptyEvidence();
  private readonly user: AuthUser;

  constructor(
    private readonly data: AsstPlannerDataPort,
    private readonly ctx: PlannerToolboxContext,
  ) {
    this.user = ctx.user;
  }

  describe(): PlannerToolDescriptor[] {
    return PLANNER_READ_TOOLS.map((k) => DESCRIPTORS[k]);
  }

  async call(tool: string, args: unknown): Promise<PlannerToolCallResult> {
    try {
      if (!isReadTool(tool)) return fail(MSG_UNKNOWN_TOOL);
      const parsed = SCHEMAS[tool].safeParse(args === undefined || args === null ? {} : args);
      if (!parsed.success) return fail(MSG_BAD_ARGS);
      return await this.run(tool, parsed.data as Record<string, unknown>);
    } catch {
      return fail(MSG_FAILED);
    }
  }

  private async run(tool: PlannerReadTool, a: Record<string, unknown>): Promise<PlannerToolCallResult> {
    switch (tool) {
      case 'lire_courrier':
        return this.readMail(a['mailId'] as number | undefined);
      case 'rechercher_courriers':
        return this.searchMails(a['query'] as string, a['limit'] as number | undefined);
      case 'acteurs_imputables':
        return this.listActors(a['search'] as string | undefined, a['limit'] as number | undefined);
      case 'types_imputation':
        return this.listTypes();
      case 'imputations_courrier':
        return this.listInputations(a['mailId'] as number);
      case 'modeles_brouillon':
        return success({
          modeles: this.data.listDraftTemplates().map((t) => ({ id: t.id, libelle: t.label })),
        });
      case 'espaces_ecriture':
        return this.listSpaces();
    }
  }

  private async readMail(mailId: number | undefined): Promise<PlannerToolCallResult> {
    const id = mailId ?? this.pageMailId();
    if (id === null) return fail(MSG_NO_MAIL_OPEN);
    const mail = await this.data.readMail(this.user, id, PLANNER_MAIL_TEXT_MAX_CHARS);
    if (!mail) return fail(MSG_MAIL_UNAVAILABLE);
    const text = mail.text ? truncate(mail.text, PLANNER_MAIL_TEXT_MAX_CHARS) : null;
    this.evidence.mails.set(mail.mailId, { mailId: mail.mailId, reference: mail.reference, title: mail.title });
    this.trust(mail.title, mail.senderLabel, mail.objetLabel, mail.natureLabel, text);
    return success({
      mailId: mail.mailId,
      reference: mail.reference,
      objet: mail.title,
      date: mail.date,
      expediteur: mail.senderLabel,
      nature: mail.natureLabel,
      motCle: mail.objetLabel,
      confidentialite: mail.confidentialiteLabel,
      texte: text,
    });
  }

  private async searchMails(query: string, limit: number | undefined): Promise<PlannerToolCallResult> {
    const bound = boundedLimit(limit);
    const hits = (await this.data.searchMails(this.user, query, bound)).slice(0, bound);
    for (const h of hits) {
      this.evidence.mails.set(h.mailId, { mailId: h.mailId, reference: h.reference, title: h.title });
      this.trust(h.title, h.senderLabel);
    }
    this.evidence.mailSearches.push({ query, mailIds: hits.map((h) => h.mailId) });
    return success({
      courriers: hits.map((h) => ({
        mailId: h.mailId,
        reference: h.reference,
        objet: h.title,
        date: h.date,
        expediteur: h.senderLabel,
      })),
    });
  }

  private async listActors(search: string | undefined, limit: number | undefined): Promise<PlannerToolCallResult> {
    const bound = boundedLimit(limit);
    const actors = (await this.data.listActors(this.user, { search, limit: bound })).slice(0, bound);
    this.evidence.actorSearches.push({ search: search ?? null, actors });
    for (const a of actors) this.trust(a.label, a.roleName, a.organigrammeLabel);
    return success({
      acteurs: actors.map((a) => ({
        userGroupId: a.userGroupId,
        libelle: a.label,
        role: a.roleName,
        organigramme: a.organigrammeLabel,
      })),
    });
  }

  private async listTypes(): Promise<PlannerToolCallResult> {
    const types = await this.data.listInputationTypes();
    return success({ types: types.map((t) => ({ id: t.id, libelle: t.label, suivi: t.suivi })) });
  }

  private async listInputations(mailId: number): Promise<PlannerToolCallResult> {
    const rows = await this.data.listInputations(this.user, mailId, this.ctx.now, INPUTATIONS_OUTPUT_MAX);
    if (rows === null) return fail(MSG_MAIL_UNAVAILABLE);
    const bounded = rows.slice(0, INPUTATIONS_OUTPUT_MAX);
    for (const r of bounded) {
      this.evidence.inputations.set(r.mailInputationId, r);
      this.trust(r.actorLabel, r.typeLabel);
    }
    const mine = this.user.userGroupId;
    return success({
      mailId,
      imputations: bounded.map((r) => ({
        mailInputationId: r.mailInputationId,
        acteurId: r.actorUserGroupId,
        acteur: r.actorLabel,
        acteurActif: r.actorActive,
        typeId: r.typeId,
        type: r.typeLabel,
        echeance: r.deadline ? r.deadline.toISOString().slice(0, 10) : null,
        traitee: r.treated,
        enRetard: r.late,
        creeParVous: mine != null && r.createdBy === mine,
      })),
    });
  }

  private async listSpaces(): Promise<PlannerToolCallResult> {
    const spaces = (await this.data.listWritableSpaces(this.user, PLANNER_SEARCH_MAX_LIMIT)).slice(0, PLANNER_SEARCH_MAX_LIMIT);
    for (const s of spaces) this.trust(s.label);
    return success({ espaces: spaces.map((s) => ({ spaceId: s.spaceId, libelle: s.label })) });
  }

  /** Courrier de la page ouverte (`subjectType === 'mail'`), sinon `null`. */
  private pageMailId(): number | null {
    const page = this.ctx.pageContext;
    if (!page || page.subjectType !== 'mail' || !page.subjectId) return null;
    const n = Number(page.subjectId);
    return Number.isSafeInteger(n) && n >= 1 && n <= ID_MAX ? n : null;
  }

  private trust(...texts: Array<string | null | undefined>): void {
    for (const t of texts) {
      if (typeof t === 'string' && t.trim() !== '') this.evidence.untrustedTexts.push(t);
    }
  }
}

export function createPlannerToolbox(data: AsstPlannerDataPort, ctx: PlannerToolboxContext): PlannerToolbox {
  return new AsstPlannerToolbox(data, ctx);
}

function isReadTool(tool: string): tool is PlannerReadTool {
  return (PLANNER_READ_TOOLS as readonly string[]).includes(tool);
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(PLANNER_SEARCH_MAX_LIMIT, limit ?? PLANNER_SEARCH_DEFAULT_LIMIT);
}

/** Tronque par points de code. */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}
