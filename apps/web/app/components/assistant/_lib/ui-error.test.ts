// toUiError / isAbortError.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/_lib/ui-error.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsstErrorCode } from '@archivage/types';
import { AssistantApiError } from '../../../lib/assistant-api';
import { isAbortError, toUiError } from './ui-error';

test('isAbortError reconnaît DOMException et Error nommées AbortError', () => {
  const err = new Error('x');
  err.name = 'AbortError';
  assert.equal(isAbortError(err), true);
  assert.equal(isAbortError(new DOMException('annulé', 'AbortError')), true);
  assert.equal(isAbortError(new Error('autre')), false);
  assert.equal(isAbortError(new DOMException('x', 'NetworkError')), false);
  assert.equal(isAbortError('AbortError'), false);
  assert.equal(isAbortError(null), false);
});

test('toUiError : erreur inconnue -> generic réessayable', () => {
  const ui = toUiError(new TypeError('boom'));
  assert.equal(ui.kind, 'generic');
  assert.equal(ui.retryable, true);
  assert.equal(ui.retryAfterSeconds, null);
  assert.ok(!ui.message.includes('boom'), 'aucun détail technique brut');
});

test('toUiError : 429 sans code -> rate_limited avec délai', () => {
  const ui = toUiError(new AssistantApiError({ status: 429, retryAfterSeconds: 12 }));
  assert.equal(ui.kind, 'rate_limited');
  assert.equal(ui.retryAfterSeconds, 12);
  assert.equal(ui.retryable, true);
  assert.ok(ui.message.includes('12'));
});

test('toUiError : budget_exceeded -> rate_limited', () => {
  const ui = toUiError(new AssistantApiError({ status: 429, errorCode: AsstErrorCode.BudgetExceeded }));
  assert.equal(ui.kind, 'rate_limited');
});

test('toUiError : 503 / assistant_unavailable -> unavailable non réessayable', () => {
  const a = toUiError(new AssistantApiError({ status: 503 }));
  const b = toUiError(new AssistantApiError({ status: 503, errorCode: AsstErrorCode.AssistantUnavailable }));
  for (const ui of [a, b]) {
    assert.equal(ui.kind, 'unavailable');
    assert.equal(ui.retryable, false);
  }
});

test('toUiError : 501 / not_implemented -> not_implemented', () => {
  assert.equal(toUiError(new AssistantApiError({ status: 501 })).kind, 'not_implemented');
  assert.equal(
    toUiError(new AssistantApiError({ status: 500, errorCode: AsstErrorCode.NotImplemented })).kind,
    'not_implemented',
  );
});

test('toUiError : 401 et 403 -> forbidden ; 404 -> not_found', () => {
  assert.equal(toUiError(new AssistantApiError({ status: 401 })).kind, 'forbidden');
  assert.equal(toUiError(new AssistantApiError({ status: 403 })).kind, 'forbidden');
  const nf = toUiError(new AssistantApiError({ status: 404 }));
  assert.equal(nf.kind, 'not_found');
  assert.equal(nf.retryable, false);
});

test('toUiError : réseau -> network réessayable', () => {
  const ui = toUiError(new AssistantApiError({ status: 0, kind: 'network' }));
  assert.equal(ui.kind, 'network');
  assert.equal(ui.retryable, true);
});

test('toUiError : 500 générique réessayable, 400 non', () => {
  const e500 = toUiError(new AssistantApiError({ status: 500 }));
  assert.equal(e500.kind, 'generic');
  assert.equal(e500.retryable, true);
  assert.equal(toUiError(new AssistantApiError({ status: 400 })).retryable, false);
});
