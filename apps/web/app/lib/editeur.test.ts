// Tests des fonctions pures du client éditeur.
// Lancer : cd apps/web && npx tsx --test app/lib/editeur.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIMIT_MAX_ATTEMPTS,
  closeAction,
  deriveWsUrl,
  docRecreation,
  initials,
  interpretCloseCode,
  isCollabDocument,
  presenceColor,
  sanitizeFilename,
} from './editeur';

test('deriveWsUrl : ws en http, wss en https, wsPath de la session', () => {
  assert.equal(deriveWsUrl('/api/collab', { protocol: 'http:', host: 'localhost:3000' }), 'ws://localhost:3000/api/collab');
  assert.equal(deriveWsUrl('/api/collab', { protocol: 'https:', host: 'docs.exemple.fr' }), 'wss://docs.exemple.fr/api/collab');
  assert.equal(deriveWsUrl('api/collab', { protocol: 'https:', host: 'h' }), 'wss://h/api/collab');
});

test('deriveWsUrl : NEXT_PUBLIC_COLLAB_WS_URL prioritaire', () => {
  assert.equal(deriveWsUrl('/api/collab', { protocol: 'http:', host: 'h' }, ' wss://collab.exemple.fr/ws '), 'wss://collab.exemple.fr/ws');
  assert.equal(deriveWsUrl('/api/collab', { protocol: 'http:', host: 'h' }, ''), 'ws://h/api/collab');
});

test('interpretCloseCode : codes applicatifs', () => {
  assert.equal(interpretCloseCode(4401), 'unauthorized');
  assert.equal(interpretCloseCode(4409), 'limit');
  assert.equal(interpretCloseCode(4410), 'reset');
  assert.equal(interpretCloseCode(4401, 'permission-denied'), 'unauthorized');
  assert.equal(interpretCloseCode(4401, 'unauthorized'), 'unauthorized');
  assert.equal(interpretCloseCode(4401, 'session-expired'), 'session-expired');
  assert.equal(interpretCloseCode(4401, 'Session-Expired'), 'session-expired');
  assert.equal(interpretCloseCode(4409, 'session-expired'), 'limit');
  assert.equal(interpretCloseCode(1006), 'other');
  assert.equal(interpretCloseCode(undefined), 'other');
});

test('isCollabDocument : pièce .ydoc', () => {
  assert.equal(isCollabDocument([{ fileExtension: '.pdf' }]), false);
  assert.equal(isCollabDocument([{ fileExtension: '.html' }, { fileExtension: '.YDOC' }]), true);
  assert.equal(isCollabDocument(null), false);
});

test('presenceColor stable ; initials ; sanitizeFilename', () => {
  assert.equal(presenceColor(7), presenceColor(7));
  assert.equal(initials('Awa Koné'), 'AK');
  assert.equal(initials('  '), '?');
  assert.equal(sanitizeFilename('a/b:c*?.docx'), 'a b c .docx');
  assert.equal(sanitizeFilename('///'), 'document');
});

test('interpretCloseCode : 4409 structure / policy-violation / sans raison / casse', () => {
  assert.equal(interpretCloseCode(4409, 'structure'), 'structure');
  assert.equal(interpretCloseCode(4409, 'Structure'), 'structure');
  assert.equal(interpretCloseCode(4409, 'invalid structure update'), 'structure');
  assert.equal(interpretCloseCode(4409, 'policy-violation'), 'limit');
  assert.equal(interpretCloseCode(4409), 'limit');
  assert.equal(interpretCloseCode(4409, ''), 'limit');
  assert.equal(interpretCloseCode(4410, 'structure'), 'reset');
});

test('closeAction : structure ne reconnecte jamais automatiquement', () => {
  for (let n = 0; n < 10; n++) assert.equal(closeAction('structure', n), 'disconnect-and-reload');
});

test('closeAction : limit = backoff borné, croissant, plafonné, puis abandon', () => {
  const delays: number[] = [];
  let attempts = 0;
  for (let guard = 0; guard < 100; guard++) {
    const a = closeAction('limit', attempts);
    if (typeof a !== 'object') {
      assert.equal(a, 'give-up');
      break;
    }
    assert.equal(a.attempt, attempts + 1);
    delays.push(a.retryInMs);
    attempts = a.attempt;
  }
  assert.equal(delays.length, LIMIT_MAX_ATTEMPTS);
  assert.deepEqual(delays, [5000, 10000, 20000, 30000, 30000]);
  assert.ok(delays.every((d, i) => i === 0 || d >= (delays[i - 1] ?? 0)));
  assert.equal(closeAction('limit', 99), 'give-up');
  assert.deepEqual(closeAction('limit', 0), { retryInMs: 5000, attempt: 1 });
});

test('closeAction : autres fermetures sans reconnexion', () => {
  for (const k of ['other', 'reset', 'unauthorized', 'session-expired'] as const) {
    assert.equal(closeAction(k, 0), 'none');
  }
});

test('docRecreation : Y.Doc propre après reset (immédiat) et structure (sur action)', () => {
  assert.equal(docRecreation('reset'), 'immediate');
  assert.equal(docRecreation('structure'), 'on-user-action');
  assert.equal(docRecreation('limit'), 'never');
  assert.equal(docRecreation('other'), 'never');
});
