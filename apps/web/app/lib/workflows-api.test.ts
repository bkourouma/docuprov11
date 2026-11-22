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

test('API de l’éditeur : outils W2 sur /workflows/agents/tools, déclencheurs W3 sur /workflows/triggers, évaluation sans appel réseau', async () => {
  const calls = mockFetch(404, {});
  assert.equal(await workflowsApi.listAgentTools(), null);
  assert.equal(await workflowsApi.listTriggers(7), null);
  assert.equal(await workflowsApi.getEvaluationStatus(7), null);
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.url ?? '', /\/workflows\/agents\/tools$/);
  assert.match(calls[1]?.url ?? '', /\/workflows\/triggers\?definitionId=7&limit=100$/);
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
