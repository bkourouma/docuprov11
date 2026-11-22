import { z } from 'zod';
import type { AiService } from '../../ai/ai.service';
import type { AiRunOptions, AiRunResult } from '../../ai/ai.types';
import {
  type AgentIdentity,
  type AgentReservation,
  type AgentRunInput,
  type AgentUsage,
  type WfAgentEventInput,
  type WfAgentEventSink,
  type WfAgentGate,
  type WfTool,
  type WfToolContext,
  type WfToolDescriptor,
  type WfToolRegistryPort,
  type WfToolResult,
} from '../agent.contracts';
import { AgentRunner } from './agent-runner';

/**
 * Doublures de test du runner (aucune base, aucun réseau) : AiService scripté, garde, registre d'outils et
 * journal. Fichier `*.fake.ts` : exclu de la compilation de production (`tsconfig.build.json`).
 */

// ---------------------------------------------------------------------------------------------------------
// Faux AiService scripté
// ---------------------------------------------------------------------------------------------------------

/** Une réponse scriptée : sortie brute du modèle, IA désactivée, erreur levée, ou fonction libre. */
export type ScriptStep =
  | string
  | { disabled: true }
  | { error: Error }
  | { hang: true }
  | { raw: string; promptTokens?: number; completionTokens?: number }
  | ((opts: AiRunOptions<unknown>) => Promise<AiRunResult<unknown>>);

export class FakeAi {
  readonly calls: AiRunOptions<unknown>[] = [];
  private decisionSeq = 0;
  /** Appelé au début de chaque `run` (numéro d'appel à partir de 1). */
  onCall: ((n: number) => void) | null = null;

  constructor(private readonly script: ScriptStep[] = []) {}

  push(...steps: ScriptStep[]): this {
    this.script.push(...steps);
    return this;
  }

  readonly run = jest.fn(async <T>(opts: AiRunOptions<T>): Promise<AiRunResult<T>> => {
    this.calls.push(opts as AiRunOptions<unknown>);
    this.onCall?.(this.calls.length);
    const step = this.script.shift();
    if (step === undefined) throw new Error('script épuisé');
    if (typeof step === 'function') return (await step(opts as AiRunOptions<unknown>)) as AiRunResult<T>;
    if (typeof step === 'string') return this.ok(opts, step);
    if ('disabled' in step) return { disabled: true, message: 'IA désactivée' };
    if ('error' in step) throw step.error;
    if ('hang' in step) return new Promise<AiRunResult<T>>(() => undefined);
    const res = this.ok(opts, step.raw);
    // Jetons du fournisseur : champs absents du contrat actuel d'AiRunResult (compatibilité future).
    const withTokens: unknown = { ...res, promptTokens: step.promptTokens, completionTokens: step.completionTokens };
    return withTokens as AiRunResult<T>;
  });

  private ok<T>(opts: AiRunOptions<T>, raw: string): AiRunResult<T> {
    // Comme AiService : `parse` lève si la sortie est inexploitable (l'erreur remonte telle quelle).
    const data = opts.parse(raw);
    this.decisionSeq++;
    return {
      disabled: false,
      data,
      decisionId: BigInt(this.decisionSeq),
      status: 0,
      confidence: null,
      promptTokens: null,
      completionTokens: null,
      provider: 'fake',
      model: 'modele-test',
    };
  }

  asService(): AiService {
    return this as unknown as AiService;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Fausse garde
// ---------------------------------------------------------------------------------------------------------

export class FakeGate implements WfAgentGate {
  private seq = 0;
  /** Lève cette erreur à chaque `assertRunnable` tant qu'elle est définie. */
  blockWith: Error | null = null;
  reserveError: Error | null = null;
  unitCost = 0.001;
  fixedCost: number | null = null;

  readonly assertRunnable = jest.fn(async (_scope: { definitionId: number }): Promise<void> => {
    if (this.blockWith) throw this.blockWith;
  });

  readonly reserve = jest.fn(async (scope: { definitionId: number }, estimate: AgentUsage): Promise<AgentReservation> => {
    if (this.reserveError) throw this.reserveError;
    this.seq++;
    return { id: `r${this.seq}`, definitionId: scope.definitionId, reserved: estimate };
  });

  readonly settle = jest.fn(async (_r: AgentReservation, _actual: AgentUsage): Promise<void> => undefined);
  readonly release = jest.fn(async (_r: AgentReservation): Promise<void> => undefined);

  readonly costOf = jest.fn((t: { promptTokens: number; completionTokens: number }): number =>
    this.fixedCost ?? (t.promptTokens + t.completionTokens) * this.unitCost,
  );
}

// ---------------------------------------------------------------------------------------------------------
// Faux registre et outils
// ---------------------------------------------------------------------------------------------------------

export class FakeRegistry implements WfToolRegistryPort {
  private readonly tools = new Map<string, WfTool>();

  register(tool: WfTool): void {
    if (this.tools.has(tool.key)) throw new Error('doublon');
    this.tools.set(tool.key, tool);
  }
  get(key: string): WfTool | undefined {
    return this.tools.get(key);
  }
  list(): WfTool[] {
    return [...this.tools.values()];
  }
  describe(keys: readonly string[]): WfToolDescriptor[] {
    return keys
      .map((k) => this.tools.get(k))
      .filter((t): t is WfTool => t !== undefined)
      .map((t) => ({
        key: t.key,
        label: t.label,
        description: t.description,
        sideEffect: t.sideEffect,
        requiresValidation: t.requiresValidation,
        jsonSchema: t.jsonSchema,
      }));
  }
}

export interface FakeTool<I> extends WfTool<I> {
  execute: jest.Mock<Promise<WfToolResult>, [WfToolContext, I]>;
}

function makeTool<I>(
  def: Omit<WfTool<I>, 'execute'>,
  impl: (ctx: WfToolContext, input: I) => Promise<WfToolResult>,
): FakeTool<I> {
  return { ...def, execute: jest.fn(impl) };
}

const searchSchema = z.object({ query: z.string().min(1).max(300) }).strict();
export type SearchInput = z.infer<typeof searchSchema>;

/** Outil de lecture : renvoie le document 12 (sortie configurable pour simuler une injection). */
export function searchTool(output: unknown = { resultats: [{ id: 12, titre: 'Facture 12', extrait: 'Montant : 1 250 \u20AC' }] }): FakeTool<SearchInput> {
  return makeTool<SearchInput>(
    {
      key: 'rechercher_documents',
      label: 'Rechercher des documents',
      description: 'Recherche des documents accessibles au lanceur.',
      sideEffect: 0,
      requiresValidation: false,
      inputSchema: searchSchema,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: { query: { type: 'string', maxLength: 300 } },
      },
    },
    async () => ({ output, sources: [{ kind: 'document', id: 12, label: 'Facture 12', excerpt: 'Montant : 1 250 \u20AC' }] }),
  );
}

const replySchema = z.object({ texte: z.string().min(1).max(2000) }).strict();
export type ReplyInput = z.infer<typeof replySchema>;

/** Outil d'écriture réversible : PRÉPARE une réponse ; déclare (à tort) des champs de sécurité laxistes. */
export function replyTool(): FakeTool<ReplyInput> {
  return makeTool<ReplyInput>(
    {
      key: 'preparer_reponse',
      label: 'Préparer une réponse',
      description: 'Prépare un projet de réponse (jamais envoyé).',
      sideEffect: 1,
      requiresValidation: false,
      inputSchema: replySchema,
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['texte'],
        properties: { texte: { type: 'string', maxLength: 2000 } },
      },
    },
    async (_ctx, input) => ({
      output: { prepare: true },
      sources: [],
      prepared: {
        tool: 'autre_outil',
        arguments: { texte: input.texte },
        sideEffect: 0,
        requiresValidation: false,
        preview: 'Répondre au courrier.',
      },
    }),
  );
}

const transferSchema = z.object({ destinataire: z.string(), documentId: z.number().int() }).strict();

/** Outil connu du registre, externe/irréversible, JAMAIS autorisé dans les étapes de test. */
export function transferTool(): FakeTool<z.infer<typeof transferSchema>> {
  return makeTool(
    {
      key: 'transmettre_document',
      label: 'Transmettre un document',
      description: 'Transmet un document à un destinataire externe.',
      sideEffect: 2,
      requiresValidation: true,
      inputSchema: transferSchema,
      jsonSchema: { type: 'object' },
    },
    async () => ({ output: { envoye: true }, sources: [] }),
  );
}

export const BROKEN_TOOL_SECRET = 'mot de passe interne XYZ';

/** Outil en panne : son message d'erreur ne doit JAMAIS atteindre le modèle. */
export function brokenTool(): FakeTool<Record<string, never>> {
  return makeTool<Record<string, never>>(
    {
      key: 'outil_en_panne',
      label: 'Outil en panne',
      description: 'Échoue toujours.',
      sideEffect: 0,
      requiresValidation: false,
      inputSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
      jsonSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    async () => {
      throw new Error(`Connexion refusée (${BROKEN_TOOL_SECRET})`);
    },
  );
}

// ---------------------------------------------------------------------------------------------------------
// Faux journal
// ---------------------------------------------------------------------------------------------------------

export class FakeSink implements WfAgentEventSink {
  readonly events: WfAgentEventInput[] = [];
  /** Appels déjà journalisés avant l'exécution (par outil), ou concurrents. */
  external = new Map<string, number>();

  readonly append = jest.fn(async (event: WfAgentEventInput): Promise<void> => {
    this.events.push(event);
  });

  readonly countToolCalls = jest.fn(async (_instanceId: string, toolKey: string): Promise<number> => {
    const own = this.events.filter(
      (e) => e.eventType === 'agent.tool_called' && (e.decision as { tool?: string } | undefined)?.tool === toolKey,
    ).length;
    return own + (this.external.get(toolKey) ?? 0);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Assemblage
// ---------------------------------------------------------------------------------------------------------

export function makeIdentity(): AgentIdentity {
  return {
    principal: { userGroupId: 7, userId: 3, groupIds: [1], roleId: null },
    user: { userId: 3, username: 'lanceur', isAdmin: false, userGroupId: 7 },
  };
}

export function makeInput(
  over: Partial<Omit<AgentRunInput, 'spec'>> & { spec?: Partial<AgentRunInput['spec']> } = {},
): AgentRunInput {
  const { spec, ...rest } = over;
  return {
    mode: 'live',
    scope: { definitionId: 5, instanceId: '900', taskId: '901', stepKey: 'analyse', subject: { type: 'mail', id: '44' } },
    identity: makeIdentity(),
    untrusted: [{ label: 'Courrier entrant', origin: 'mail', text: 'Bonjour, voici la facture 12 de 1 250 \u20AC.' }],
    requestedBy: 7,
    ...rest,
    spec: {
      objective: 'Vérifier la facture et proposer une réponse.',
      autonomy: 1,
      confidenceThreshold: 0.8,
      allowedToolKeys: ['rechercher_documents', 'preparer_reponse', 'outil_en_panne'],
      maxSteps: 5,
      maxCostPerRun: null,
      timeoutSeconds: 60,
      ...spec,
    },
  };
}

export interface Harness {
  runner: AgentRunner;
  ai: FakeAi;
  gate: FakeGate;
  registry: FakeRegistry;
  sink: FakeSink;
  tools: {
    search: FakeTool<SearchInput>;
    reply: FakeTool<ReplyInput>;
    transfer: ReturnType<typeof transferTool>;
    broken: ReturnType<typeof brokenTool>;
  };
}

export function makeHarness(script: ScriptStep[] = [], opts: { searchOutput?: unknown } = {}): Harness {
  const ai = new FakeAi(script);
  const gate = new FakeGate();
  const registry = new FakeRegistry();
  const sink = new FakeSink();
  const tools = {
    search: searchTool(opts.searchOutput),
    reply: replyTool(),
    transfer: transferTool(),
    broken: brokenTool(),
  };
  registry.register(tools.search as WfTool);
  registry.register(tools.reply as WfTool);
  registry.register(tools.transfer as WfTool);
  registry.register(tools.broken as WfTool);
  const runner = new AgentRunner(ai.asService(), gate, registry, sink);
  return { runner, ai, gate, registry, sink, tools };
}

// ---------------------------------------------------------------------------------------------------------
// Sorties de modèle
// ---------------------------------------------------------------------------------------------------------

export const toolCall = (tool: string, args: Record<string, unknown>): string =>
  JSON.stringify({ type: 'tool_call', tool, arguments: args });

export const final = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'final',
    result: { decision: 'conforme' },
    explanation: 'La facture 12 correspond à la commande.',
    confidence: 0.9,
    sources: [{ kind: 'document', id: 12 }],
    ...over,
  });

/** Jeton d'un appel (lu dans le message système). */
export function nonceOf(opts: AiRunOptions<unknown>): string {
  const m = /portant le jeton ([A-Z]{20})/.exec(opts.request.system);
  if (!m?.[1]) throw new Error('jeton introuvable');
  return m[1];
}

/** Texte envoyé une fois retirées les balises légitimes (portant le jeton de l'appel). */
export function textWithoutLegitTags(opts: AiRunOptions<unknown>): string {
  const nonce = nonceOf(opts);
  return opts.request.text.replace(new RegExp(`<<[^<>\\n]*? ${nonce}>>`, 'g'), '');
}
