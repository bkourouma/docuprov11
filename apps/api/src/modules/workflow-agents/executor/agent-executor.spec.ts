import type { WfExecutorContext } from '../../workflows/engine/engine.types';
import {
  AgentBlockedError,
  AgentIdentityError,
  type AgentRunOutput,
  type WfAgentRunner,
} from '../agent.contracts';
import type { AgentConfigLoader, LoadedAgentConfig } from '../agent-config.loader';
import type { AutonomyEligibilityService } from '../eval/autonomy-eligibility.service';
import { AgentTaskExecutor, buildUntrustedBlocks } from './agent-executor';

const config = (over: Partial<LoadedAgentConfig> = {}): LoadedAgentConfig => ({
  definitionId: 7,
  definitionVersionId: 70,
  stepKey: 'trier',
  objective: 'Trier le courrier',
  autonomy: 1,
  confidenceThreshold: 0.8,
  model: null,
  maxSteps: 5,
  maxCostPerRun: null,
  timeoutSeconds: 60,
  evalSetId: null,
  allowedToolKeys: ['lire_courrier'],
  rejectedToolKeys: [],
  maxCallsByTool: { lire_courrier: 3 },
  specHash: 'h',
  ...over,
});

const run = (over: Partial<AgentRunOutput> = {}): AgentRunOutput => ({
  outcome: 'final',
  result: { service: 'RH' },
  explanation: 'Courrier relatif aux congés.',
  confidence: 0.93,
  sources: [{ kind: 'mail', id: 5 }],
  preparedActions: [],
  suspicionInjection: false,
  suspicionReasons: [],
  audit: {
    instruction: 'Trier le courrier',
    model: 'm',
    aiDecisionIds: ['11', '12'],
    promptTokens: 100,
    completionTokens: 20,
    costAmount: 1.5,
    steps: 2,
    toolCalls: [],
  },
  ...over,
});

const ctx: WfExecutorContext = {
  instanceId: '9',
  taskId: '90',
  attempt: 1,
  step: { key: 'trier', name: 'Trier', type: 'agent', next: [] } as unknown as WfExecutorContext['step'],
  context: { input: { courrier: 5 } },
  runAs: { userGroupId: 42 },
  definitionId: 7,
  definitionVersionId: 70,
  subject: { type: 'mail', id: '5' },
};

function make(over: {
  config?: LoadedAgentConfig | null;
  run?: AgentRunOutput;
  eligible?: boolean;
  gate?: () => Promise<void>;
  identity?: () => Promise<unknown>;
} = {}) {
  const runner: WfAgentRunner = { run: jest.fn().mockResolvedValue(over.run ?? run()) };
  const loader = { load: jest.fn().mockResolvedValue(over.config === undefined ? config() : over.config) };
  const identity = {
    resolve: jest.fn(over.identity ?? (() => Promise.resolve({ principal: {}, user: { userId: 1 } }))),
  };
  const gate = { assertRunnable: jest.fn(over.gate ?? (() => Promise.resolve())) };
  const sink = { countToolCalls: jest.fn().mockResolvedValue(1), append: jest.fn() };
  const eligibility = { check: jest.fn().mockResolvedValue({ eligible: over.eligible ?? false }) };
  const executor = new AgentTaskExecutor(
    identity as never,
    runner,
    gate as never,
    sink as never,
    loader as unknown as AgentConfigLoader,
    eligibility as unknown as AutonomyEligibilityService,
  );
  return { executor, runner, loader, identity, gate, sink, eligibility };
}

describe('AgentTaskExecutor', () => {
  it('niveau 1 : propose (jamais complete), avec audit et sources', async () => {
    const { executor, runner } = make();
    const out = await executor.execute(ctx);
    expect(out.kind).toBe('propose');
    if (out.kind !== 'propose') return;
    expect((out.proposal as { mode: string }).mode).toBe('action');
    expect(out.confidence).toBe(0.93);
    expect(out.audit?.autonomyLevel).toBe(1);
    expect(out.audit?.aiDecisionId).toBe('12');
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'live', requestedBy: 42, spec: expect.objectContaining({ remainingToolCalls: { lire_courrier: 2 } }) }),
    );
  });

  it('niveau 0 : proposition de suggestion, actions seulement suggérées', async () => {
    const action = { tool: 'proposer_imputation', arguments: {}, sideEffect: 1 as const, requiresValidation: true, preview: 'x' };
    const { executor } = make({ config: config({ autonomy: 0 }), run: run({ preparedActions: [action] }) });
    const out = await executor.execute(ctx);
    if (out.kind !== 'propose') throw new Error('proposition attendue');
    const p = out.proposal as Record<string, unknown>;
    expect(p.mode).toBe('suggestion');
    expect(p.suggestedActions).toHaveLength(1);
    expect(p.preparedActions).toBeUndefined();
  });

  it('autonome éligible sans action : complete ; non éligible : propose', async () => {
    const eligible = make({ config: config({ autonomy: 2 }), eligible: true });
    expect((await eligible.executor.execute(ctx)).kind).toBe('complete');
    expect(eligible.eligibility.check).toHaveBeenCalledWith(70, 'trier');
    const notEligible = make({ config: config({ autonomy: 2 }), eligible: false });
    expect((await notEligible.executor.execute(ctx)).kind).toBe('propose');
  });

  it('sous le seuil de confiance : retour à l’humain, jamais d’action seule, quel que soit le niveau', async () => {
    const { executor } = make({ config: config({ autonomy: 2 }), run: run({ confidence: 0.5 }), eligible: true });
    const out = await executor.execute(ctx);
    expect(out.kind).toBe('wait');
    if (out.kind === 'wait') expect(out.escalation?.reason).toBe('low_confidence');
  });

  it('suspicion d’injection : proposition signalée, jamais complete', async () => {
    const { executor } = make({
      config: config({ autonomy: 2 }),
      run: run({ suspicionInjection: true, suspicionReasons: ['entree:ignorer_consignes'] }),
      eligible: true,
    });
    const out = await executor.execute(ctx);
    if (out.kind !== 'propose') throw new Error('proposition attendue');
    expect((out.proposal as { suspicion_injection: boolean }).suspicion_injection).toBe(true);
  });

  it.each(['ai_disabled', 'emergency_stop_global', 'emergency_stop_workflow', 'budget_exceeded_global', 'budget_unavailable'] as const)(
    'garde « %s » : retour à l’humain sans appel modèle ni lecture d’identité',
    async (reason) => {
      const { executor, runner, identity } = make({ gate: () => Promise.reject(new AgentBlockedError(reason, 'x')) });
      const out = await executor.execute(ctx);
      expect(out.kind).toBe('wait');
      if (out.kind === 'wait') expect(out.escalation?.reason).toBe(reason);
      expect(runner.run).not.toHaveBeenCalled();
      expect(identity.resolve).not.toHaveBeenCalled();
    },
  );

  it('lanceur désactivé ou sans droit : l’agent s’arrête et la tâche retourne à l’humain', async () => {
    const { executor, runner } = make({ identity: () => Promise.reject(new AgentIdentityError('disabled', 'x')) });
    const out = await executor.execute(ctx);
    expect(out.kind).toBe('wait');
    if (out.kind === 'wait') expect(out.escalation?.reason).toBe('identity_disabled');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('arrêt du runner (budget en cours de route) : retour à l’humain avec la raison', async () => {
    const stopped = run({ outcome: 'stopped', stopReason: 'emergency_stop_global', result: null, confidence: null });
    const { executor } = make({ run: stopped });
    const out = await executor.execute(ctx);
    if (out.kind !== 'wait') throw new Error('attente attendue');
    expect(out.escalation?.reason).toBe('emergency_stop_global');
    expect(out.escalation?.audit?.costAmount).toBe(1.5);
  });

  it("arrêt d'urgence posé PENDANT le dernier appel modèle : un niveau 2 éligible n'agit pas seul, retour à l'humain", async () => {
    let calls = 0;
    const { executor } = make({
      config: config({ autonomy: 2 }),
      eligible: true,
      gate: () => (++calls === 1 ? Promise.resolve() : Promise.reject(new AgentBlockedError('emergency_stop_global', 'x'))),
    });
    const out = await executor.execute(ctx);
    expect(out.kind).toBe('wait');
    if (out.kind === 'wait') {
      expect(out.escalation?.reason).toBe('emergency_stop_global');
      expect(out.escalation?.audit?.costAmount).toBe(1.5);
    }
    expect(calls).toBe(2);
  });

  it("arrêt d'urgence pendant le dernier appel : une proposition (niveau 1) n'est pas déposée non plus", async () => {
    let calls = 0;
    const { executor } = make({
      gate: () => (++calls === 1 ? Promise.resolve() : Promise.reject(new AgentBlockedError('emergency_stop_workflow', 'x'))),
    });
    const out = await executor.execute(ctx);
    expect(out.kind).toBe('wait');
  });

  it('lanceur désactivé PENDANT le dernier appel modèle : jamais complete, retour à l’humain', async () => {
    let calls = 0;
    const { executor, identity } = make({
      config: config({ autonomy: 2 }),
      eligible: true,
      identity: () =>
        ++calls === 1
          ? Promise.resolve({ principal: {}, user: { userId: 1 } })
          : Promise.reject(new AgentIdentityError('disabled', 'x')),
    });
    const out = await executor.execute(ctx);
    expect(out.kind).toBe('wait');
    if (out.kind === 'wait') expect(out.escalation?.reason).toBe('identity_disabled');
    expect(identity.resolve).toHaveBeenCalledTimes(2);
  });

  it("outils écartés à l'exécution : signalés dans la décision de l'audit", async () => {
    const { executor } = make({ config: config({ rejectedToolKeys: ['envoyer_courrier'] }) });
    const out = await executor.execute(ctx);
    if (out.kind !== 'propose') throw new Error('proposition attendue');
    expect((out.audit?.decision as { rejectedTools?: string[] }).rejectedTools).toEqual(['envoyer_courrier']);
  });

  it('configuration absente ou erreur inattendue : retour à l’humain, ne lève jamais', async () => {
    expect((await make({ config: null }).executor.execute(ctx)).kind).toBe('wait');
    const boom = make();
    boom.runner.run = jest.fn().mockRejectedValue(new Error('x'));
    expect((await boom.executor.execute(ctx)).kind).toBe('wait');
  });

  it('les blocs de données reprennent le contexte et l’objet lié, jamais comme consignes', () => {
    const blocks = buildUntrustedBlocks(ctx);
    expect(blocks.every((b) => b.origin === 'context')).toBe(true);
    expect(blocks.map((b) => b.label)).toEqual(expect.arrayContaining(['Données de lancement', 'Objet lié']));
  });
});
