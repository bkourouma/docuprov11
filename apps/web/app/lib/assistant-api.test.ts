// Tests du client d'API de l'assistant : fetch et window sont simulés.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ASST_ERROR_CODE_VALUES, ASST_ERROR_HTTP_STATUS, AsstErrorCode } from '@archivage/types';
import {
  AssistantApiError,
  assistantApi,
  assistantErrorMessage,
  confirmProposal,
  createConversation,
  deleteConversation,
  getConversation,
  getProposal,
  isAssistantNotImplemented,
  isAssistantUnavailable,
  isRateLimited,
  listConversations,
  postMessage,
  refuseProposal,
} from './assistant-api';

type Call = { url: string; init: RequestInit };
type FakeWindow = {
  localStorage: { getItem: (k: string) => string | null; removeItem: (k: string) => void };
  location: { pathname: string; href: string };
};

const g = globalThis as unknown as { fetch: unknown; window: unknown };
const realFetch = g.fetch;
const realWindow = g.window;

let calls: Call[] = [];
let store: Record<string, string> = {};
let win: FakeWindow;

function mockFetch(handler: (c: Call) => Response | Promise<Response>): void {
  g.fetch = async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    return handler(c);
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Appel enregistré (échoue si absent). */
function at(i: number): Call {
  const c = calls[i];
  assert.ok(c, `appel ${i} absent`);
  return c;
}

const HASH = 'a'.repeat(64);

beforeEach(() => {
  calls = [];
  store = { token: 'tok123' };
  win = {
    localStorage: { getItem: (k) => store[k] ?? null, removeItem: (k) => void delete store[k] },
    location: { pathname: '/assistant', href: '' },
  };
  g.window = win;
});

afterEach(() => {
  g.fetch = realFetch;
  g.window = realWindow;
});

async function failure(p: Promise<unknown>): Promise<AssistantApiError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AssistantApiError, 'AssistantApiError attendue');
    return e;
  }
  throw new assert.AssertionError({ message: 'rejet attendu' });
}

describe('routes', () => {
  it('createConversation : POST avec corps et jeton', async () => {
    mockFetch(() => json(201, { id: '1' }));
    await createConversation({ title: 'T' });
    assert.match(at(0).url, /\/assistant\/conversations$/);
    assert.equal(at(0).init.method, 'POST');
    assert.equal(at(0).init.body, '{"title":"T"}');
    const h = at(0).init.headers as Record<string, string>;
    assert.equal(h.Authorization, 'Bearer tok123');
    assert.equal(h['Content-Type'], 'application/json');
  });

  it('listConversations : GET avec query, sans corps ni Content-Type', async () => {
    mockFetch(() => json(200, { items: [], total: 0 }));
    await listConversations({ limit: 10, offset: 20 });
    assert.match(at(0).url, /\/assistant\/conversations\?limit=10&offset=20$/);
    assert.equal(at(0).init.method, 'GET');
    assert.equal(at(0).init.body, undefined);
    assert.equal((at(0).init.headers as Record<string, string>)['Content-Type'], undefined);
    await listConversations();
    assert.match(at(1).url, /\/assistant\/conversations$/);
  });

  it('getConversation et getProposal : GET', async () => {
    mockFetch(() => json(200, {}));
    await getConversation('12');
    await getProposal('34');
    assert.match(at(0).url, /\/assistant\/conversations\/12$/);
    assert.match(at(1).url, /\/assistant\/proposals\/34$/);
    assert.equal(at(1).init.method, 'GET');
  });

  it('postMessage : POST sur /messages', async () => {
    mockFetch(() => json(201, {}));
    await postMessage('12', { content: 'Bonjour' });
    assert.match(at(0).url, /\/assistant\/conversations\/12\/messages$/);
    assert.equal(at(0).init.method, 'POST');
    assert.equal(at(0).init.body, '{"content":"Bonjour"}');
  });

  it('confirmProposal envoie exactement le hash reçu', async () => {
    mockFetch(() => json(200, {}));
    await confirmProposal('7', HASH);
    assert.match(at(0).url, /\/assistant\/proposals\/7\/confirm$/);
    assert.equal(at(0).init.body, JSON.stringify({ argsHash: HASH }));
  });

  it('confirmProposal refuse un hash mal formé sans appel réseau', async () => {
    mockFetch(() => json(200, {}));
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), '', 'g'.repeat(64)]) {
      const e = await failure(confirmProposal('7', bad));
      assert.equal(e.errorCode, AsstErrorCode.InvalidInput);
      assert.equal(e.status, 0);
    }
    assert.equal(calls.length, 0);
  });

  it('refuseProposal : reason omis si vide, trim, tronqué à 500', async () => {
    mockFetch(() => json(200, {}));
    await refuseProposal('7');
    await refuseProposal('7', '   ');
    await refuseProposal('7', '  non merci  ');
    await refuseProposal('7', 'x'.repeat(600));
    assert.match(at(0).url, /\/assistant\/proposals\/7\/refuse$/);
    assert.equal(at(0).init.body, '{}');
    assert.equal(at(1).init.body, '{}');
    assert.equal(at(2).init.body, '{"reason":"non merci"}');
    assert.equal((JSON.parse(at(3).init.body as string) as { reason: string }).reason.length, 500);
  });

  it('deleteConversation : DELETE, 204 -> undefined', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    const r = await deleteConversation('12');
    assert.equal(r, undefined);
    assert.equal(at(0).init.method, 'DELETE');
    assert.match(at(0).url, /\/assistant\/conversations\/12$/);
  });

  it('assistantApi regroupe les 8 fonctions', () => {
    assert.equal(Object.keys(assistantApi).length, 8);
  });

  it('identifiant invalide : erreur locale sans appel réseau', async () => {
    mockFetch(() => json(200, {}));
    for (const bad of ['', 'abc', '1/2', '-1', '1'.repeat(19), '1.5']) {
      const e = await failure(getConversation(bad));
      assert.equal(e.errorCode, AsstErrorCode.InvalidInput);
      assert.equal(e.status, 0);
    }
    await failure(postMessage('x', { content: 'a' }));
    await failure(getProposal('x'));
    await failure(refuseProposal('x'));
    await failure(deleteConversation('x'));
    assert.equal(calls.length, 0);
  });
});

describe('erreurs', () => {
  it('chacun des 11 errorCode', async () => {
    assert.equal(ASST_ERROR_CODE_VALUES.length, 11);
    for (const code of ASST_ERROR_CODE_VALUES) {
      const status = ASST_ERROR_HTTP_STATUS[code];
      mockFetch(() => json(status, { statusCode: status, errorCode: code, message: 'Message du serveur.' }));
      const e = await failure(getProposal('1'));
      assert.equal(e.errorCode, code);
      assert.equal(e.status, status);
      assert.equal(e.kind, 'http');
      const msg = assistantErrorMessage(e);
      assert.ok(msg.length > 0);
      assert.doesNotMatch(msg, /undefined|null|[{}]/);
    }
  });

  it('serverMessage repris seulement pour les codes affichables', async () => {
    const mk = (errorCode: AsstErrorCode) =>
      new AssistantApiError({ status: ASST_ERROR_HTTP_STATUS[errorCode], errorCode, serverMessage: 'Détail métier.' });
    assert.match(assistantErrorMessage(mk(AsstErrorCode.EffectFailed)), /Détail métier\./);
    assert.match(assistantErrorMessage(mk(AsstErrorCode.EffectForbidden)), /Détail métier\./);
    assert.match(assistantErrorMessage(mk(AsstErrorCode.IdentityRefused)), /Détail métier\./);
    assert.doesNotMatch(assistantErrorMessage(mk(AsstErrorCode.NotFound)), /Détail/);
    const sans = new AssistantApiError({ status: 500, serverMessage: 'Internal server error' });
    assert.doesNotMatch(assistantErrorMessage(sans), /Internal/);
  });

  it('proposal présent sur effect_failed', async () => {
    const proposal = { id: '5', status: 5 };
    mockFetch(() => json(422, { statusCode: 422, errorCode: 'effect_failed', message: 'Refus.', proposal }));
    const e = await failure(confirmProposal('5', HASH));
    assert.deepEqual(e.proposal, proposal);
    assert.equal(e.serverMessage, 'Refus.');
  });

  it('Retry-After en secondes', async () => {
    mockFetch(() => json(429, { statusCode: 429, errorCode: 'budget_exceeded', message: 'Plafond.' }, { 'Retry-After': '42' }));
    const e = await failure(postMessage('1', { content: 'a' }));
    assert.equal(e.retryAfterSeconds, 42);
    assert.match(assistantErrorMessage(e), /dans 42 s/);
    assert.ok(isRateLimited(e));
  });

  it('Retry-After en date HTTP', async () => {
    const date = new Date(Date.now() + 30_000).toUTCString();
    mockFetch(() => json(429, { statusCode: 429 }, { 'Retry-After': date }));
    const e = await failure(postMessage('1', { content: 'a' }));
    assert.ok(e.retryAfterSeconds !== null && e.retryAfterSeconds > 0 && e.retryAfterSeconds <= 31);
  });

  it('429 sans errorCode', async () => {
    mockFetch(() => json(429, { statusCode: 429, message: 'ThrottlerException' }));
    const e = await failure(postMessage('1', { content: 'a' }));
    assert.equal(e.errorCode, null);
    assert.ok(isRateLimited(e));
    assert.match(assistantErrorMessage(e), /Trop de demandes.*quelques instants/);
  });

  it('401 sans errorCode : jeton vidé et redirection', async () => {
    mockFetch(() => json(401, { statusCode: 401, message: 'Unauthorized' }));
    const e = await failure(getConversation('1'));
    assert.equal(e.status, 401);
    assert.equal(e.errorCode, null);
    assert.equal(store.token, undefined);
    assert.equal(win.location.href, '/login');
    assert.match(assistantErrorMessage(e), /session a expiré/);
  });

  it('401 déjà sur /login : pas de redirection', async () => {
    win.location.pathname = '/login';
    mockFetch(() => json(401, {}));
    await failure(getConversation('1'));
    assert.equal(win.location.href, '');
  });

  it('403 et 503 sans errorCode', async () => {
    mockFetch(() => json(403, { statusCode: 403, message: 'Forbidden resource' }));
    const e403 = await failure(getConversation('1'));
    assert.match(assistantErrorMessage(e403), /pas accès à l’assistant/);
    mockFetch(() => json(503, {}));
    const e503 = await failure(getConversation('1'));
    assert.ok(isAssistantUnavailable(e503));
    mockFetch(() => json(501, {}));
    const e501 = await failure(getConversation('1'));
    assert.ok(isAssistantNotImplemented(e501));
  });

  it('500 sans errorCode et corps non JSON', async () => {
    mockFetch(() => json(500, { statusCode: 500, message: 'Internal server error' }));
    const e = await failure(getConversation('1'));
    assert.equal(e.errorCode, null);
    assert.equal(assistantErrorMessage(e), 'Une erreur est survenue. Réessayez dans un instant.');
    mockFetch(() => new Response('<html>boom</html>', { status: 502 }));
    const e2 = await failure(getConversation('1'));
    assert.equal(e2.status, 502);
    assert.equal(e2.serverMessage, null);
  });

  it('errorCode inconnu -> null', async () => {
    mockFetch(() => json(418, { errorCode: 'nope', message: 'x' }));
    const e = await failure(getConversation('1'));
    assert.equal(e.errorCode, null);
  });

  it('erreur réseau', async () => {
    g.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const e = await failure(getConversation('1'));
    assert.equal(e.kind, 'network');
    assert.equal(e.status, 0);
    assert.equal(assistantErrorMessage(e), 'Impossible de joindre le serveur. Vérifiez votre connexion.');
  });

  it('AbortError propagé tel quel', async () => {
    const ctrl = new AbortController();
    g.fetch = async (_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
      });
    const p = getConversation('1', ctrl.signal);
    ctrl.abort();
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof DOMException);
      assert.equal((e as DOMException).name, 'AbortError');
      assert.ok(!(e instanceof AssistantApiError));
      return true;
    });
  });

  it('aucun message ne contient « undefined » ni de JSON brut', () => {
    const errs: AssistantApiError[] = [
      ...ASST_ERROR_CODE_VALUES.map((c) => new AssistantApiError({ status: ASST_ERROR_HTTP_STATUS[c], errorCode: c })),
      ...[0, 401, 403, 429, 500, 501, 503].map((s) => new AssistantApiError({ status: s })),
      new AssistantApiError({ status: 0, kind: 'network' }),
    ];
    for (const e of errs) {
      const m = assistantErrorMessage(e);
      assert.ok(m.length > 0);
      assert.doesNotMatch(m, /undefined|null|[{}[\]]|http_/);
    }
  });
});
