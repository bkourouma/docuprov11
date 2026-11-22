import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  WfAgentAudit,
  WfExecutorContext,
  WfExecutorOutcome,
  WfTaskExecutor,
} from '../../workflows/engine/engine.types';
import {
  AgentBlockedError,
  AgentIdentityError,
  WF_AGENT_EVENT_SINK,
  WF_AGENT_GATE,
  WF_AGENT_IDENTITY,
  WF_AGENT_RUNNER,
  type AgentRunOutput,
  type AgentUntrustedBlock,
  type WfAgentEventSink,
  type WfAgentGate,
  type WfAgentIdentityPort,
  type WfAgentRunner,
} from '../agent.contracts';
import { AgentConfigLoader, type LoadedAgentConfig } from '../agent-config.loader';
import { decideDisposition, type AgentDisposition } from '../disposition';
import { AutonomyEligibilityService } from '../eval/autonomy-eligibility.service';

const CONTEXT_BLOCK_MAX_CHARS = 8000;

/** Libellés (français) des retours à l'humain, par raison. Jamais de contenu de document. */
const ESCALATION_TEXT: Record<string, string> = {
  ai_disabled: "L'IA est désactivée : le workflow fonctionne en mode humain, la tâche est confiée à son bénéficiaire.",
  emergency_stop_global: "Arrêt d'urgence global actif : l'agent n'a pas travaillé, la tâche est confiée à son bénéficiaire.",
  emergency_stop_workflow: "Arrêt d'urgence de ce workflow actif : l'agent n'a pas travaillé, la tâche est confiée à son bénéficiaire.",
  budget_exceeded_global: 'Plafond de coût global atteint : tâche confiée à son bénéficiaire.',
  budget_exceeded_workflow: 'Plafond de coût du workflow atteint : tâche confiée à son bénéficiaire.',
  budget_unavailable: 'Budget illisible (échec fermé) : tâche confiée à son bénéficiaire.',
  low_confidence: "Confiance de l'agent sous le seuil de l'étape : aucune action seule, tâche confiée à son bénéficiaire.",
  stopped: "L'agent n'a pas pu conclure : tâche confiée à son bénéficiaire.",
  config_missing: "Configuration d'agent introuvable pour cette étape : tâche confiée à son bénéficiaire.",
  identity_not_found: "Le lanceur est introuvable : l'agent s'arrête, tâche confiée à son bénéficiaire.",
  identity_disabled: "Le compte du lanceur est désactivé : l'agent s'arrête, tâche confiée à son bénéficiaire.",
  identity_no_launch_right: "Le lanceur n'a plus le droit de lancer ce workflow : l'agent s'arrête, tâche confiée à son bénéficiaire.",
  identity_invalid: "Identité du lanceur invalide : l'agent s'arrête, tâche confiée à son bénéficiaire.",
  error: "Erreur inattendue de l'agent : tâche confiée à son bénéficiaire.",
};

/**
 * Exécuteur du type de tâche « agent » (appelé par le moteur APRÈS commit, dans l'api). Il ne décide pas seul
 * de l'effet : il traduit le résultat du runner en issue moteur (`complete` / `propose` / `wait`) selon
 * `decideDisposition`, et le moteur journalise l'issue DANS la transaction qui l'applique.
 *
 * Garanties : droits du lanceur relus en base (compte désactivé ou droit retiré => retour à l'humain),
 * arrêt d'urgence / plafond / IA désactivée => retour à l'humain sans appel modèle, niveau « autonome »
 * revérifié en base à chaque exécution, jamais d'action seule sous le seuil de confiance. Ne lève jamais.
 */
@Injectable()
export class AgentTaskExecutor implements WfTaskExecutor {
  readonly taskType = 'agent';
  private readonly logger = new Logger(AgentTaskExecutor.name);

  constructor(
    @Inject(WF_AGENT_IDENTITY) private readonly identity: WfAgentIdentityPort,
    @Inject(WF_AGENT_RUNNER) private readonly runner: WfAgentRunner,
    @Inject(WF_AGENT_GATE) private readonly gate: WfAgentGate,
    @Inject(WF_AGENT_EVENT_SINK) private readonly sink: WfAgentEventSink,
    private readonly loader: AgentConfigLoader,
    private readonly eligibility: AutonomyEligibilityService,
  ) {}

  async execute(ctx: WfExecutorContext): Promise<WfExecutorOutcome> {
    try {
      return await this.run(ctx);
    } catch (err) {
      this.logger.error(`exécuteur agent en échec (tâche ${ctx.taskId}) : ${err instanceof Error ? err.name : 'erreur inconnue'}`);
      return escalate('error');
    }
  }

  private async run(ctx: WfExecutorContext): Promise<WfExecutorOutcome> {
    const config = await this.loader.load(ctx.definitionVersionId, ctx.step.key);
    if (!config) return escalate('config_missing');

    // 1. Arrêt d'urgence, IA désactivée, budget : AVANT toute identité ou lecture.
    try {
      await this.gate.assertRunnable({ definitionId: config.definitionId });
    } catch (err) {
      if (err instanceof AgentBlockedError) return escalate(err.reason);
      throw err;
    }

    // 2. Identité du lanceur, relue en base.
    let identity;
    try {
      identity = await this.identity.resolve(ctx.runAs.userGroupId);
    } catch (err) {
      if (err instanceof AgentIdentityError) return escalate(`identity_${err.code}`);
      throw err;
    }

    // 3. Plafonds d'appels d'outils restants pour cette instance.
    const remainingToolCalls: Record<string, number> = {};
    for (const tool of config.allowedToolKeys) {
      const max = config.maxCallsByTool[tool];
      if (max === null || max === undefined) continue;
      remainingToolCalls[tool] = Math.max(0, max - (await this.sink.countToolCalls(ctx.instanceId, tool)));
    }

    const run = await this.runner.run({
      mode: 'live',
      scope: {
        definitionId: config.definitionId,
        instanceId: ctx.instanceId,
        taskId: ctx.taskId,
        stepKey: ctx.step.key,
        subject: ctx.subject,
      },
      spec: {
        objective: config.objective,
        autonomy: config.autonomy,
        confidenceThreshold: config.confidenceThreshold,
        allowedToolKeys: config.allowedToolKeys,
        remainingToolCalls,
        model: config.model,
        maxSteps: config.maxSteps,
        maxCostPerRun: config.maxCostPerRun,
        timeoutSeconds: config.timeoutSeconds,
      },
      identity,
      untrusted: buildUntrustedBlocks(ctx),
      requestedBy: ctx.runAs.userGroupId,
    });

    // 4. Niveau « autonome » : éligibilité relue en base à chaque exécution (faible risque + run réussi).
    const autonomousEligible =
      config.autonomy === 2 ? (await this.eligibility.check(config.definitionVersionId, ctx.step.key)).eligible : false;
    const disposition = decideDisposition({
      autonomy: config.autonomy,
      confidenceThreshold: config.confidenceThreshold,
      run,
      autonomousEligible,
    });
    const outcome = toOutcome(config, run, disposition);
    if (outcome.kind === 'wait') return outcome;

    // 5. Dernier contrôle JUSTE AVANT d'agir (complete) ou de proposer : un arrêt d'urgence, un plafond ou un
    // lanceur désactivé survenus pendant le dernier appel modèle ne doivent jamais laisser l'agent conclure.
    const audit = toAudit(config, run, disposition);
    try {
      await this.gate.assertRunnable({ definitionId: config.definitionId });
    } catch (err) {
      if (err instanceof AgentBlockedError) return escalate(err.reason, audit);
      throw err;
    }
    try {
      await this.identity.resolve(ctx.runAs.userGroupId);
    } catch (err) {
      if (err instanceof AgentIdentityError) return escalate(`identity_${err.code}`, audit);
      throw err;
    }
    return outcome;
  }
}

/** Retour à l'humain : la tâche passe à son bénéficiaire ; le moteur journalise `agent.escalated` (même transaction). */
function escalate(reason: string, audit?: WfAgentAudit, extra?: string): WfExecutorOutcome {
  const base = ESCALATION_TEXT[reason] ?? `Retour à l'humain (${reason}).`;
  return {
    kind: 'wait',
    escalation: { reason, explanation: extra ? `${base} ${extra}` : base, ...(audit ? { audit } : {}) },
  };
}

function toAudit(
  config: LoadedAgentConfig,
  run: AgentRunOutput,
  disposition: AgentDisposition,
): WfAgentAudit {
  const lastDecision = run.audit.aiDecisionIds[run.audit.aiDecisionIds.length - 1];
  return {
    instruction: run.audit.instruction,
    sources: run.sources,
    decision: {
      disposition: disposition.kind,
      reason: 'reason' in disposition ? disposition.reason : null,
      stopReason: run.stopReason ?? null,
      suspicion_injection: run.suspicionInjection,
      suspicionReasons: run.suspicionReasons,
      aiDecisionIds: run.audit.aiDecisionIds,
      steps: run.audit.steps,
      toolCalls: run.audit.toolCalls,
      preparedActions: run.preparedActions.map((a) => ({ tool: a.tool, sideEffect: a.sideEffect, preview: a.preview })),
      threshold: config.confidenceThreshold,
      // Outils déclarés par l'étape mais écartés à l'exécution (inconnus, désactivés ou non autorisés).
      ...(config.rejectedToolKeys.length > 0 ? { rejectedTools: config.rejectedToolKeys } : {}),
    },
    ...(run.confidence !== null ? { confidence: run.confidence } : {}),
    autonomyLevel: config.autonomy,
    model: run.audit.model,
    aiDecisionId: lastDecision ?? null,
    promptTokens: run.audit.promptTokens,
    completionTokens: run.audit.completionTokens,
    costAmount: run.audit.costAmount,
  };
}

export function toOutcome(config: LoadedAgentConfig, run: AgentRunOutput, disposition: AgentDisposition): WfExecutorOutcome {
  const audit = toAudit(config, run, disposition);
  if (disposition.kind === 'return_to_human') {
    const reason = run.outcome === 'stopped' && run.stopReason ? run.stopReason : disposition.reason;
    return escalate(reason, audit, run.explanation ? `Avis de l'agent (non appliqué) : ${run.explanation}` : undefined);
  }
  const result = run.result ?? {};
  if (disposition.kind === 'complete') {
    return { kind: 'complete', result, explanation: run.explanation, audit };
  }
  // Proposition (élément de boîte kind 1) : validée par un humain avant tout effet. Niveau 0 : les actions
  // ne sont que des SUGGESTIONS ; niveau 1 : actions préparées, appliquées seulement après validation.
  const proposal: Record<string, unknown> = {
    mode: config.autonomy === 0 ? 'suggestion' : 'action',
    result,
    ...(config.autonomy === 0 ? { suggestedActions: run.preparedActions } : { preparedActions: run.preparedActions }),
    suspicion_injection: run.suspicionInjection,
    ...(run.suspicionInjection ? { suspicion_reasons: run.suspicionReasons } : {}),
    autonomy: config.autonomy,
    reason: disposition.reason,
  };
  return {
    kind: 'propose',
    proposal,
    explanation: run.explanation,
    sources: run.sources,
    ...(run.confidence !== null ? { confidence: run.confidence } : {}),
    audit,
  };
}

/** Données non fiables transmises au modèle : contexte de l'instance et objet lié (jamais des consignes). */
export function buildUntrustedBlocks(ctx: WfExecutorContext): AgentUntrustedBlock[] {
  const blocks: AgentUntrustedBlock[] = [];
  const push = (label: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch {
      return;
    }
    if (!text || text === '{}' || text === '[]') return;
    blocks.push({ label, origin: 'context', text: text.slice(0, CONTEXT_BLOCK_MAX_CHARS) });
  };
  push('Données de lancement', (ctx.context as { input?: unknown }).input);
  push('Résultats des étapes précédentes', (ctx.context as { last?: unknown }).last);
  if (ctx.subject.type && ctx.subject.id) {
    blocks.push({ label: 'Objet lié', origin: 'context', text: `type: ${ctx.subject.type} ; identifiant: ${ctx.subject.id}` });
  }
  return blocks;
}
