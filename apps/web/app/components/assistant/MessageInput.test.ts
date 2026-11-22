// Rendu statique de la zone de saisie.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/MessageInput.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ASST_MESSAGE_MAX_CHARS } from '@archivage/types';

type Input = typeof import('./MessageInput').MessageInput;
let MessageInput: Input;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ MessageInput } = await import('./MessageInput'));
});

interface Opts {
  value?: string;
  sending?: boolean;
  blocked?: boolean;
  blockedMessage?: string | null;
}
function render(o: Opts = {}): string {
  return renderToStaticMarkup(
    createElement(MessageInput, {
      value: o.value ?? '',
      onChange: () => {},
      onSubmit: () => {},
      sending: o.sending ?? false,
      blocked: o.blocked ?? false,
      blockedMessage: o.blockedMessage,
      onCancel: () => {},
    }),
  );
}

test('état normal : formulaire, label, aide, Envoyer désactivé si vide', () => {
  const html = render();
  assert.match(html, /<form/);
  assert.match(html, /<textarea/);
  assert.match(html, /Votre message à l’assistant/);
  assert.match(html, /Entrée pour envoyer, Maj\+Entrée pour un saut de ligne/);
  assert.match(html, /type="submit"/);
  assert.match(html, /<button[^>]*disabled[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled/);
  assert.doesNotMatch(html, /Arrêter l’attente/);
  assert.doesNotMatch(html, /role="alert"/);
});

test('texte valide : Envoyer actif', () => {
  const html = render({ value: 'Bonjour' });
  const btn = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '';
  assert.ok(btn !== '');
  assert.doesNotMatch(btn, /disabled/);
});

test('bloqué : textarea et bouton désactivés, message d’explication', () => {
  const html = render({ value: 'x', blocked: true, blockedMessage: 'L’assistant est indisponible.' });
  assert.match(html, /L’assistant est indisponible\./);
  assert.match(html.match(/<textarea[^>]*>/)?.[0] ?? '', /disabled/);
  assert.match(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '', /disabled/);
});

test('envoi en cours : « Arrêter l’attente », Envoyer désactivé', () => {
  const html = render({ value: 'Bonjour', sending: true });
  assert.match(html, /Arrêter l’attente/);
  assert.match(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '', /disabled/);
});

test('trop long : alerte et compteur', () => {
  const html = render({ value: 'a'.repeat(ASST_MESSAGE_MAX_CHARS + 1) });
  assert.match(html, /role="alert"[^>]*>Message trop long/);
  assert.match(html, new RegExp(`${ASST_MESSAGE_MAX_CHARS + 1} / ${ASST_MESSAGE_MAX_CHARS}`));
  assert.match(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '', /disabled/);
});

test('compteur seulement au-delà de 80 % du maximum', () => {
  assert.doesNotMatch(render({ value: 'a'.repeat(100) }), /\/ 4000/);
  const html = render({ value: 'a'.repeat(3300) });
  assert.match(html, /3300 \/ 4000/);
  assert.match(html, /aria-describedby="[^"]*asst-input-counter/);
  assert.doesNotMatch(html, /Message trop long/);
});

test('aucun dangerouslySetInnerHTML dans les sources', () => {
  for (const f of ['ConversationList', 'MessageThread', 'MessageInput', 'UiErrorBanner']) {
    const src = fs.readFileSync(path.join(__dirname, `${f}.tsx`), 'utf8');
    assert.ok(!src.includes('dangerouslySetInnerHTML'), f);
    assert.ok(!/innerHTML/.test(src), f);
  }
});
