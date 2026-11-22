import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ASST_ASSISTANT_MESSAGE_MAX_CHARS,
  ASST_PROPOSAL_TTL_MINUTES,
  AsstMessageRole,
  GedAiTask,
  asstClarificationSchema,
  asstProposedActionsSchema,
  type AsstClarificationDto,
  type AsstProposedAction,
} from '@archivage/types';
import { AiService } from '../../ai/ai.service';
import { AiMaskingRequiredError, AiUnsupportedInputError } from '../../ai/ai.types';
import { WF_AGENT_GATE, type AgentUsage, type WfAgentGate } from '../../workflow-agents/agent.contracts';
import { detectInjection, normalizeForDetection } from '../../workflow-agents/injection/suspicion';
import { containsNonce, generateNonce, truncateSafe } from '../../workflow-agents/injection/untrusted';
import {
  ASST_GATE,
  AsstError,
  type AsstGatePort,
  type AsstIdentity,
  type AsstPlanInput,
  type AsstPlannerPort,
  type AsstPlanResult,
  type AsstReservation,
} from '../assistant.contracts';
import { PLANNER_MSG_ACTION_CLAIM, claimsActionDone } from './action-claims';
import {
  formatClarificationContent,
  formatClarificationQuestion,
  isClarificationContent,
  parseClarificationContent,
  stripClarificationMarker,
} from './clarification-format';
import { intentHistory } from './intent-guards';
import { buildPlannerPrompt, type PlannerPromptRequest, type PlannerPromptToolEntry } from './planner-prompt';
import { createPlannerToolbox } from './planner-toolbox';
import { AsstTurnError, parseAsstTurn, type AsstTurn } from './planner-turn';
import {
  ASST_ACTION_VALIDATOR,
  ASST_PLANNER_DATA,
  PLANNER_CHOICES_MAX,
  PLANNER_CHOICES_MIN,
  PLANNER_CHOICE_LABEL_MAX_CHARS,
  PLANNER_MAX_TOOL_CALLS,
  PLANNER_MAX_TURNS,
  PLANNER_PROMPT_VERSION,
  plannerMaxActions,
  type ActionValidationOutcome,
  type AsstActionValidator,
  type AsstPlannerDataPort,
  type PlannerDraftResult,
  type PlannerToolbox,
} from './planner.types';

// Planificateur de l'assistant (lot A1, T6) : boucle bornée « modèle -> outils de LECTURE -> conclusion ».
//
// Défenses, dans l'ordre où elles s'appliquent :
//  1. porte de coût AVANT tout (mode IA, arrêt d'urgence, plafond du jour) puis RÉSERVATION avant CHAQUE appel au
//     modèle (et avant la génération d'un brouillon), toujours soldée (`settle`) ou libérée (`release`) ;
//  2. masquage cloud obligatoire via `AiService` : un refus de masquage ou une IA désactivée = indisponible, JAMAIS
//     de repli sans masquage ; un jeton aléatoire NEUF par appel (prompt isolé, données neutralisées) ;
//  3. outils de LECTURE seulement, avec les droits de l'utilisateur, plafonnés ; tout texte de tiers vu est analysé
//     (`detectInjection`) : une consigne détournée lève un drapeau pour TOUTE la requête ;
//  4. proposition : portes successives, échec fermé (suspicion du modèle, intention venue d'une donnée, drapeau de
//     la requête, puis validateur d'actions qui recalcule tout depuis le message de l'utilisateur) ;
//  5. la réponse qui accompagne une proposition est CONSTRUITE PAR LE CODE : le texte du modèle n'y figure jamais ;
//  6. un texte libre du modèle qui REVENDIQUE une action (« j'ai imputé », « c'est fait ») est remplacé par une phrase
//     fixe ; seule une question construite ici porte le marqueur de question de précision (`clarification-format.ts`),
//     retiré de toute autre réponse ;
//  7. historique : seul le message courant établit l'intention, sauf réponse à une question de précision marquée
//     (`intentHistory`), et jamais un ordre annulé.
// Aucune écriture métier ; ne crée ni message ni proposition. Aucun contenu dans les journaux (types d'erreur seuls).

const MSG_UNAVAILABLE = 'L’assistant est momentanément indisponible.';
const MSG_AI_DISABLED = 'L’assistant est indisponible : l’IA est désactivée.';
const MSG_MASKING =
  'L’assistant est indisponible : le masquage des données, obligatoire pour l’IA en nuage, n’est pas assuré. Aucune donnée n’a été envoyée.';
export const PLANNER_MSG_INVALID_OUTPUT = 'Je n’ai pas pu comprendre ma propre réponse ; pouvez-vous reformuler ?';
export const PLANNER_MSG_EXHAUSTED =
  'Je n’ai pas pu conclure dans les limites prévues (tours ou lectures) ; aucune action n’est proposée. Pouvez-vous préciser votre demande ?';
export const PLANNER_MSG_DATA_SUSPICION =
  'J’ai détecté, dans le contenu consulté, des consignes inhabituelles ; je ne propose aucune action. Vérifiez le contenu ou reformulez votre demande.';
export const PLANNER_MSG_EXTERNAL_INTENT =
  'Cette action ne provient pas de votre demande : je ne propose aucune action. Formulez explicitement ce que vous voulez faire.';
export const PLANNER_MSG_SUSPICION_WARNING =
  'Attention : le contenu consulté contient des consignes inhabituelles, que j’ai ignorées.';
export const PLANNER_MSG_LEAK = 'Je ne peux pas afficher cette réponse. Pouvez-vous reformuler votre demande ?';
export const PLANNER_MSG_PROPOSAL_INVALID =
  'Je ne peux pas préparer cette action (contrôle final en échec). Aucune action n’a été proposée.';
export const PLANNER_PROPOSAL_INTRO = 'Je propose :';
export const PLANNER_PROPOSAL_OUTRO = `Confirmez pour appliquer (valable ${ASST_PROPOSAL_TTL_MINUTES} minutes).`;
const MSG_TOOL_CAP = 'Plafond d’appels d’outils atteint : aucun outil n’a été exécuté. Réponds maintenant sans outil.';
const MSG_DRAFT_UNAVAILABLE = 'La rédaction assistée est momentanément indisponible.';

/** Estimation fixe d'une génération de brouillon (comme le catalogue d'agents). */
export const PLANNER_DRAFT_ESTIMATE_PROMPT_TOKENS = 4000;
export const PLANNER_DRAFT_ESTIMATE_COMPLETION_TOKENS = 3000;

/** Volume de texte d'un résultat d'outil analysé par la détection (caractères). */
const SCAN_MAX_CHARS = 200_000;
const SCAN_MAX_DEPTH = 10;

interface LoopState {
  usage: AgentUsage;
  aiDecisionId: string | null;
  /** Consigne détournée vue pendant CETTE requête (courrier, nom, résultat d'outil, historique de l'assistant). */
  dataSuspicion: boolean;
  toolHistory: PlannerPromptToolEntry[];
  toolCalls: number;
  nonces: string[];
}

type ModelOutcome = { kind: 'turn'; turn: AsstTurn } | { kind: 'invalid' };

const zeroUsage = (): AgentUsage => ({ promptTokens: 0, completionTokens: 0, cost: 0 });

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'erreur inconnue';
}

/** Chaînes (valeurs et clés) d'une valeur, bornées, pour la détection. */
function collectStrings(value: unknown): string {
  const out: string[] = [];
  let total = 0;
  const push = (s: string): void => {
    if (total >= SCAN_MAX_CHARS) return;
    const piece = s.slice(0, SCAN_MAX_CHARS - total);
    out.push(piece);
    total += piece.length;
  };
  const walk = (v: unknown, depth: number): void => {
    if (total >= SCAN_MAX_CHARS || depth > SCAN_MAX_DEPTH) return;
    if (typeof v === 'string') return push(v);
    if (v === null || typeof v !== 'object') return;
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

/**
 * Imitation des balises PROPRES au prompt du planificateur (`<<MESSAGE_UTILISATEUR …>>`, `<<FIN_MESSAGE_UTILISATEUR …>>`),
 * que la détection générique des agents (`suspicion.ts`, en lecture seule) ne connaît pas. Appliquée sur la forme
 * canonique (chevrons sosies et pleine chasse ramenés, casse et accents retirés).
 */
const PLANNER_MARKER_IMITATION =
  /<<\s*\/?\s*(?:(?:fin|end)[_ ])?message[_ ]utilisateur\b|\b(?:(?:fin|end)_)?message_utilisateur\b/;

/** Consigne détournée dans un texte de tiers : détection générique + balises propres au planificateur. */
export function detectPlannerInjection(text: unknown): boolean {
  if (detectInjection(text).suspicious) return true;
  return PLANNER_MARKER_IMITATION.test(normalizeForDetection(typeof text === 'string' ? text : ''));
}

function addUsage(total: AgentUsage, u: AgentUsage): void {
  total.promptTokens += u.promptTokens;
  total.completionTokens += u.completionTokens;
  total.cost += u.cost;
}

@Injectable()
export class AsstPlannerService implements AsstPlannerPort {
  private readonly logger = new Logger(AsstPlannerService.name);

  /** Horloge (surchargeable dans les tests). */
  now: () => Date = () => new Date();

  constructor(
    private readonly ai: AiService,
    @Inject(ASST_GATE) private readonly gate: AsstGatePort,
    /** Utilisée UNIQUEMENT pour `costOf` (tarif) : la réservation passe par la porte de l'assistant. */
    @Inject(WF_AGENT_GATE) private readonly wfGate: WfAgentGate,
    @Inject(ASST_PLANNER_DATA) private readonly data: AsstPlannerDataPort,
    @Inject(ASST_ACTION_VALIDATOR) private readonly validator: AsstActionValidator,
  ) {}

  async plan(input: AsstPlanInput): Promise<AsstPlanResult> {
    try {
      // a. Porte : les `AsstError` (budget, indisponible) remontent telles quelles.
      await this.gate.assertRunnable(input.identity.user.userId);
      return await this.loop(input);
    } catch (e) {
      if (e instanceof AsstError) throw e;
      // Filet de sécurité : jamais d'exception non typée, jamais de contenu dans le journal.
      this.logger.error(`Planification interrompue par une erreur inattendue (${errorName(e)}).`);
      throw new AsstError('assistant_unavailable', MSG_UNAVAILABLE);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Boucle
  // ---------------------------------------------------------------------------------------------

  private async loop(input: AsstPlanInput): Promise<AsstPlanResult> {
    const { identity } = input;
    const now = this.now();
    const message = typeof input.message === 'string' ? input.message : '';
    const pageContext = input.pageContext ?? null;
    const history = this.boundedHistory(input.history, message);
    // Intention : le message COURANT seul, sauf s'il répond à une question de précision (dernier message assistant
    // marqué) ; une annulation rend caducs les ordres antérieurs (`intentHistory`). Le modèle voit tout l'historique,
    // mais un ordre ancien n'est jamais repris par le validateur hors de ce cas.
    const previousUserMessages = intentHistory(history, message);
    const maxActions = plannerMaxActions();
    const toolbox = createPlannerToolbox(this.data, { user: identity.user, pageContext, now });
    const st: LoopState = {
      usage: zeroUsage(),
      aiDecisionId: null,
      dataSuspicion: false,
      toolHistory: [],
      toolCalls: 0,
      nonces: [],
    };

    // Messages précédents de l'ASSISTANT : ils ont pu reprendre un texte de tiers (réponse libre du modèle, libellés).
    // Une consigne détournée qui s'y trouve vaut drapeau pour la requête (échec fermé ; les messages de
    // l'utilisateur, source d'intention, ne sont pas analysés).
    for (const m of history) {
      if (m.role !== AsstMessageRole.User && detectPlannerInjection(m.content)) st.dataSuspicion = true;
    }

    for (let turnIndex = 0; turnIndex < PLANNER_MAX_TURNS; turnIndex++) {
      const nonce = generateNonce();
      st.nonces.push(nonce);
      const request = buildPlannerPrompt({
        nonce,
        tools: toolbox.describe(),
        userMessage: message,
        history,
        pageContext,
        toolHistory: st.toolHistory,
        turnsLeft: PLANNER_MAX_TURNS - turnIndex,
        toolCallsLeft: Math.max(0, PLANNER_MAX_TOOL_CALLS - st.toolCalls),
        maxActions,
        now,
      });
      const outcome = await this.callModel(identity, request, st);
      if (outcome.kind === 'invalid') return this.textResult(st, PLANNER_MSG_INVALID_OUTPUT);
      const turn = outcome.turn;

      switch (turn.type) {
        case 'tool_call':
          await this.runTool(toolbox, turn.tool, turn.arguments, st);
          continue;
        case 'answer':
          return this.textResult(st, this.modelText(st, turn.text));
        case 'clarify':
          return this.clarifyResult(st, turn.question, turn.choices);
        case 'propose':
          return this.proposeResult(st, turn, {
            identity,
            userMessage: message,
            previousUserMessages,
            pageContext,
            toolbox,
            now,
            maxActions,
          });
      }
    }
    // e. Tours épuisés sans conclusion.
    return this.textResult(st, PLANNER_MSG_EXHAUSTED);
  }

  /** Historique borné (le prompt rebornera) ; le message courant, s'il y figure en dernier, n'est pas doublé. */
  private boundedHistory(
    history: AsstPlanInput['history'],
    message: string,
  ): Array<{ role: AsstMessageRole; content: string }> {
    const list = (Array.isArray(history) ? history : [])
      .filter((m) => m && typeof m.content === 'string' && (m.role === AsstMessageRole.User || m.role === AsstMessageRole.Assistant))
      .map((m) => ({ role: m.role, content: m.content }));
    const last = list[list.length - 1];
    if (last && last.role === AsstMessageRole.User && last.content === message) list.pop();
    return list.slice(-50);
  }

  // ---------------------------------------------------------------------------------------------
  // Appel au modèle : réservation, masquage obligatoire, règlement
  // ---------------------------------------------------------------------------------------------

  private async callModel(identity: AsstIdentity, request: PlannerPromptRequest, st: LoopState): Promise<ModelOutcome> {
    const userId = identity.user.userId;
    const estimate = this.estimate(request);
    // `reserve` lève `AsstError` (budget dépassé, indisponible) : remontée telle quelle.
    const reservation = await this.reserve(userId, estimate);

    let result;
    try {
      // Requête construite champ par champ : jamais de pièce jointe binaire.
      result = await this.ai.run<AsstTurn>({
        task: GedAiTask.Autre,
        request: {
          system: request.system,
          text: request.text,
          jsonSchema: request.jsonSchema,
          strictSchema: false,
          maxOutputTokens: request.maxOutputTokens,
        },
        parse: parseAsstTurn,
        promptVersion: PLANNER_PROMPT_VERSION,
        requestedBy: identity.principal.userGroupId,
        autoApply: false,
        documentId: null,
      });
    } catch (e) {
      if (e instanceof AiMaskingRequiredError) {
        // Refus AVANT tout envoi : aucun appel, réservation libérée ; jamais de repli sans masquage.
        await this.release(reservation);
        throw new AsstError('assistant_unavailable', MSG_MASKING);
      }
      if (e instanceof AiUnsupportedInputError) {
        await this.release(reservation);
        throw new AsstError('assistant_unavailable', MSG_UNAVAILABLE);
      }
      // L'appel est parti : le coût est engagé, l'estimation est soldée (prudent).
      await this.settle(reservation, estimate, st);
      if (e instanceof AsstTurnError) return { kind: 'invalid' };
      this.logger.warn(`Appel au modèle de l’assistant en échec (${errorName(e)}).`);
      throw new AsstError('assistant_unavailable', MSG_UNAVAILABLE);
    }

    if (result.disabled) {
      await this.release(reservation);
      throw new AsstError('assistant_unavailable', MSG_AI_DISABLED);
    }
    await this.settle(reservation, this.actualUsage(result) ?? estimate, st);
    if (result.decisionId !== null && result.decisionId !== undefined) st.aiDecisionId = result.decisionId.toString();
    return { kind: 'turn', turn: result.data };
  }

  /** Estimation prudente : entrée ≈ caractères / 3, sortie = plafond. Tarif illisible = indisponible (échec fermé). */
  private estimate(request: PlannerPromptRequest): AgentUsage {
    const promptTokens = Math.ceil((request.system.length + request.text.length) / 3);
    const completionTokens = request.maxOutputTokens;
    return { promptTokens, completionTokens, cost: this.costOf(promptTokens, completionTokens) };
  }

  private costOf(promptTokens: number, completionTokens: number): number {
    let cost: number;
    try {
      cost = this.wfGate.costOf({ promptTokens, completionTokens });
    } catch (e) {
      this.logger.warn(`Tarif des jetons illisible (${errorName(e)}).`);
      throw new AsstError('assistant_unavailable', MSG_UNAVAILABLE);
    }
    if (!Number.isFinite(cost) || cost < 0) throw new AsstError('assistant_unavailable', MSG_UNAVAILABLE);
    return cost;
  }

  /** Jetons réels du fournisseur s'ils sont exposés ; sinon `null` (=> estimation). */
  private actualUsage(result: object): AgentUsage | null {
    const r = result as { promptTokens?: unknown; completionTokens?: unknown };
    const p = r.promptTokens;
    const c = r.completionTokens;
    if (typeof p !== 'number' || typeof c !== 'number' || !Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) {
      return null;
    }
    try {
      const cost = this.wfGate.costOf({ promptTokens: p, completionTokens: c });
      return Number.isFinite(cost) && cost >= 0 ? { promptTokens: p, completionTokens: c, cost } : null;
    } catch {
      return null;
    }
  }

  private async reserve(userId: number, estimate: AgentUsage): Promise<AsstReservation> {
    try {
      return await this.gate.reserve(userId, estimate);
    } catch (e) {
      if (e instanceof AsstError) throw e;
      this.logger.warn(`Réservation budgétaire de l’assistant impossible (${errorName(e)}).`);
      throw new AsstError('assistant_unavailable', MSG_UNAVAILABLE);
    }
  }

  private async settle(reservation: AsstReservation, usage: AgentUsage, st: LoopState): Promise<void> {
    addUsage(st.usage, usage);
    try {
      await this.gate.settle(reservation, usage);
    } catch (e) {
      // La réservation reste comptée (surestimation prudente).
      this.logger.warn(`Règlement de la réservation de l’assistant impossible (${errorName(e)}).`);
    }
  }

  private async release(reservation: AsstReservation): Promise<void> {
    try {
      await this.gate.release(reservation);
    } catch (e) {
      this.logger.warn(`Libération de la réservation de l’assistant impossible (${errorName(e)}).`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Outils de lecture
  // ---------------------------------------------------------------------------------------------

  private async runTool(toolbox: PlannerToolbox, tool: string, args: Record<string, unknown>, st: LoopState): Promise<void> {
    if (st.toolCalls >= PLANNER_MAX_TOOL_CALLS) {
      // Plafond atteint : l'outil n'est PAS exécuté ; le modèle est prié de conclure (les tours restent bornés).
      st.toolHistory.push({ tool, ok: false, arguments: args, output: MSG_TOOL_CAP });
      return;
    }
    st.toolCalls++;
    const seenBefore = toolbox.evidence.untrustedTexts.length;
    // La boîte à outils ne connaît QUE les outils de lecture : un outil d'action (« proposer_… ») ou inconnu est
    // refusé sans exécution (`ok: false`), elle ne lève jamais.
    const result = await toolbox.call(tool, args);
    st.toolHistory.push({ tool, ok: result.ok, arguments: args, output: result.output });
    const fresh = toolbox.evidence.untrustedTexts.slice(seenBefore);
    if (detectPlannerInjection(collectStrings(result.output)) || fresh.some((t) => detectPlannerInjection(t))) {
      st.dataSuspicion = true;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Conclusions
  // ---------------------------------------------------------------------------------------------

  /**
   * Résultat texte (aucune action). Une réponse qui n'est PAS une question de précision construite par le code
   * (`marked`) est privée de tout caractère du marqueur : un texte du modèle ne peut jamais faire apparaître de boutons
   * ni passer pour une question au rechargement. Une question marquée est vérifiée (relecture identique).
   */
  private textResult(
    st: LoopState,
    reply: string,
    clarification: AsstClarificationDto | null = null,
    marked = false,
  ): AsstPlanResult {
    let text = truncateSafe(reply, ASST_ASSISTANT_MESSAGE_MAX_CHARS);
    let clar = clarification;
    if (!marked || !isClarificationContent(text)) {
      text = stripClarificationMarker(text);
      clar = null;
    } else if (clar !== null && JSON.stringify(parseClarificationContent(text)) !== JSON.stringify(clar)) {
      clar = null;
    }
    return {
      reply: text,
      actions: [],
      summary: null,
      clarification: clar,
      usage: { ...st.usage },
      aiDecisionId: st.aiDecisionId,
    };
  }

  /**
   * Texte libre du modèle (réponse ou question) : jamais si un jeton y figure ; jamais s'il REVENDIQUE une action
   * (rien n'est appliqué sans confirmation : phrase fixe du code) ; averti si la requête est suspecte.
   */
  private modelText(st: LoopState, text: string): string {
    if (st.nonces.some((n) => containsNonce(text, n))) return PLANNER_MSG_LEAK;
    const shown = claimsActionDone(text) ? PLANNER_MSG_ACTION_CLAIM : text;
    return st.dataSuspicion ? `${PLANNER_MSG_SUSPICION_WARNING}\n\n${shown}` : shown;
  }

  private clarifyResult(st: LoopState, question: string, rawChoices: readonly string[]): AsstPlanResult {
    if (rawChoices.some((c) => st.nonces.some((n) => containsNonce(c, n)))) return this.textResult(st, PLANNER_MSG_LEAK);
    if (claimsActionDone(question) || rawChoices.some((c) => claimsActionDone(c))) {
      return this.textResult(st, this.modelText(st, PLANNER_MSG_ACTION_CLAIM));
    }
    const text = this.modelText(st, question);
    if (text === PLANNER_MSG_LEAK) return this.textResult(st, PLANNER_MSG_LEAK);
    // Requête suspecte : pas de boutons de choix (un choix dicté par une donnée ne doit pas devenir un ordre d'un clic),
    // et pas de marqueur : la réponse suivante de l'utilisateur ne fera pas revivre un ordre antérieur.
    if (st.dataSuspicion) return this.textResult(st, text);
    const choices: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawChoices) {
      const c = raw.trim();
      const key = c.toLocaleLowerCase('fr');
      if (c.length === 0 || Array.from(c).length > PLANNER_CHOICE_LABEL_MAX_CHARS || seen.has(key)) continue;
      seen.add(key);
      choices.push(c);
    }
    const questionOnly = (): AsstPlanResult => this.textResult(st, formatClarificationQuestion(question), null, true);
    if (choices.length < PLANNER_CHOICES_MIN || choices.length > PLANNER_CHOICES_MAX) return questionOnly();
    const content = formatClarificationContent(question, choices);
    const parsed = asstClarificationSchema.safeParse({ question, choices });
    const reread = parseClarificationContent(content);
    if (!parsed.success || reread === null || Array.from(content).length > ASST_ASSISTANT_MESSAGE_MAX_CHARS) {
      return questionOnly();
    }
    return this.textResult(st, content, reread, true);
  }

  private async proposeResult(
    st: LoopState,
    turn: Extract<AsstTurn, { type: 'propose' }>,
    ctx: {
      identity: AsstIdentity;
      userMessage: string;
      previousUserMessages: string[];
      pageContext: AsstPlanInput['pageContext'];
      toolbox: PlannerToolbox;
      now: Date;
      maxActions: number;
    },
  ): Promise<AsstPlanResult> {
    // Portes, dans cet ordre, échec fermé.
    // (1) le modèle lui-même signale une consigne détournée ;
    if (turn.suspicion === true) return this.textResult(st, PLANNER_MSG_DATA_SUSPICION);
    // (2) l'intention ne vient pas du message de l'utilisateur ;
    if (turn.intentSource !== 'message_utilisateur') return this.textResult(st, PLANNER_MSG_EXTERNAL_INTENT);
    // (3) une consigne détournée a été vue pendant cette requête ;
    if (st.dataSuspicion) return this.textResult(st, PLANNER_MSG_DATA_SUSPICION);

    // (4) validateur : recalcule tout depuis le message de l'utilisateur et ce que les outils ont réellement renvoyé.
    const outcome: ActionValidationOutcome = await this.validator.validate({
      identity: ctx.identity,
      userMessage: ctx.userMessage,
      previousUserMessages: ctx.previousUserMessages,
      pageContext: ctx.pageContext ?? null,
      evidence: ctx.toolbox.evidence,
      rawActions: turn.actions,
      draftGenerator: (request) => this.generateDraft(ctx.identity, request, st),
      now: ctx.now,
      maxActions: ctx.maxActions,
    });

    if (!outcome.ok) {
      if (outcome.kind !== 'clarify') return this.textResult(st, outcome.message);
      // Question du validateur (texte construit par le code) : avec choix, déjà marquée ; sinon marquée ici comme
      // question sans choix, pour que la réponse de l'utilisateur soit lue comme la réponse à cette question.
      const clarification = parseClarificationContent(outcome.message);
      if (clarification) return this.textResult(st, outcome.message, clarification, true);
      return this.textResult(st, formatClarificationQuestion(outcome.message), null, true);
    }

    // Dernier contrôle : schéma strict des actions de l'assistant et résumé présent.
    const checked = asstProposedActionsSchema.safeParse(outcome.actions);
    const summary = typeof outcome.summary === 'string' ? outcome.summary.trim() : '';
    if (!checked.success || summary.length === 0) return this.textResult(st, PLANNER_MSG_PROPOSAL_INVALID);
    const actions: AsstProposedAction[] = checked.data;
    // Réponse CONSTRUITE PAR LE CODE : aucun texte du modèle (et jamais de marqueur de question).
    const reply = stripClarificationMarker(
      truncateSafe(`${PLANNER_PROPOSAL_INTRO}\n${summary}\n${PLANNER_PROPOSAL_OUTRO}`, ASST_ASSISTANT_MESSAGE_MAX_CHARS),
    );
    return {
      reply,
      actions,
      summary,
      clarification: null,
      usage: { ...st.usage },
      aiDecisionId: st.aiDecisionId,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // d. Génération d'un brouillon, BUDGÉTÉE (réservation avant, règlement ou libération après)
  // ---------------------------------------------------------------------------------------------

  private async generateDraft(
    identity: AsstIdentity,
    request: { templateId: string; instruction: string; mailId?: number },
    st: LoopState,
  ): Promise<PlannerDraftResult> {
    let estimate: AgentUsage;
    let reservation: AsstReservation;
    try {
      estimate = {
        promptTokens: PLANNER_DRAFT_ESTIMATE_PROMPT_TOKENS,
        completionTokens: PLANNER_DRAFT_ESTIMATE_COMPLETION_TOKENS,
        cost: this.costOf(PLANNER_DRAFT_ESTIMATE_PROMPT_TOKENS, PLANNER_DRAFT_ESTIMATE_COMPLETION_TOKENS),
      };
      reservation = await this.reserve(identity.user.userId, estimate);
    } catch (e) {
      // Porte refusée : aucune génération (le modèle n'est jamais appelé sans réservation).
      return { status: 'refused', message: e instanceof AsstError ? e.message : MSG_DRAFT_UNAVAILABLE };
    }

    let result: PlannerDraftResult;
    try {
      result = await this.data.generateDraft(identity.user, request, identity.principal.userGroupId);
    } catch (e) {
      await this.release(reservation);
      this.logger.warn(`Génération du brouillon en échec (${errorName(e)}).`);
      return { status: 'refused', message: MSG_DRAFT_UNAVAILABLE };
    }
    if (result.status === 'ok') {
      await this.settle(reservation, estimate, st);
    } else {
      // Rédaction désactivée ou refusée (droits, demande invalide) : rien n'est compté.
      await this.release(reservation);
    }
    return result;
  }
}
