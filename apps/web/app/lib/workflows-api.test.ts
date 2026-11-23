// Tests du client d'API Docu-Flow : messages d'erreur, API optionnelles, lancement 201/200, issues d'un 422, identifiants.
// Lancer : cd apps/web && npx tsx --test app/lib/workflows-api.test.ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  WorkflowApiError,
  fieldsFromValidationMessage,
  isWorkflowBigintId,
  requestOptional,
  workflowErrorMessage,
  workflowsApi,
} from './workflows-api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  init?: RequestInit;
}

/** Remplace `fetch` : renvoie la réponse donnée et mémorise les appels. */
function mockFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('workflowErrorMessage : 5xx = message français fixe, jamais le texte de l’API', () => {
  const msg = workflowErrorMessage(new WorkflowApiError(500, 'PrismaClientKnownRequestError: secret SQL'));
  assert.equal(msg, 'Le service est momentanément indisponible. Réessayez dans un instant.');
  assert.ok(!msg.includes('Prisma'));
  assert.equal(workflowErrorMessage(new WorkflowApiError(503, 'x')), msg);
});

test('workflowErrorMessage : 400 = jamais le message Zod brut, champs concernés cités', () => {
  const raw = 'graph.steps.0.name: String must contain at least 1 character(s) graph.steps.1.agent.objective: Required';
  const msg = workflowErrorMessage(new WorkflowApiError(400, raw));
  assert.ok(!msg.includes('String must contain'));
  assert.ok(!msg.includes('Required'));
  assert.match(msg, /champs concernés : graph\.steps\.0\.name, graph\.steps\.1\.agent\.objective/);
  assert.match(workflowErrorMessage(new WorkflowApiError(400, 'HTTP 400')), /refusées par le serveur/);
  assert.deepEqual(fieldsFromValidationMessage('(root): Required'), []);
});

test('workflowErrorMessage : messages français de l’API conservés (409, 422), replis par statut', () => {
  assert.equal(workflowErrorMessage(new WorkflowApiError(409, 'Ce nom est déjà utilisé.')), 'Ce nom est déjà utilisé.');
  assert.equal(workflowErrorMessage(new WorkflowApiError(422, 'Le champ « montant » est obligatoire.')), 'Le champ « montant » est obligatoire.');
  assert.match(workflowErrorMessage(new WorkflowApiError(403, 'HTTP 403')), /niveau d’accès/);
  assert.match(workflowErrorMessage(new WorkflowApiError(404, 'HTTP 404')), /introuvable/);
  assert.match(workflowErrorMessage(new WorkflowApiError(0, 'x')), /injoignable/);
  assert.equal(workflowErrorMessage(new Error('boom')), 'Une erreur est survenue. Réessayez.');
});

test('requestOptional : 404, 403, 405, 501 => null ; autres erreurs relancées ; succès renvoyé', async () => {
  for (const status of [403, 404, 405, 501]) {
    mockFetch(status, { message: 'non' });
    assert.equal(await requestOptional('/workflows/agents/tools'), null, `statut ${status}`);
  }
  mockFetch(500, { message: 'panne' });
  await assert.rejects(requestOptional('/workflows/triggers'), (e: unknown) => e instanceof WorkflowApiError && e.status === 500);
  mockFetch(200, [{ toolKey: 'lire_document' }]);
  assert.deepEqual(await requestOptional('/workflows/agents/tools'), [{ toolKey: 'lire_document' }]);
});

test('API de l’éditeur : outils sur /workflows/agents/tools, déclencheurs sur /workflows/triggers, statut d’évaluation sur eval-status', async () => {
  const calls = mockFetch(404, {});
  assert.equal(await workflowsApi.listAgentTools(), null);
  assert.equal(await workflowsApi.listTriggers(7), null);
  assert.equal(await workflowsApi.getEvaluationStatus(7), null);
  assert.equal(calls.length, 3);
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/tools$/);
  assert.match(calls[1]?.url ?? '', /\/workflows\/triggers\?definitionId=7&limit=100$/);
  assert.match(calls[2]?.url ?? '', /\/workflows\/agents\/eval-status\?definitionId=7$/);
});

test('launch : 201 => created, 200 => rejeu d’une clé d’idempotence', async () => {
  const instance = { wfInstanceId: '12', definitionId: 3 };
  let calls = mockFetch(201, instance);
  const created = await workflowsApi.launch({ definitionId: 3, idempotencyKey: 'manuel-abc' });
  assert.equal(created.created, true);
  assert.equal(created.instance.wfInstanceId, '12');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { definitionId: 3, idempotencyKey: 'manuel-abc' });

  calls = mockFetch(200, instance);
  const replay = await workflowsApi.launch({ definitionId: 3, idempotencyKey: 'manuel-abc' });
  assert.equal(replay.created, false);
  assert.equal(calls.length, 1);
});

test('publication refusée (422) : la liste issues est conservée', async () => {
  const issues = [
    { code: 'UNREACHABLE_STEP', message: 'x', stepKey: 'b' },
    { code: 'EXECUTOR_MISSING', message: 'y' },
  ];
  mockFetch(422, { message: 'Le workflow ne peut pas être publié : corrigez les problèmes signalés.', issues });
  await assert.rejects(workflowsApi.publish(5), (e: unknown) => {
    assert.ok(e instanceof WorkflowApiError);
    assert.equal(e.status, 422);
    assert.deepEqual(e.issues, issues);
    assert.equal(workflowErrorMessage(e), 'Le workflow ne peut pas être publié : corrigez les problèmes signalés.');
    return true;
  });
});

test('erreur du moteur : code conservé ; réseau coupé => statut 0', async () => {
  mockFetch(409, { message: 'Déjà pris.', code: 'CONFLICT' });
  await assert.rejects(workflowsApi.claim('4'), (e: unknown) => e instanceof WorkflowApiError && e.code === 'CONFLICT' && e.conflict);
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(workflowsApi.listLaunchable(), (e: unknown) => e instanceof WorkflowApiError && e.status === 0);
});

test('forme réelle de l’API : `code` numérique + `errorCode` texte + `issues` (filtre global)', async () => {
  const issues = [{ code: 'NO_TERMINAL_STEP', message: 'm', stepKey: 'a' }];
  mockFetch(422, { code: 422, message: 'Le workflow ne peut pas être publié.', errorCode: 'AUTHORING_INVALID', issues });
  await assert.rejects(workflowsApi.publish(5), (e: unknown) => {
    assert.ok(e instanceof WorkflowApiError);
    assert.equal(e.status, 422);
    assert.equal(e.code, 'AUTHORING_INVALID');
    assert.deepEqual(e.issues, issues);
    return true;
  });
  // `code` numérique seul (sans errorCode) : aucun code texte, pas d'erreur.
  mockFetch(409, { code: 409, message: 'Conflit.' });
  await assert.rejects(workflowsApi.claim('4'), (e: unknown) => e instanceof WorkflowApiError && e.code === undefined && e.conflict);
  mockFetch(409, { code: 409, message: 'Clé déjà utilisée.', errorCode: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(workflowsApi.claim('4'), (e: unknown) => e instanceof WorkflowApiError && e.code === 'IDEMPOTENCY_CONFLICT');
});

test('identifiants de chemin : entiers décimaux seulement, aucun appel réseau sinon', async () => {
  assert.equal(isWorkflowBigintId('123'), true);
  for (const bad of ['', 'abc', '1/../2', '12 3', '1234567890123456789', '-1', '1e3']) {
    assert.equal(isWorkflowBigintId(bad), false, bad);
  }
  const calls = mockFetch(200, {});
  const attempts: Array<() => Promise<unknown>> = [
    async () => workflowsApi.getInstance('../definitions'),
    async () => workflowsApi.cancelInstance('x'),
    async () => workflowsApi.claim('1?x=1'),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt(), (e: unknown) => e instanceof WorkflowApiError && e.status === 404);
  }
  assert.equal(calls.length, 0);
  await workflowsApi.getInstance('42');
  assert.match(calls[0]?.url ?? '', /\/workflows\/instances\/42$/);
});

test('W5 authoring : generate envoie description et signal, explain et modèles sur les bons chemins', async () => {
  const resp = { definitionId: 4, name: 'N', graph: {}, issues: [], assumptions: [], toComplete: [], triggerSuggestion: null };
  let calls = mockFetch(201, resp);
  const ctrl = new AbortController();
  const out = await workflowsApi.authoringGenerate({ description: 'Quand une facture arrive, la valider.' }, ctrl.signal);
  assert.equal(out.definitionId, 4);
  assert.match(calls[0]?.url ?? '', /\/workflows\/authoring\/generate$/);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.signal, ctrl.signal);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { description: 'Quand une facture arrive, la valider.' });

  calls = mockFetch(200, { definitionId: 4, versionNumber: 1, summary: 's', steps: [], toComplete: [] });
  await workflowsApi.authoringExplain(4);
  assert.match(calls[0]?.url ?? '', /\/workflows\/authoring\/explain\/4$/);
  assert.equal(calls[0]?.init?.method, 'POST');

  calls = mockFetch(200, [{ key: 'facture', name: 'F', description: '', agentKey: null, tags: [] }]);
  assert.equal((await workflowsApi.listTemplates())?.length, 1);
  assert.match(calls[0]?.url ?? '', /\/workflows\/templates$/);

  for (const status of [403, 404, 405, 501]) {
    mockFetch(status, { message: 'non' });
    assert.equal(await workflowsApi.listTemplates(), null, `statut ${status}`);
  }

  calls = mockFetch(201, { definitionId: 9 });
  assert.deepEqual(await workflowsApi.instantiateTemplate('facture_fournisseur-2.v1'), { definitionId: 9 });
  assert.match(calls[0]?.url ?? '', /\/workflows\/templates\/facture_fournisseur-2\.v1\/instantiate$/);
  assert.equal(calls[0]?.init?.method, 'POST');
});

test('W5 modèles : clé invalide => aucun appel réseau (404 local)', async () => {
  const calls = mockFetch(201, { definitionId: 1 });
  for (const key of ['', 'A', '../x', 'a/b', 'a b', 'a?b', 'é', 'x'.repeat(101), '%2e%2e']) {
    await assert.rejects(workflowsApi.instantiateTemplate(key), (e: unknown) => e instanceof WorkflowApiError && e.status === 404, key);
  }
  assert.equal(calls.length, 0);
  await workflowsApi.instantiateTemplate('x'.repeat(100));
  assert.equal(calls.length, 1);
});

test('W5 429 : Retry-After exposé en secondes entières, ignoré si invalide ou hors 429', async () => {
  const reply = (status: number, retryAfter?: string) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'Trop de requêtes' }), {
        status,
        headers: { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) },
      })) as typeof fetch;
  };
  reply(429, '17');
  await assert.rejects(workflowsApi.authoringGenerate({ description: 'x'.repeat(10) }), (e: unknown) => {
    assert.ok(e instanceof WorkflowApiError);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSeconds, 17);
    return true;
  });
  for (const bad of ['abc', '-3', '0', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT', '9999999']) {
    reply(429, bad);
    await assert.rejects(
      workflowsApi.authoringGenerate({ description: 'x'.repeat(10) }),
      (e: unknown) => e instanceof WorkflowApiError && e.retryAfterSeconds === undefined,
      bad,
    );
  }
  reply(503, '5');
  await assert.rejects(workflowsApi.listDefinitions(), (e: unknown) => e instanceof WorkflowApiError && e.retryAfterSeconds === undefined);
  // 422 d'un brouillon inutilisable : le code et les problèmes sont conservés.
  mockFetch(422, { message: 'x', code: 'AUTHORING_INVALID', issues: [{ code: 'NO_TERMINAL_STEP', message: 'm' }] });
  await assert.rejects(workflowsApi.authoringGenerate({ description: 'x'.repeat(10) }), (e: unknown) => {
    assert.ok(e instanceof WorkflowApiError);
    assert.equal(e.code, 'AUTHORING_INVALID');
    assert.equal(e.issues?.length, 1);
    return true;
  });
});

const methodOf = (c: Call | undefined) => c?.init?.method ?? 'GET';
const bodyOf = (c: Call | undefined) => JSON.parse(String(c?.init?.body));

test('getAgentToolCatalog : strict (403 et 404 lèvent), contrairement à listAgentTools', async () => {
  for (const status of [403, 404]) {
    mockFetch(status, { message: 'Accès refusé.' });
    assert.equal(await workflowsApi.listAgentTools(), null);
    await assert.rejects(workflowsApi.getAgentToolCatalog(), (e: unknown) => e instanceof WorkflowApiError && e.status === status);
  }
  const calls = mockFetch(200, [{ toolKey: 'lire_document' }]);
  assert.deepEqual(await workflowsApi.getAgentToolCatalog(), [{ toolKey: 'lire_document' }]);
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/tools$/);
});

test('autorisations d’outils : GET et PUT sur definitions/:id/tool-grants, identifiant invalide sans appel réseau', async () => {
  let calls = mockFetch(200, [{ toolKey: 'a', maxCallsPerInstance: null }]);
  assert.equal((await workflowsApi.getToolGrants(4)).length, 1);
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/definitions\/4\/tool-grants$/);
  assert.equal(methodOf(calls[0]), 'GET');

  calls = mockFetch(200, { grants: [], warnings: ['encore utilisé'] });
  const res = await workflowsApi.replaceToolGrants(4, [{ toolKey: 'a', maxCallsPerInstance: 3 }, { toolKey: 'b' }]);
  assert.deepEqual(res.warnings, ['encore utilisé']);
  assert.equal(methodOf(calls[0]), 'PUT');
  assert.deepEqual(bodyOf(calls[0]), { grants: [{ toolKey: 'a', maxCallsPerInstance: 3 }, { toolKey: 'b' }] });

  calls = mockFetch(200, []);
  assert.throws(() => workflowsApi.getToolGrants(0), (e: unknown) => e instanceof WorkflowApiError && e.status === 404);
  assert.throws(() => workflowsApi.replaceToolGrants(1.5, []), WorkflowApiError);
  assert.equal(calls.length, 0);
});

test('évaluation : chemins, méthodes et corps', async () => {
  let calls = mockFetch(200, []);
  await workflowsApi.listEvalSets();
  await workflowsApi.listEvalSets(9);
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/eval-sets$/);
  assert.match(calls[1]?.url ?? '', /\/workflows\/agents\/eval-sets\?definitionId=9$/);

  calls = mockFetch(201, { wfEvalSetId: 3 });
  await workflowsApi.createEvalSet({ definitionId: 9, stepKey: 'tri', name: 'Jeu', minAccuracy: 0.9 });
  assert.equal(methodOf(calls[0]), 'POST');
  assert.deepEqual(bodyOf(calls[0]), { definitionId: 9, stepKey: 'tri', name: 'Jeu', minAccuracy: 0.9 });

  calls = mockFetch(200, { wfEvalSetId: 3 });
  await workflowsApi.updateEvalSet(3, { isActive: false });
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/eval-sets\/3$/);
  assert.equal(methodOf(calls[0]), 'PATCH');
  assert.deepEqual(bodyOf(calls[0]), { isActive: false });

  calls = mockFetch(200, []);
  await workflowsApi.listEvalCases(3);
  await workflowsApi.listEvalCases(3, true);
  assert.match(calls[0]?.url ?? '', /\/eval-sets\/3\/cases$/);
  assert.match(calls[1]?.url ?? '', /\/eval-sets\/3\/cases\?includeInactive=true$/);

  calls = mockFetch(200, { wfEvalCaseId: 8 });
  await workflowsApi.addEvalCase(3, { label: 'Cas', input: { context: {} }, expected: { returnsToHuman: true } });
  await workflowsApi.updateEvalCase(3, 8, { weight: 2 });
  await workflowsApi.removeEvalCase(3, 8);
  assert.deepEqual(calls.map(methodOf), ['POST', 'PATCH', 'DELETE']);
  assert.match(calls[0]?.url ?? '', /\/eval-sets\/3\/cases$/);
  assert.match(calls[1]?.url ?? '', /\/eval-sets\/3\/cases\/8$/);
  assert.match(calls[2]?.url ?? '', /\/eval-sets\/3\/cases\/8$/);

  calls = mockFetch(202, { wfEvalRunId: '41', status: 0 });
  const run = await workflowsApi.runEvalSet(3, { definitionVersionId: 6, stepKey: 'tri' });
  assert.equal(run.wfEvalRunId, '41');
  assert.match(calls[0]?.url ?? '', /\/eval-sets\/3\/runs$/);
  assert.equal(methodOf(calls[0]), 'POST');
  assert.deepEqual(bodyOf(calls[0]), { definitionVersionId: 6, stepKey: 'tri' });
  await workflowsApi.runEvalSet(3);
  assert.deepEqual(bodyOf(calls[1]), {});

  calls = mockFetch(200, []);
  await workflowsApi.listEvalRuns(3);
  assert.match(calls[0]?.url ?? '', /\/eval-sets\/3\/runs$/);
  assert.equal(methodOf(calls[0]), 'GET');
  calls = mockFetch(200, { wfEvalRunId: '41' });
  await workflowsApi.getEvalRun('41');
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/eval-runs\/41$/);
});

test('évaluation : identifiants invalides refusés sans appel réseau', () => {
  const calls = mockFetch(200, {});
  const notFound = (e: unknown) => e instanceof WorkflowApiError && e.status === 404;
  assert.throws(() => workflowsApi.getEvalRun('abc'), notFound);
  assert.throws(() => workflowsApi.getEvalRun('1/../2'), notFound);
  assert.throws(() => workflowsApi.getEvalRun(''), notFound);
  assert.throws(() => workflowsApi.listEvalSets(-1), notFound);
  assert.throws(() => workflowsApi.updateEvalSet(0, {}), notFound);
  assert.throws(() => workflowsApi.listEvalCases(Number.NaN), notFound);
  assert.throws(() => workflowsApi.updateEvalCase(1, 1.5, {}), notFound);
  assert.throws(() => workflowsApi.removeEvalCase(1, 0), notFound);
  assert.throws(() => workflowsApi.runEvalSet(0), notFound);
  assert.throws(() => workflowsApi.listEvalRuns(-5), notFound);
  assert.throws(() => workflowsApi.getEvalStatus(0), notFound);
  assert.throws(() => workflowsApi.listDraftAgents(0), notFound);
  assert.throws(() => workflowsApi.updateDraftAgent(0, 'tri', {}), notFound);
  assert.throws(() => workflowsApi.updateDraftAgent(1, '../x', {}), notFound);
  assert.throws(() => workflowsApi.updateDraftAgent(1, 'Tri', {}), notFound);
  assert.equal(calls.length, 0);
});

test('étapes agent du brouillon : GET draft/agents, PUT draft/agents/:stepKey (lien evalSetId)', async () => {
  let calls = mockFetch(200, [{ stepKey: 'tri', evalSetId: 3 }]);
  assert.equal((await workflowsApi.listDraftAgents(7))[0]?.evalSetId, 3);
  assert.match(calls[0]?.url ?? '', /\/workflows\/definitions\/7\/draft\/agents$/);

  calls = mockFetch(200, { stepKey: 'tri_courrier', evalSetId: null });
  await workflowsApi.updateDraftAgent(7, 'tri_courrier', { evalSetId: null });
  assert.match(calls[0]?.url ?? '', /\/workflows\/definitions\/7\/draft\/agents\/tri_courrier$/);
  assert.equal(methodOf(calls[0]), 'PUT');
  assert.deepEqual(bodyOf(calls[0]), { evalSetId: null });
});

test('getEvalStatus : null sur 403, 404, 405, 501 ; 500 relancée ; corps conservé', async () => {
  for (const status of [403, 404, 405, 501]) {
    mockFetch(status, { message: 'non' });
    assert.equal(await workflowsApi.getEvalStatus(7), null, `statut ${status}`);
  }
  mockFetch(500, { message: 'panne' });
  await assert.rejects(workflowsApi.getEvalStatus(7), (e: unknown) => e instanceof WorkflowApiError && e.status === 500);
  const status = {
    definitionId: 7,
    definitionVersionId: 11,
    versionNumber: 2,
    steps: [{ stepKey: 'tri', evalSetId: 3, eligible: false, reason: 'Aucune évaluation réussie.' }],
  };
  mockFetch(200, status);
  assert.deepEqual(await workflowsApi.getEvalStatus(7), status);
});

test('getEvaluationStatus (compatibilité) : au moins une étape éligible, sinon false ; route absente => null', async () => {
  const step = (eligible: boolean) => ({ stepKey: 'a', evalSetId: 1, eligible, reason: eligible ? null : 'non' });
  const base = { definitionId: 7, definitionVersionId: 1, versionNumber: 1 };
  mockFetch(200, { ...base, steps: [step(false), step(true)] });
  assert.deepEqual(await workflowsApi.getEvaluationStatus(7), { hasPassedEvalRun: true });
  mockFetch(200, { ...base, steps: [step(false)] });
  assert.deepEqual(await workflowsApi.getEvaluationStatus(7), { hasPassedEvalRun: false });
  mockFetch(200, { ...base, steps: [] });
  assert.deepEqual(await workflowsApi.getEvaluationStatus(7), { hasPassedEvalRun: false });
  mockFetch(404, {});
  assert.equal(await workflowsApi.getEvaluationStatus(7), null);
  mockFetch(403, {});
  assert.equal(await workflowsApi.getEvaluationStatus(7), null);
});

test('administration des agents : statut, budget, plafond, arrêt d’urgence', async () => {
  let calls = mockFetch(200, { aiEnabled: true, aiMode: 1, emergencyStopGlobal: false });
  assert.equal((await workflowsApi.getAgentStatus()).aiEnabled, true);
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/status$/);

  calls = mockFetch(200, { global: { wfBudgetId: 1 }, workflows: [] });
  assert.deepEqual((await workflowsApi.getAgentBudget()).workflows, []);
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/budget$/);
  assert.equal(methodOf(calls[0]), 'GET');

  calls = mockFetch(200, { wfBudgetId: 2 });
  await workflowsApi.updateAgentBudget({ definitionId: 4, capAmount: null, periodKind: 1, alertThreshold: 0.8, currency: 'XOF' });
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/budget$/);
  assert.equal(methodOf(calls[0]), 'PUT');
  assert.deepEqual(bodyOf(calls[0]), { definitionId: 4, capAmount: null, periodKind: 1, alertThreshold: 0.8, currency: 'XOF' });

  calls = mockFetch(200, { wfBudgetId: 1, emergencyStop: true });
  const dto = await workflowsApi.setEmergencyStop({ active: true, reason: 'Incident' });
  assert.equal(dto.emergencyStop, true);
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/emergency-stop$/);
  assert.equal(methodOf(calls[0]), 'POST');
  assert.deepEqual(bodyOf(calls[0]), { active: true, reason: 'Incident' });
});

test('workflowErrorMessage : 429, 403, 404, 409, 422 gardent le message français de l’API', () => {
  for (const status of [429, 403, 404, 409, 422]) {
    assert.equal(workflowErrorMessage(new WorkflowApiError(status, 'Message précis de l’API.')), 'Message précis de l’API.');
  }
  assert.match(workflowErrorMessage(new WorkflowApiError(429, 'HTTP 429')), /Trop de demandes/);
});

test('workflowErrorMessage : le message brut du routeur n’est jamais affiché', () => {
  const msg = workflowErrorMessage(new WorkflowApiError(404, 'Route GET /api/workflows/inbox not found'));
  assert.doesNotMatch(msg, /Route|\/api/);
  assert.match(msg, /pas disponible/);
});
