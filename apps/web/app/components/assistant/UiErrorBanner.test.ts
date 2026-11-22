// Rendu statique du bandeau d'erreur.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/UiErrorBanner.test.ts
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UiError, UiErrorKind } from './_lib/ui-error';

type Banner = typeof import('./UiErrorBanner').UiErrorBanner;
let UiErrorBanner: Banner;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ UiErrorBanner } = await import('./UiErrorBanner'));
});

function err(kind: UiErrorKind, over: Partial<UiError> = {}): UiError {
  return { kind, message: `Message ${kind}`, retryAfterSeconds: null, retryable: true, ...over };
}
const render = (error: UiError, onRetry?: () => void, retryLabel?: string) =>
  renderToStaticMarkup(createElement(UiErrorBanner, { error, onRetry, retryLabel }));

test('chaque kind : message affiché, rôle adapté', () => {
  const kinds: UiErrorKind[] = ['rate_limited', 'unavailable', 'not_implemented', 'forbidden', 'not_found', 'network', 'generic'];
  for (const k of kinds) {
    const html = render(err(k));
    assert.match(html, new RegExp(`Message ${k}`));
    const polite = k === 'rate_limited' || k === 'not_implemented';
    assert.match(html, polite ? /role="status"/ : /role="alert"/);
    assert.doesNotMatch(html, polite ? /role="alert"/ : /role="status"/);
  }
});

test('« Réessayer » seulement si onRetry fourni ET retryable', () => {
  assert.match(render(err('network'), () => {}), /Réessayer/);
  assert.doesNotMatch(render(err('network')), /Réessayer/);
  assert.doesNotMatch(render(err('unavailable', { retryable: false }), () => {}), /Réessayer/);
  assert.match(render(err('network'), () => {}, 'Recharger'), /Recharger/);
});

test('Retry-After affiché', () => {
  assert.match(render(err('rate_limited', { retryAfterSeconds: 12 })), /Réessayez dans 12 s\./);
  assert.doesNotMatch(render(err('rate_limited')), /Réessayez dans/);
});

test('le message est du texte échappé', () => {
  const html = render(err('generic', { message: '<img src=x onerror=alert(1)>' }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
