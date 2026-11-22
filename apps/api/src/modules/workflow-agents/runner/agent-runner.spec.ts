import { GedAiTask } from '@archivage/types';
import { AiMaskingRequiredError, AiProviderError, AiUnsupportedInputError } from '../../ai/ai.types';
import { AgentBlockedError, WF_AGENT_PROMPT_VERSION } from '../agent.contracts';
import { decideDisposition } from '../disposition';
import { TOOL_FAILURE_OUTPUT } from './agent-runner';
import { BROKEN_TOOL_SECRET, final, makeHarness, makeInput, toolCall } from './agent-runner.fake';

describe('AgentRunner — parcours nominal', () => {
  it('outil puis conclusion : résultat, sources, audit, journal, budget', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'facture 12' }), final()]);
    const out = await h.runner.run(makeInput());

    expect(out.outcome).toBe('final');
    expect(out.stopReason).toBeUndefined();
    expect(out.result).toEqual({ decision: 'conforme' });
    expect(out.explanation).toBe('La facture 12 correspond à la commande.');
    expect(out.confidence).toBe(0.9);
    expect(out.sources).toEqual([{ kind: 'document', id: 12, label: 'Facture 12', excerpt: 'Montant : 1 250 \u20AC' }]);
    expect(out.suspicionInjection).toBe(false);
    expect(out.suspicionReasons).toEqual([]);
    expect(out.audit.steps).toBe(2);
    expect(out.audit.aiDecisionIds).toEqual(['1', '2']);
    expect(out.audit.model).toBe('modele-test');
    expect(out.audit.toolCalls).toEqual([
      expect.objectContaining({ tool: 'rechercher_documents', ok: true, sideEffect: 0, sourcesCount: 1 }),
    ]);
    expect(out.audit.toolCalls[0]?.argsHash).toMatch(/^[0-9a-f]{64}$/);

    // Outil exécuté avec l'identité du lanceur, en mode réel.
    expect(h.tools.search.execute).toHaveBeenCalledTimes(1);
    const [ctx, args] = h.tools.search.execute.mock.calls[0]!;
    expect(args).toEqual({ query: 'facture 12' });
    expect(ctx).toEqual({
      identity: makeInput().identity,
      instanceId: '900',
      taskId: '901',
      stepKey: 'analyse',
      subject: { type: 'mail', id: '44' },
      dryRun: false,
    });

    // Journal : un événement par appel d'outil exécuté, sans les arguments.
    expect(h.sink.append).toHaveBeenCalledTimes(1);
    expect(h.sink.events[0]).toMatchObject({
      instanceId: '900',
      taskId: '901',
      stepKey: 'analyse',
      eventType: 'agent.tool_called',
      decision: { tool: 'rechercher_documents', sideEffect: 0, ok: true, sourcesCount: 1 },
    });
    expect(JSON.stringify(h.sink.events[0])).not.toContain('facture 12');

    // Budget : une réservation par appel au modèle, toujours soldée.
    expect(h.gate.reserve).toHaveBeenCalledTimes(2);
    expect(h.gate.settle).toHaveBeenCalledTimes(2);
    expect(h.gate.release).not.toHaveBeenCalled();
  });

  it('options transmises à AiService.run', async () => {
    const h = makeHarness([final()]);
    await h.runner.run(makeInput());
    const opts = h.ai.calls[0]!;
    expect(opts).toMatchObject({
      task: GedAiTask.Autre,
      promptVersion: WF_AGENT_PROMPT_VERSION,
      requestedBy: 7,
      autoApply: false,
      documentId: null,
    });
    expect(Object.keys(opts.request).sort()).toEqual(['jsonSchema', 'maxOutputTokens', 'strictSchema', 'system', 'text']);
    expect(opts.request.attachments).toBeUndefined();
    expect('attachments' in opts.request).toBe(false);
    expect(opts.allowLocalAttachments).toBeUndefined();
  });

  it('audit.instruction : objectif et libellés, jamais le contenu des blocs', async () => {
    const h = makeHarness([final()]);
    const out = await h.runner.run(
      makeInput({ untrusted: [{ label: 'Courrier entrant', origin: 'mail', text: 'CONTENU-CONFIDENTIEL-42' }] }),
    );
    expect(out.audit.instruction).toContain('Vérifier la facture et proposer une réponse.');
    expect(out.audit.instruction).toContain('Courrier entrant');
    expect(out.audit.instruction).not.toContain('CONTENU-CONFIDENTIEL-42');
    const long = makeHarness([final()]);
    const out2 = await long.runner.run(makeInput({ spec: { objective: 'o'.repeat(5000) }, untrusted: [] }));
    expect(Array.from(out2.audit.instruction).length).toBeLessThanOrEqual(2000);
  });

  it('la sortie se combine avec decideDisposition (le runner ne décide pas de l’autonomie)', async () => {
    const h = makeHarness([final({ confidence: 0.95 })]);
    const out = await h.runner.run(makeInput({ spec: { autonomy: 2 } }));
    expect(decideDisposition({ autonomy: 2, confidenceThreshold: 0.8, run: out, autonomousEligible: false })).toEqual({
      kind: 'propose',
      reason: 'autonomy_not_eligible',
    });
  });
});

describe('AgentRunner — arrêt d’urgence et garde', () => {
  it('bloqué avant le run : aucun appel au modèle ni réservation', async () => {
    const h = makeHarness([final()]);
    h.gate.blockWith = new AgentBlockedError('emergency_stop_global', 'arrêt');
    const out = await h.runner.run(makeInput());
    expect(out).toMatchObject({ outcome: 'stopped', stopReason: 'emergency_stop_global', result: null, preparedActions: [] });
    expect(h.ai.run).not.toHaveBeenCalled();
    expect(h.gate.reserve).not.toHaveBeenCalled();
  });

  it('arrêt PENDANT le run (pendant un outil) : plus aucun appel au modèle', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'x' }), final(), final()]);
    h.tools.search.execute.mockImplementationOnce(async () => {
      h.gate.blockWith = new AgentBlockedError('emergency_stop_workflow', 'arrêt');
      return { output: {}, sources: [] };
    });
    const out = await h.runner.run(makeInput());
    expect(out).toMatchObject({ outcome: 'stopped', stopReason: 'emergency_stop_workflow' });
    expect(h.ai.run).toHaveBeenCalledTimes(1);
  });

  it('arrêt pendant l’appel au modèle : l’outil demandé n’est pas exécuté', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'x' }), final()]);
    h.ai.onCall = () => {
      h.gate.blockWith = new AgentBlockedError('emergency_stop_global', 'arrêt');
    };
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('emergency_stop_global');
    expect(h.tools.search.execute).not.toHaveBeenCalled();
    expect(h.ai.run).toHaveBeenCalledTimes(1);
    expect(h.gate.settle).toHaveBeenCalledTimes(1);
  });

  it('la garde se met à refuser au 2e pas : un seul appel au modèle', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'x' }), final()]);
    let checks = 0;
    h.gate.assertRunnable.mockImplementation(async () => {
      checks++;
      // 1 : initiale ; 2 : avant le 1er appel ; 3 : avant l'outil ; 4 : avant le 2e appel.
      if (checks >= 4) throw new AgentBlockedError('emergency_stop_global', 'arrêt');
    });
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('emergency_stop_global');
    expect(h.ai.run).toHaveBeenCalledTimes(1);
    expect(h.gate.reserve).toHaveBeenCalledTimes(1);
  });

  it('erreur de lecture de la garde : échec fermé (budget_unavailable)', async () => {
    const h = makeHarness([final()]);
    h.gate.assertRunnable.mockRejectedValueOnce(new Error('base indisponible'));
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('budget_unavailable');
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('IA désactivée signalée par la garde : ai_disabled sans appel', async () => {
    const h = makeHarness([final()]);
    h.gate.blockWith = new AgentBlockedError('ai_disabled', 'mode humain');
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('ai_disabled');
    expect(h.ai.run).not.toHaveBeenCalled();
  });
});

describe('AgentRunner — budget et plafonds', () => {
  it('réservation refusée : aucun appel au modèle', async () => {
    const h = makeHarness([final()]);
    h.gate.reserveError = new AgentBlockedError('budget_exceeded_workflow', 'plafond');
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('budget_exceeded_workflow');
    expect(h.ai.run).not.toHaveBeenCalled();
    expect(h.gate.settle).not.toHaveBeenCalled();
    expect(h.gate.release).not.toHaveBeenCalled();
  });

  it('réservation en erreur inattendue : budget_unavailable', async () => {
    const h = makeHarness([final()]);
    h.gate.reserveError = new Error('verrou');
    expect((await h.runner.run(makeInput())).stopReason).toBe('budget_unavailable');
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('estimation : jetons \u2248 caractères / 3 + plafond de sortie ; solde = estimation sans jetons du fournisseur', async () => {
    const h = makeHarness([final()]);
    const out = await h.runner.run(makeInput());
    const [scope, estimate] = h.gate.reserve.mock.calls[0]!;
    const req = h.ai.calls[0]!.request;
    expect(scope).toEqual({ definitionId: 5 });
    expect(estimate.promptTokens).toBe(Math.ceil((req.system.length + req.text.length) / 3));
    expect(estimate.completionTokens).toBe(req.maxOutputTokens);
    expect(estimate.cost).toBeCloseTo((estimate.promptTokens + estimate.completionTokens) * 0.001);
    const reservation = await h.gate.reserve.mock.results[0]!.value;
    expect(h.gate.settle).toHaveBeenCalledWith(reservation, estimate);
    expect(out.audit).toMatchObject({
      promptTokens: estimate.promptTokens,
      completionTokens: estimate.completionTokens,
      costAmount: estimate.cost,
    });
  });

  it('jetons réels exposés par le résultat : ils remplacent l’estimation', async () => {
    const h = makeHarness([{ raw: final(), promptTokens: 120, completionTokens: 30 }]);
    const out = await h.runner.run(makeInput());
    expect(h.gate.settle).toHaveBeenCalledWith(expect.anything(), {
      promptTokens: 120,
      completionTokens: 30,
      cost: expect.closeTo(0.15, 10),
    });
    expect(out.audit).toMatchObject({ promptTokens: 120, completionTokens: 30 });
    expect(out.audit.costAmount).toBeCloseTo(0.15);
  });

  it('coût par exécution : refus AVANT l’appel si l’estimation dépasse', async () => {
    const h = makeHarness([final()]);
    const out = await h.runner.run(makeInput({ spec: { maxCostPerRun: 0.01 } }));
    expect(out.stopReason).toBe('cost_per_run');
    expect(h.gate.reserve).not.toHaveBeenCalled();
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('coût par exécution : cumul des appels', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'x' }), final()]);
    h.gate.fixedCost = 1;
    const out = await h.runner.run(makeInput({ spec: { maxCostPerRun: 1.5 } }));
    expect(out.stopReason).toBe('cost_per_run');
    expect(h.ai.run).toHaveBeenCalledTimes(1);
    expect(out.audit.costAmount).toBe(1);
  });

  it('maxSteps : arrêt après le nombre de tours', async () => {
    const h = makeHarness(Array.from({ length: 10 }, () => toolCall('rechercher_documents', { query: 'x' })));
    const out = await h.runner.run(makeInput({ spec: { maxSteps: 3 } }));
    expect(out.stopReason).toBe('max_steps');
    expect(h.ai.run).toHaveBeenCalledTimes(3);
    expect(out.audit.steps).toBe(3);
  });

  it('maxSteps nul ou invalide : aucun appel', async () => {
    for (const maxSteps of [0, -1, Number.NaN]) {
      const h = makeHarness([final()]);
      const out = await h.runner.run(makeInput({ spec: { maxSteps } }));
      expect(out.stopReason).toBe('max_steps');
      expect(h.ai.run).not.toHaveBeenCalled();
    }
  });

  it('délai global (horloge) : l’outil demandé après échéance n’est pas exécuté', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'x' }), final()]);
    let t = 1_000_000;
    h.runner.now = () => t;
    h.ai.onCall = () => {
      t += 20_000;
    };
    const out = await h.runner.run(makeInput({ spec: { timeoutSeconds: 15 } }));
    expect(out.stopReason).toBe('timeout');
    expect(h.tools.search.execute).not.toHaveBeenCalled();
    expect(h.gate.settle).toHaveBeenCalledTimes(1);
  });

  it('délai global : un appel au modèle qui ne répond pas est abandonné, coût soldé', async () => {
    const h = makeHarness([{ hang: true }]);
    const out = await h.runner.run(makeInput({ spec: { timeoutSeconds: 0.05 } }));
    expect(out.stopReason).toBe('timeout');
    expect(h.gate.settle).toHaveBeenCalledTimes(1);
    expect(h.gate.release).not.toHaveBeenCalled();
  });

  it('délai invalide : arrêt sans appel', async () => {
    const h = makeHarness([final()]);
    expect((await h.runner.run(makeInput({ spec: { timeoutSeconds: 0 } }))).stopReason).toBe('timeout');
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('signal d’abandon : avant et pendant l’appel', async () => {
    const before = makeHarness([final()]);
    const c1 = new AbortController();
    c1.abort();
    expect((await before.runner.run(makeInput({ signal: c1.signal }))).stopReason).toBe('aborted');
    expect(before.ai.run).not.toHaveBeenCalled();

    const during = makeHarness([{ hang: true }]);
    const c2 = new AbortController();
    during.ai.onCall = () => setTimeout(() => c2.abort(), 5);
    expect((await during.runner.run(makeInput({ signal: c2.signal }))).stopReason).toBe('aborted');
    expect(during.gate.settle).toHaveBeenCalledTimes(1);
  });
});

describe('AgentRunner — erreurs de l’IA', () => {
  it('IA désactivée (AiService) : ai_disabled, réservation libérée', async () => {
    const h = makeHarness([{ disabled: true }]);
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('ai_disabled');
    expect(h.gate.release).toHaveBeenCalledTimes(1);
    expect(h.gate.settle).not.toHaveBeenCalled();
  });

  it('masquage obligatoire : échec fermé, réservation libérée', async () => {
    const h = makeHarness([{ error: new AiMaskingRequiredError('cloud sans masquage') }]);
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('masking_required');
    expect(h.gate.release).toHaveBeenCalledTimes(1);
    expect(h.gate.settle).not.toHaveBeenCalled();
  });

  it('erreur du fournisseur : provider_error, coût estimé soldé', async () => {
    const h = makeHarness([{ error: new AiProviderError('quota') }]);
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('provider_error');
    expect(h.gate.settle).toHaveBeenCalledTimes(1);
  });

  it('entrée non prise en charge : provider_error, réservation libérée', async () => {
    const h = makeHarness([{ error: new AiUnsupportedInputError('pdf') }]);
    expect((await h.runner.run(makeInput())).stopReason).toBe('provider_error');
    expect(h.gate.release).toHaveBeenCalledTimes(1);
  });

  it('erreur inconnue : provider_error, jamais d’exception', async () => {
    const h = makeHarness([{ error: new TypeError('boum') }]);
    await expect(h.runner.run(makeInput())).resolves.toMatchObject({ stopReason: 'provider_error' });
  });

  it('sortie non conforme : invalid_output, coût soldé', async () => {
    const h = makeHarness(['pas du JSON']);
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('invalid_output');
    expect(h.gate.settle).toHaveBeenCalledTimes(1);
  });

  it('panne d’une dépendance inattendue : jamais d’exception', async () => {
    const h = makeHarness([final()]);
    jest.spyOn(h.registry, 'describe').mockImplementation(() => {
      throw new Error('registre');
    });
    await expect(h.runner.run(makeInput())).resolves.toMatchObject({ outcome: 'stopped', stopReason: 'provider_error' });
  });
});

describe('AgentRunner — conclusion', () => {
  it('confiance : valeur gardée, hors bornes ou absente => null', async () => {
    const run = async (raw: string): Promise<number | null> =>
      (await makeHarness([raw]).runner.run(makeInput())).confidence;
    expect(await run(final({ confidence: 0.7 }))).toBe(0.7);
    expect(await run(final({ confidence: 1.5 }))).toBeNull();
    expect(await run(final({ confidence: -1 }))).toBeNull();
    expect(await run(final({ confidence: undefined }))).toBeNull();
  });

  it('sources : seules celles renvoyées par un outil, dans la version de l’outil', async () => {
    const h = makeHarness([
      toolCall('rechercher_documents', { query: 'x' }),
      final({
        sources: [
          { kind: 'document', id: 12, label: 'Libellé du modèle' },
          { kind: 'document', id: 99 },
          { kind: 'mail', id: 12 },
          { kind: 'document', id: 12 },
        ],
      }),
    ]);
    const out = await h.runner.run(makeInput());
    expect(out.sources).toEqual([{ kind: 'document', id: 12, label: 'Facture 12', excerpt: 'Montant : 1 250 \u20AC' }]);
  });

  it('sans outil appelé, aucune source citée ne survit', async () => {
    const out = await makeHarness([final()]).runner.run(makeInput());
    expect(out.sources).toEqual([]);
  });

  it('actions préparées : champs de sécurité imposés par le registre', async () => {
    const h = makeHarness([toolCall('preparer_reponse', { texte: 'Bonjour' }), final()]);
    const out = await h.runner.run(makeInput());
    expect(out.suspicionInjection).toBe(false);
    expect(out.preparedActions).toEqual([
      { tool: 'preparer_reponse', arguments: { texte: 'Bonjour' }, sideEffect: 1, requiresValidation: false, preview: 'Répondre au courrier.' },
    ]);
  });

  it('un arrêt ne conserve jamais d’action préparée', async () => {
    const h = makeHarness([toolCall('preparer_reponse', { texte: 'Bonjour' }), 'invalide']);
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('invalid_output');
    expect(out.preparedActions).toEqual([]);
  });
});

describe('AgentRunner — outils', () => {
  it('mode dry_run : outil en évaluation, aucun journal', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'x' }), final()]);
    const out = await h.runner.run(
      makeInput({ mode: 'dry_run', scope: { definitionId: 5, stepKey: 'analyse' }, spec: { remainingToolCalls: { rechercher_documents: 3 } } }),
    );
    expect(out.outcome).toBe('final');
    const [ctx] = h.tools.search.execute.mock.calls[0]!;
    expect(ctx).toMatchObject({ dryRun: true, instanceId: null, taskId: null, subject: { type: null, id: null } });
    expect(h.sink.append).not.toHaveBeenCalled();
    expect(h.sink.countToolCalls).not.toHaveBeenCalled();
  });

  it('evalContext : transmis aux outils en dry_run seulement', async () => {
    const evalContext = { delegates: [{ userGroupId: 8 }] };
    const h = makeHarness([toolCall('rechercher_documents', { query: 'x' }), final()]);
    await h.runner.run(
      makeInput({
        mode: 'dry_run',
        scope: { definitionId: 5, stepKey: 'analyse', evalContext },
        spec: { remainingToolCalls: { rechercher_documents: 3 } },
      }),
    );
    const [ctx] = h.tools.search.execute.mock.calls[0]!;
    expect(ctx.evalContext).toEqual(evalContext);
  });

  it('evalContext : JAMAIS transmis en exécution réelle (live), même si le champ est présent', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'x' }), final()]);
    await h.runner.run(
      makeInput({
        scope: { definitionId: 5, instanceId: '900', stepKey: 'analyse', evalContext: { delegates: [{ userGroupId: 1 }] } },
        spec: { remainingToolCalls: { rechercher_documents: 3 } },
      }),
    );
    const [ctx] = h.tools.search.execute.mock.calls[0]!;
    expect(ctx.dryRun).toBe(false);
    expect(ctx).not.toHaveProperty('evalContext');
  });

  it('plafond d’appels de l’exécution : le 2e appel est refusé', async () => {
    const h = makeHarness([
      toolCall('rechercher_documents', { query: 'a' }),
      toolCall('rechercher_documents', { query: 'b' }),
      final(),
    ]);
    const out = await h.runner.run(makeInput({ spec: { remainingToolCalls: { rechercher_documents: 1 } } }));
    expect(out.stopReason).toBe('tool_denied');
    expect(out.suspicionReasons).toContain('tool_quota');
    expect(h.tools.search.execute).toHaveBeenCalledTimes(1);
  });

  it('plafond par instance (live) : appels concurrents comptés via le journal', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'a' }), final()]);
    h.sink.countToolCalls.mockResolvedValueOnce(4).mockResolvedValueOnce(5); // base 4, puis 1 appel concurrent
    const out = await h.runner.run(makeInput({ spec: { remainingToolCalls: { rechercher_documents: 1 } } }));
    expect(out.stopReason).toBe('tool_denied');
    expect(h.tools.search.execute).not.toHaveBeenCalled();
    expect(h.sink.countToolCalls).toHaveBeenCalledWith('900', 'rechercher_documents');
  });

  it('plafond par instance illisible : refus (échec fermé)', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'a' }), final()]);
    h.sink.countToolCalls.mockRejectedValue(new Error('base'));
    const out = await h.runner.run(makeInput({ spec: { remainingToolCalls: { rechercher_documents: 2 } } }));
    expect(out.stopReason).toBe('tool_denied');
    expect(h.tools.search.execute).not.toHaveBeenCalled();
  });

  it('plafond à zéro : refus immédiat', async () => {
    const h = makeHarness([toolCall('rechercher_documents', { query: 'a' }), final()]);
    const out = await h.runner.run(makeInput({ spec: { remainingToolCalls: { rechercher_documents: 0 } } }));
    expect(out.stopReason).toBe('tool_denied');
    expect(h.tools.search.execute).not.toHaveBeenCalled();
  });

  it('erreur d’outil : message générique au modèle, arrêt après 2 erreurs consécutives', async () => {
    const h = makeHarness([toolCall('outil_en_panne', {}), toolCall('outil_en_panne', {}), final()]);
    const out = await h.runner.run(makeInput());
    expect(out.stopReason).toBe('tool_denied');
    expect(h.ai.run).toHaveBeenCalledTimes(2);
    const second = h.ai.calls[1]!.request.text;
    expect(second).toContain(TOOL_FAILURE_OUTPUT);
    for (const c of h.ai.calls) expect(c.request.text).not.toContain(BROKEN_TOOL_SECRET);
    expect(JSON.stringify(out)).not.toContain(BROKEN_TOOL_SECRET);
    expect(out.audit.toolCalls.map((c) => [c.ok, c.error])).toEqual([
      [false, 'tool_error'],
      [false, 'tool_error'],
    ]);
    expect(h.sink.append).toHaveBeenCalledTimes(2);
  });

  it('une erreur isolée n’arrête pas le run', async () => {
    const h = makeHarness([toolCall('outil_en_panne', {}), toolCall('rechercher_documents', { query: 'x' }), final()]);
    const out = await h.runner.run(makeInput());
    expect(out.outcome).toBe('final');
  });
});
