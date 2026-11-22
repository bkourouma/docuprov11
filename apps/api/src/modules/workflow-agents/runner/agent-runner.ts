import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { GedAiTask } from '@archivage/types';
import { AiService } from '../../ai/ai.service';
import { AiMaskingRequiredError, AiProviderError, AiUnsupportedInputError } from '../../ai/ai.types';
import {
  AgentBlockedError,
  WF_AGENT_EVENT_SINK,
  WF_AGENT_GATE,
  WF_AGENT_PROMPT_VERSION,
  WF_TOOL_REGISTRY,
  type AgentBlockReason,
  type AgentReservation,
  type AgentRunAudit,
  type AgentRunInput,
  type AgentRunOutput,
  type AgentRunStopReason,
  type AgentUsage,
  type WfAgentEventSink,
  type WfAgentGate,
  type WfAgentRunner,
  type WfAgentSource,
  type WfPreparedAction,
  type WfTool,
  type WfToolContext,
  type WfToolDescriptor,
  type WfToolRegistryPort,
} from '../agent.contracts';
import {
  MODEL_EXPLANATION_MAX_CHARS,
  ModelTurnError,
  normalizeConfidence,
  parseModelTurn,
  type ModelFinal,
  type ModelToolCall,
  type ModelTurn,
} from '../injection/output-schema';
import {
  HISTORY_ENTRY_MAX_CHARS,
  buildAgentPrompt,
  serializeForPrompt,
  type AgentPromptHistoryEntry,
  type AgentPromptRequest,
} from '../injection/prompt-builder';
import { detectInjection, type InjectionDetection } from '../injection/suspicion';
import { containsNonce, generateNonce, sanitizeText, truncateSafe } from '../injection/untrusted';

/**
 * Boucle d'un agent de workflow (tâche « agent », lot W2).
 *
 * Défenses, dans l'ordre où elles s'appliquent :
 *  1. garde (arrêt d'urgence, mode IA, budget) AVANT chaque appel au modèle et chaque appel d'outil ;
 *  2. plafonds : pas, délai global, coût par exécution, signal d'abandon ; réservation budgétaire atomique
 *     avant chaque appel, toujours soldée (`settle`) ou libérée (`release`) ;
 *  3. prompt isolé (jeton aléatoire par appel, données neutralisées), sortie au schéma strict ;
 *  4. outils : liste blanche de l'étape ET registre, arguments au schéma strict de l'outil, plafonds
 *     d'appels ; toute violation = outil NON exécuté, suspicion levée, arrêt ;
 *  5. conclusion : sources filtrées (seules celles renvoyées par un outil), confiance bornée, suspicion
 *     (entrées, résultats d'outils, sortie) => aucune action préparée conservée.
 * Le runner ne décide PAS de l'autonomie (`decideDisposition`). Il ne lève jamais pour une cause métier.
 * Aucun contenu de document ni de sortie du modèle dans les logs : types d'erreur seulement.
 */

const HARD_MAX_STEPS = 50;
const HARD_MAX_TIMEOUT_SECONDS = 3600;
const RESULT_MAX_BYTES = 64 * 1024;
const MAX_CONSECUTIVE_TOOL_ERRORS = 2;
const INSTRUCTION_OBJECTIVE_MAX_CHARS = 2000;
const INSTRUCTION_LABELS_MAX_CHARS = 1000;
const SOURCE_LABEL_MAX_CHARS = 200;
const SOURCE_EXCERPT_MAX_CHARS = 300;
const PREVIEW_MAX_CHARS = 500;
const SCAN_MAX_CHARS = 200_000;
const SCAN_MAX_DEPTH = 10;

/** Message renvoyé au modèle (comme DONNÉE) quand un outil échoue : jamais le message d'erreur brut. */
export const TOOL_FAILURE_OUTPUT =
  'L’outil n’a pas pu répondre. Aucune donnée n’est disponible pour cet appel ; ne le répète pas à l’identique.';

export const SUSPICION_WARNING =
  'Avertissement : une tentative de détournement des consignes a été détectée. Cette proposition doit être vérifiée par un humain ; aucune action préparée n’a été conservée.';

const STOP_MESSAGES: Record<AgentRunStopReason, string> = {
  ai_disabled: 'L’IA est désactivée : l’étape est confiée à un humain.',
  emergency_stop_global: 'Arrêt d’urgence global des agents : l’étape est confiée à un humain.',
  emergency_stop_workflow: 'Arrêt d’urgence des agents de ce workflow : l’étape est confiée à un humain.',
  budget_exceeded_global: 'Budget global des agents atteint : l’étape est confiée à un humain.',
  budget_exceeded_workflow: 'Budget des agents de ce workflow atteint : l’étape est confiée à un humain.',
  budget_unavailable: 'Budget des agents illisible : par prudence, l’étape est confiée à un humain.',
  max_steps: 'Nombre maximal de tours atteint sans conclusion : l’étape est confiée à un humain.',
  timeout: 'Délai maximal de l’agent dépassé : l’étape est confiée à un humain.',
  cost_per_run: 'Coût maximal par exécution atteint : l’étape est confiée à un humain.',
  invalid_output: 'Réponse du modèle refusée (format non conforme) : l’étape est confiée à un humain.',
  tool_denied: 'Appel d’outil refusé ou en échec : l’étape est confiée à un humain.',
  provider_error: 'Le service d’IA n’a pas pu répondre : l’étape est confiée à un humain.',
  masking_required: 'Envoi refusé : le masquage des données est obligatoire pour ce mode d’IA.',
  aborted: 'Exécution de l’agent interrompue.',
};

type StopOr<T> = { stop: AgentRunStopReason } | { value: T };

type RaceOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

interface RunState {
  audit: AgentRunAudit;
  /** Raisons de suspicion (codes courts, sans contenu), dans l'ordre d'apparition. */
  suspicion: Set<string>;
  /** Sources réellement renvoyées par un outil pendant l'exécution, par `kind:id`. */
  consulted: Map<string, WfAgentSource>;
  prepared: WfPreparedAction[];
  history: AgentPromptHistoryEntry[];
  /** Tous les jetons envoyés au modèle (détection d'une fuite dans la conclusion). */
  nonces: string[];
  executedByTool: Map<string, number>;
  /** Appels déjà journalisés par outil au démarrage (plafond par instance) ; `null` = illisible. */
  baselines: Map<string, number | null>;
  consecutiveToolErrors: number;
  deadline: number;
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'erreur inconnue';
}

function blockReasonOf(e: unknown): AgentBlockReason {
  // Échec fermé : toute erreur qui n'est pas un refus typé vaut « budget illisible ».
  return e instanceof AgentBlockedError ? e.reason : 'budget_unavailable';
}

function sourceKey(kind: string, id: number): string {
  return `${kind}:${id}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function singleLine(text: unknown, max: number): string {
  return truncateSafe(sanitizeText(text, max * 4 + 64).replace(/\s+/g, ' ').trim(), max);
}

/** JSON canonique (clés triées) : empreinte stable des arguments. */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) return '"[…]"';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`).join(',')}}`;
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  const s = JSON.stringify(value);
  return s === undefined ? 'null' : s;
}

function hashArgs(args: unknown): string {
  try {
    return createHash('sha256').update(canonicalJson(args)).digest('hex');
  } catch {
    return createHash('sha256').update('illisible').digest('hex');
  }
}

/** Chaînes (valeurs ET clés) d'une valeur, bornées en volume et en profondeur, pour la détection. */
function collectStrings(value: unknown, maxChars = SCAN_MAX_CHARS): string {
  const out: string[] = [];
  let total = 0;
  const seen = new WeakSet<object>();
  const push = (s: string): void => {
    if (total >= maxChars) return;
    const piece = s.length > maxChars - total ? s.slice(0, maxChars - total) : s;
    out.push(piece);
    total += piece.length;
  };
  const walk = (v: unknown, depth: number): void => {
    if (total >= maxChars || depth > SCAN_MAX_DEPTH) return;
    if (typeof v === 'string') return push(v);
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    for (const key of Object.keys(v)) {
      push(key);
      walk((v as Record<string, unknown>)[key], depth + 1);
    }
  };
  walk(value, 0);
  return out.join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class AgentRunner implements WfAgentRunner {
  private readonly logger = new Logger(AgentRunner.name);

  /** Horloge (millisecondes) ; surchargeable en test. */
  now: () => number = () => Date.now();

  constructor(
    private readonly ai: AiService,
    @Inject(WF_AGENT_GATE) private readonly gate: WfAgentGate,
    @Inject(WF_TOOL_REGISTRY) private readonly tools: WfToolRegistryPort,
    @Inject(WF_AGENT_EVENT_SINK) private readonly sink: WfAgentEventSink,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const st = this.createState(input);
    try {
      return await this.loop(input, st);
    } catch (e) {
      // Filet de sécurité : jamais d'exception vers le moteur, jamais de contenu dans le log.
      this.logger.error(`Exécution d’agent interrompue par une erreur inattendue (${errorName(e)}).`);
      return this.stopped(st, 'provider_error');
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Boucle
  // -------------------------------------------------------------------------------------------------------

  private async loop(input: AgentRunInput, st: RunState): Promise<AgentRunOutput> {
    const spec = input.spec;
    const scope = { definitionId: input.scope.definitionId };

    // 1. Garde initiale : aucun appel au modèle si l'agent est bloqué.
    const blocked = await this.checkGate(scope);
    if (blocked) return this.stopped(st, blocked);

    const timeoutSeconds = Number(spec.timeoutSeconds);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return this.stopped(st, 'timeout');
    st.deadline = this.now() + Math.min(timeoutSeconds, HARD_MAX_TIMEOUT_SECONDS) * 1000;

    const maxSteps = Number.isFinite(spec.maxSteps) ? Math.min(Math.floor(spec.maxSteps), HARD_MAX_STEPS) : 0;
    const allowed = new Set((Array.isArray(spec.allowedToolKeys) ? spec.allowedToolKeys : []).filter((k) => typeof k === 'string'));
    const live = input.mode === 'live';
    const instanceId = live && input.scope.instanceId ? input.scope.instanceId : null;

    // Entrées : détection (drapeau seulement ; la défense réelle est l'isolation).
    for (const block of Array.isArray(input.untrusted) ? input.untrusted : []) {
      this.flag(st, 'entree', detectInjection(block?.text));
    }

    const descriptors = this.describeAllowed(allowed);
    if (instanceId) await this.loadBaselines(st, instanceId, spec.remainingToolCalls, allowed);

    for (let step = 0; step < maxSteps; step++) {
      const pre = this.preCheck(input, st);
      if (pre) return this.stopped(st, pre);
      const gateStop = await this.checkGate(scope);
      if (gateStop) return this.stopped(st, gateStop);

      const nonce = generateNonce();
      st.nonces.push(nonce);
      const request = buildAgentPrompt({
        nonce,
        objective: spec.objective,
        tools: descriptors,
        blocks: input.untrusted,
        history: st.history,
        stepsLeft: maxSteps - step,
      });

      const estimate = this.estimate(request);
      if (!estimate) return this.stopped(st, 'budget_unavailable');
      if (spec.maxCostPerRun !== null && spec.maxCostPerRun !== undefined) {
        const cap = Number(spec.maxCostPerRun);
        if (!Number.isFinite(cap) || st.audit.costAmount + estimate.cost > cap) return this.stopped(st, 'cost_per_run');
      }

      let reservation: AgentReservation;
      try {
        reservation = await this.gate.reserve(scope, estimate);
      } catch (e) {
        return this.stopped(st, blockReasonOf(e));
      }

      const call = await this.callModel(input, st, request, reservation, estimate);
      if ('stop' in call) return this.stopped(st, call.stop);
      const turn = call.value;
      if (turn.type === 'final') return this.finalize(st, turn, allowed);

      const toolStop = await this.handleToolCall(input, st, turn, allowed, instanceId, scope);
      if (toolStop) return this.stopped(st, toolStop);
    }
    return this.stopped(st, 'max_steps');
  }

  // -------------------------------------------------------------------------------------------------------
  // Appel au modèle
  // -------------------------------------------------------------------------------------------------------

  private async callModel(
    input: AgentRunInput,
    st: RunState,
    request: AgentPromptRequest,
    reservation: AgentReservation,
    estimate: AgentUsage,
  ): Promise<StopOr<ModelTurn>> {
    st.audit.steps++;
    // Requête construite champ par champ : jamais de pièce jointe binaire (`attachments`).
    const pending = Promise.resolve().then(() =>
      this.ai.run<ModelTurn>({
        task: GedAiTask.Autre,
        request: {
          system: request.system,
          text: request.text,
          jsonSchema: request.jsonSchema,
          // Objets libres (arguments, result) : schéma non strict côté fournisseur ; la validation zod stricte reste la référence.
          strictSchema: false,
          maxOutputTokens: request.maxOutputTokens,
        },
        parse: parseModelTurn,
        confidence: (t) => (t.type === 'final' ? t.confidence : null),
        promptVersion: WF_AGENT_PROMPT_VERSION,
        requestedBy: input.requestedBy,
        autoApply: false,
        documentId: null,
      }),
    );
    const outcome = await this.race(pending, st.deadline, input.signal);

    if (outcome.kind === 'timeout' || outcome.kind === 'aborted') {
      // L'appel est parti : le coût est engagé, on solde l'estimation (prudent).
      await this.settle(st, reservation, estimate);
      return { stop: outcome.kind === 'timeout' ? 'timeout' : 'aborted' };
    }
    if (outcome.kind === 'error') {
      const e = outcome.error;
      if (e instanceof AiMaskingRequiredError) {
        await this.release(reservation); // refus avant tout appel au fournisseur
        return { stop: 'masking_required' };
      }
      if (e instanceof AiUnsupportedInputError) {
        await this.release(reservation);
        return { stop: 'provider_error' };
      }
      await this.settle(st, reservation, estimate);
      if (e instanceof ModelTurnError) return { stop: 'invalid_output' };
      if (!(e instanceof AiProviderError)) {
        this.logger.warn(`Appel au modèle en échec (${errorName(e)}).`);
      }
      return { stop: 'provider_error' };
    }

    const result = outcome.value;
    if (result.disabled) {
      await this.release(reservation);
      return { stop: 'ai_disabled' };
    }
    await this.settle(st, reservation, this.actualUsage(result) ?? estimate);
    if (result.decisionId !== null && result.decisionId !== undefined) {
      st.audit.aiDecisionIds.push(result.decisionId.toString());
    }
    st.audit.model = typeof result.model === 'string' ? result.model : st.audit.model;
    return { value: result.data };
  }

  /** Estimation prudente : jetons \u2248 caractères / 3 pour l'entrée, plafond de sortie pour la complétion. */
  private estimate(request: AgentPromptRequest): AgentUsage | null {
    const promptTokens = Math.ceil((request.system.length + request.text.length) / 3);
    const completionTokens = request.maxOutputTokens;
    try {
      const cost = this.gate.costOf({ promptTokens, completionTokens });
      if (!Number.isFinite(cost) || cost < 0) return null;
      return { promptTokens, completionTokens, cost };
    } catch {
      return null;
    }
  }

  /** Jetons réels du fournisseur s'ils sont exposés par le résultat ; sinon `null` (=> estimation). */
  private actualUsage(result: object): AgentUsage | null {
    const r = result as { promptTokens?: unknown; completionTokens?: unknown };
    const p = r.promptTokens;
    const c = r.completionTokens;
    if (typeof p !== 'number' || typeof c !== 'number' || !Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) {
      return null;
    }
    try {
      const cost = this.gate.costOf({ promptTokens: p, completionTokens: c });
      return Number.isFinite(cost) && cost >= 0 ? { promptTokens: p, completionTokens: c, cost } : null;
    } catch {
      return null;
    }
  }

  private async settle(st: RunState, reservation: AgentReservation, usage: AgentUsage): Promise<void> {
    st.audit.promptTokens += usage.promptTokens;
    st.audit.completionTokens += usage.completionTokens;
    st.audit.costAmount += usage.cost;
    try {
      await this.gate.settle(reservation, usage);
    } catch (e) {
      // La réservation reste comptée (surestimation prudente).
      this.logger.warn(`Solde de la réservation budgétaire impossible (${errorName(e)}).`);
    }
  }

  private async release(reservation: AgentReservation): Promise<void> {
    try {
      await this.gate.release(reservation);
    } catch (e) {
      this.logger.warn(`Libération de la réservation budgétaire impossible (${errorName(e)}).`);
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Outils
  // -------------------------------------------------------------------------------------------------------

  private describeAllowed(allowed: ReadonlySet<string>): WfToolDescriptor[] {
    if (allowed.size === 0) return [];
    const list = this.tools.describe([...allowed]);
    return (Array.isArray(list) ? list : []).filter((d) => d && allowed.has(d.key));
  }

  private async loadBaselines(
    st: RunState,
    instanceId: string,
    remaining: Readonly<Record<string, number>> | undefined,
    allowed: ReadonlySet<string>,
  ): Promise<void> {
    if (!remaining) return;
    for (const key of Object.keys(remaining)) {
      if (!allowed.has(key)) continue;
      try {
        const n = await this.sink.countToolCalls(instanceId, key);
        st.baselines.set(key, Number.isFinite(n) && n >= 0 ? n : null);
      } catch {
        st.baselines.set(key, null); // illisible : tout appel de cet outil sera refusé (échec fermé)
      }
    }
  }

  /** Plafond d'appels (exécution et instance) : vrai si l'appel doit être refusé. Échec fermé. */
  private async quotaDenied(
    input: AgentRunInput,
    st: RunState,
    key: string,
    instanceId: string | null,
  ): Promise<boolean> {
    const remaining = input.spec.remainingToolCalls?.[key];
    if (remaining === undefined) return false;
    if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining <= 0) return true;
    if ((st.executedByTool.get(key) ?? 0) >= remaining) return true;
    if (input.mode !== 'live') return false;
    if (!instanceId) return true; // exécution réelle sans instance : plafond invérifiable
    const baseline = st.baselines.get(key);
    if (baseline === undefined || baseline === null) return true;
    try {
      const current = await this.sink.countToolCalls(instanceId, key);
      // Compte aussi les appels concurrents d'autres exécutions sur la même instance.
      return !Number.isFinite(current) || current - baseline >= remaining;
    } catch {
      return true;
    }
  }

  private async handleToolCall(
    input: AgentRunInput,
    st: RunState,
    turn: ModelToolCall,
    allowed: ReadonlySet<string>,
    instanceId: string | null,
    scope: { definitionId: number },
  ): Promise<AgentRunStopReason | null> {
    const key = turn.tool;
    const argsHash = hashArgs(turn.arguments);

    // Liste blanche de l'étape ET registre : sinon l'outil n'est jamais exécuté.
    const tool: WfTool | undefined = allowed.has(key) ? this.tools.get(key) : undefined;
    if (!tool || tool.key !== key) return this.deny(input, st, instanceId, key, 2, argsHash, 'tool_not_allowed');

    let args: unknown;
    try {
      const parsed = tool.inputSchema.safeParse(turn.arguments);
      if (!parsed.success) return this.deny(input, st, instanceId, key, tool.sideEffect, argsHash, 'bad_arguments');
      args = parsed.data;
    } catch {
      return this.deny(input, st, instanceId, key, tool.sideEffect, argsHash, 'bad_arguments');
    }

    if (await this.quotaDenied(input, st, key, instanceId)) {
      return this.deny(input, st, instanceId, key, tool.sideEffect, argsHash, 'tool_quota');
    }

    // Arrêt d'urgence / délai / abandon : vérifiés juste avant l'exécution.
    const pre = this.preCheck(input, st);
    if (pre) return pre;
    const gateStop = await this.checkGate(scope);
    if (gateStop) return gateStop;

    const ctx: WfToolContext = {
      identity: input.identity,
      instanceId,
      taskId: input.scope.taskId ?? null,
      stepKey: input.scope.stepKey,
      subject: input.scope.subject ?? { type: null, id: null },
      dryRun: input.mode === 'dry_run',
    };
    st.executedByTool.set(key, (st.executedByTool.get(key) ?? 0) + 1);
    const outcome = await this.race(
      Promise.resolve().then(() => tool.execute(ctx, args)),
      st.deadline,
      input.signal,
    );

    if (outcome.kind === 'timeout' || outcome.kind === 'aborted') {
      await this.recordToolCall(st, input, instanceId, tool, argsHash, false, [], outcome.kind);
      return outcome.kind === 'timeout' ? 'timeout' : 'aborted';
    }

    const normalized = outcome.kind === 'ok' ? this.normalizeToolResult(outcome.value, tool) : null;
    if (!normalized) {
      st.consecutiveToolErrors++;
      await this.recordToolCall(st, input, instanceId, tool, argsHash, false, [], 'tool_error');
      st.history.push({ tool: key, ok: false, arguments: turn.arguments, output: TOOL_FAILURE_OUTPUT });
      return st.consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS ? 'tool_denied' : null;
    }

    st.consecutiveToolErrors = 0;
    for (const s of normalized.sources) st.consulted.set(sourceKey(s.kind, s.id), s);
    if (normalized.prepared) st.prepared.push(normalized.prepared);
    // Résultat d'outil = DONNÉE non fiable : détection (drapeau), puis ré-encadrement au prochain prompt.
    this.flag(st, 'outil', detectInjection(collectStrings([normalized.output, normalized.sources])));
    st.history.push({
      tool: key,
      ok: true,
      arguments: turn.arguments,
      output: serializeForPrompt(normalized.output, HISTORY_ENTRY_MAX_CHARS),
    });
    await this.recordToolCall(st, input, instanceId, tool, argsHash, true, normalized.sources);
    return null;
  }

  /**
   * Appel d'outil refusé : jamais exécuté. Le nom (tronqué, assaini) est conservé dans l'audit ET journalisé
   * (`agent.tool_called` avec `deniedTool`, hors compteur d'appels : la clé `tool` n'y figure pas) avec le drapeau
   * `suspicion_injection`.
   */
  private async deny(
    input: AgentRunInput,
    st: RunState,
    instanceId: string | null,
    key: string,
    sideEffect: 0 | 1 | 2,
    argsHash: string,
    reason: 'tool_not_allowed' | 'bad_arguments' | 'tool_quota',
  ): Promise<AgentRunStopReason> {
    st.suspicion.add(reason);
    const safeName = singleLine(key, 128);
    st.audit.toolCalls.push({
      tool: safeName,
      ok: false,
      sideEffect,
      argsHash,
      sourcesCount: 0,
      error: reason,
    });
    if (input.mode === 'live' && instanceId) {
      try {
        await this.sink.append({
          instanceId,
          taskId: input.scope.taskId ?? null,
          stepKey: input.scope.stepKey,
          eventType: 'agent.tool_called',
          decision: { deniedTool: safeName, denied: reason, sideEffect, argsHash, ok: false, suspicion_injection: true },
          autonomyLevel: input.spec.autonomy,
        });
      } catch (e) {
        this.logger.warn(`Journal de refus d’outil non écrit (${errorName(e)}).`);
      }
    }
    return 'tool_denied';
  }

  private async recordToolCall(
    st: RunState,
    input: AgentRunInput,
    instanceId: string | null,
    tool: WfTool,
    argsHash: string,
    ok: boolean,
    sources: WfAgentSource[],
    error?: string,
  ): Promise<void> {
    st.audit.toolCalls.push({
      tool: tool.key,
      ok,
      sideEffect: tool.sideEffect,
      argsHash,
      sourcesCount: sources.length,
      ...(error ? { error } : {}),
    });
    // Journal en exécution réelle seulement (jamais en évaluation).
    if (input.mode !== 'live' || !instanceId) return;
    const event = {
      instanceId,
      taskId: input.scope.taskId ?? null,
      stepKey: input.scope.stepKey,
      eventType: 'agent.tool_called',
      decision: { tool: tool.key, sideEffect: tool.sideEffect, ok, argsHash, sourcesCount: sources.length },
      sources: sources.map((s) => ({ kind: s.kind, id: s.id, ...(s.label ? { label: s.label } : {}) })),
      autonomyLevel: input.spec.autonomy,
    };
    // `append` ne lève pas par contrat ; attendu quand même (ordre du journal, plafond par instance).
    try {
      await this.sink.append(event);
    } catch (e) {
      this.logger.warn(`Journal d’appel d’outil non écrit (${errorName(e)}).`);
    }
  }

  private normalizeToolResult(
    raw: unknown,
    tool: WfTool,
  ): { output: unknown; sources: WfAgentSource[]; prepared: WfPreparedAction | null } | null {
    if (!isPlainObject(raw)) return null;
    const sources: WfAgentSource[] = [];
    for (const s of Array.isArray(raw.sources) ? raw.sources : []) {
      const norm = this.normalizeSource(s);
      if (norm) sources.push(norm);
    }
    let prepared: WfPreparedAction | null = null;
    if (tool.sideEffect !== 0 && isPlainObject(raw.prepared)) {
      prepared = this.normalizePrepared(raw.prepared, tool);
    }
    return { output: raw.output, sources, prepared };
  }

  private normalizeSource(s: unknown): WfAgentSource | null {
    if (!isPlainObject(s)) return null;
    const kind = s.kind;
    if (kind !== 'document' && kind !== 'mail' && kind !== 'passage') return null;
    const id = s.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return null;
    const out: WfAgentSource = { kind, id };
    const label = typeof s.label === 'string' ? singleLine(s.label, SOURCE_LABEL_MAX_CHARS) : '';
    if (label) out.label = label;
    const excerpt = typeof s.excerpt === 'string' ? singleLine(s.excerpt, SOURCE_EXCERPT_MAX_CHARS) : '';
    if (excerpt) out.excerpt = excerpt;
    return out;
  }

  /** Action préparée : champs de sécurité imposés par le REGISTRE (jamais ceux déclarés par le résultat). */
  private normalizePrepared(p: Record<string, unknown>, tool: WfTool): WfPreparedAction | null {
    let args: Record<string, unknown> = {};
    if (p.arguments !== undefined) {
      try {
        const copy: unknown = JSON.parse(JSON.stringify(p.arguments));
        if (!isPlainObject(copy)) return null;
        args = copy;
      } catch {
        return null;
      }
    }
    const preview =
      (typeof p.preview === 'string' ? singleLine(p.preview, PREVIEW_MAX_CHARS) : '') ||
      `Action préparée par l’outil « ${singleLine(tool.label, 120)} ».`;
    return {
      tool: tool.key,
      arguments: args,
      sideEffect: tool.sideEffect,
      requiresValidation: tool.requiresValidation || tool.sideEffect === 2 || p.requiresValidation === true,
      preview,
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Conclusion
  // -------------------------------------------------------------------------------------------------------

  private finalize(st: RunState, turn: ModelFinal, allowed: ReadonlySet<string>): AgentRunOutput {
    let resultJson: string;
    try {
      resultJson = JSON.stringify(turn.result);
    } catch {
      return this.stopped(st, 'invalid_output');
    }
    if (Buffer.byteLength(resultJson, 'utf8') > RESULT_MAX_BYTES) return this.stopped(st, 'invalid_output');

    // Le modèle ne peut pas inventer une source : seules celles renvoyées par un outil sont gardées,
    // dans la version de l'outil (libellé et extrait du modèle ignorés).
    const sources: WfAgentSource[] = [];
    const kept = new Set<string>();
    for (const s of turn.sources) {
      const k = sourceKey(s.kind, s.id);
      const consulted = st.consulted.get(k);
      if (consulted && !kept.has(k)) {
        kept.add(k);
        sources.push(consulted);
      }
    }

    const rawExplanation = turn.explanation;
    if (turn.suspicion) st.suspicion.add('sortie:signal_modele');
    const outputText = `${collectStrings(turn.result)}\n${rawExplanation}`;
    this.flag(st, 'sortie', detectInjection(outputText));
    const scanned = `${resultJson}\n${rawExplanation}`;
    if (st.nonces.some((n) => containsNonce(scanned, n))) st.suspicion.add('sortie:fuite_jeton');
    if (this.mentionsForbiddenTool(scanned, allowed)) st.suspicion.add('sortie:outil_non_autorise');

    const suspicious = st.suspicion.size > 0;
    const explanation = this.composeExplanation(rawExplanation, suspicious);
    return {
      outcome: 'final',
      result: turn.result,
      explanation,
      confidence: normalizeConfidence(turn.confidence),
      sources,
      preparedActions: suspicious ? [] : [...st.prepared],
      suspicionInjection: suspicious,
      suspicionReasons: [...st.suspicion],
      audit: this.snapshotAudit(st),
    };
  }

  /** Nom d'un outil connu du registre mais NON autorisé pour l'étape, cité dans la conclusion. */
  private mentionsForbiddenTool(text: string, allowed: ReadonlySet<string>): boolean {
    let known: WfTool[];
    try {
      known = this.tools.list();
    } catch {
      return false;
    }
    const lower = sanitizeText(text, SCAN_MAX_CHARS).toLowerCase();
    for (const t of Array.isArray(known) ? known : []) {
      if (!t || typeof t.key !== 'string' || !t.key || allowed.has(t.key)) continue;
      const re = new RegExp(`(?<![a-z0-9_.])${escapeRegExp(t.key.toLowerCase())}(?![a-z0-9_])`);
      if (re.test(lower)) return true;
    }
    return false;
  }

  private composeExplanation(raw: string, suspicious: boolean): string {
    const clean = sanitizeText(raw, MODEL_EXPLANATION_MAX_CHARS * 4).replace(/\n{3,}/g, '\n\n').trim();
    if (!suspicious) return truncateSafe(clean, MODEL_EXPLANATION_MAX_CHARS);
    const room = MODEL_EXPLANATION_MAX_CHARS - SUSPICION_WARNING.length - 1;
    return clean ? `${SUSPICION_WARNING}\n${truncateSafe(clean, room)}` : SUSPICION_WARNING;
  }

  // -------------------------------------------------------------------------------------------------------
  // Utilitaires
  // -------------------------------------------------------------------------------------------------------

  private createState(input: AgentRunInput): RunState {
    return {
      audit: {
        instruction: this.buildInstruction(input),
        model: null,
        aiDecisionIds: [],
        promptTokens: 0,
        completionTokens: 0,
        costAmount: 0,
        steps: 0,
        toolCalls: [],
      },
      suspicion: new Set<string>(),
      consulted: new Map(),
      prepared: [],
      history: [],
      nonces: [],
      executedByTool: new Map(),
      baselines: new Map(),
      consecutiveToolErrors: 0,
      deadline: 0,
    };
  }

  /** Objectif (de confiance, tronqué) + libellés des blocs de données : JAMAIS leur contenu. */
  private buildInstruction(input: AgentRunInput): string {
    try {
      const objective = truncateSafe(
        sanitizeText(input?.spec?.objective, INSTRUCTION_OBJECTIVE_MAX_CHARS * 4).trim(),
        INSTRUCTION_OBJECTIVE_MAX_CHARS,
      );
      const labels = (Array.isArray(input?.untrusted) ? input.untrusted : [])
        .map((b) => singleLine(b?.label, 120))
        .filter((l) => l.length > 0);
      if (!labels.length) return objective;
      return `${objective}\nDonnées : ${truncateSafe(labels.join(' ; '), INSTRUCTION_LABELS_MAX_CHARS)}`;
    } catch {
      return '';
    }
  }

  private flag(st: RunState, where: 'entree' | 'outil' | 'sortie', detection: InjectionDetection): void {
    for (const r of detection.reasons) st.suspicion.add(`${where}:${r}`);
  }

  private preCheck(input: AgentRunInput, st: RunState): AgentRunStopReason | null {
    if (input.signal?.aborted) return 'aborted';
    if (this.now() >= st.deadline) return 'timeout';
    return null;
  }

  private async checkGate(scope: { definitionId: number }): Promise<AgentBlockReason | null> {
    try {
      await this.gate.assertRunnable(scope);
      return null;
    } catch (e) {
      return blockReasonOf(e);
    }
  }

  /** Attend `p` dans la limite du délai global et du signal d'abandon. Ne rejette jamais. */
  private race<T>(p: Promise<T>, deadline: number, signal?: AbortSignal): Promise<RaceOutcome<T>> {
    return new Promise<RaceOutcome<T>>((resolve) => {
      let done = false;
      const onAbort = (): void => finish({ kind: 'aborted' });
      const finish = (o: RaceOutcome<T>): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(o);
      };
      const ms = deadline - this.now();
      const armed = !signal?.aborted && ms > 0;
      const timer = armed ? setTimeout(() => finish({ kind: 'timeout' }), ms) : undefined;
      timer?.unref?.();
      // Toujours abonné : une promesse abandonnée ne doit jamais produire de rejet non géré.
      p.then(
        (value) => finish({ kind: 'ok', value }),
        (error: unknown) => finish({ kind: 'error', error }),
      );
      if (signal?.aborted) return finish({ kind: 'aborted' });
      if (!armed) return finish({ kind: 'timeout' });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private snapshotAudit(st: RunState): AgentRunAudit {
    return { ...st.audit, aiDecisionIds: [...st.audit.aiDecisionIds], toolCalls: st.audit.toolCalls.map((c) => ({ ...c })) };
  }

  private stopped(st: RunState, reason: AgentRunStopReason): AgentRunOutput {
    const suspicious = st.suspicion.size > 0;
    const base = STOP_MESSAGES[reason] ?? STOP_MESSAGES.provider_error;
    return {
      outcome: 'stopped',
      stopReason: reason,
      result: null,
      explanation: suspicious ? `${SUSPICION_WARNING}\n${base}` : base,
      confidence: null,
      sources: [...st.consulted.values()],
      preparedActions: [],
      suspicionInjection: suspicious,
      suspicionReasons: [...st.suspicion],
      audit: this.snapshotAudit(st),
    };
  }
}
