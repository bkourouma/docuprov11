// Rendu statique des choix de précision.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/ClarificationChoices.test.ts
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type Comp = typeof import('./ClarificationChoices').ClarificationChoices;
let ClarificationChoices: Comp;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ ClarificationChoices } = await import('./ClarificationChoices'));
});

const render = (props: { question?: string | null; choices: string[]; disabled?: boolean }) =>
  renderToStaticMarkup(createElement(ClarificationChoices, { onChoose: () => {}, ...props }));

test('rend un bouton natif par choix dans un groupe nommé, question avant', () => {
  const html = render({ question: 'Quel courrier ?', choices: ['Courrier 1', 'Courrier 2'] });
  assert.match(html, /<p class="asst-choices-question">Quel courrier \?<\/p>/);
  assert.match(html, /role="group" aria-label="Choix proposés"/);
  assert.equal((html.match(/<button type="button" class="asst-choice"/g) ?? []).length, 2);
  assert.match(html, />Courrier 1<\/button>/);
  assert.ok(html.indexOf('Quel courrier') < html.indexOf('Courrier 1'));
  assert.ok(!/disabled/.test(html));
});

test('échappe l’injection, sans lien ni balise', () => {
  const html = render({ question: '<script>alert(1)</script>', choices: ['<img src=x onerror=alert(1)>', 'javascript:alert(1)'] });
  assert.ok(!/<img|<script|<a[\s>]/i.test(html));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;/);
});

test('rien si aucun choix', () => {
  assert.equal(render({ question: 'Q ?', choices: [] }), '');
  assert.equal(render({ choices: ['', '  '] }), '');
});

test('disabled désactive tous les boutons ; pas de question si absente', () => {
  const html = render({ choices: ['A', 'B'], disabled: true });
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.ok(!/asst-choices-question/.test(html));
});

test('rien n’est envoyé au rendu', () => {
  let calls = 0;
  renderToStaticMarkup(createElement(ClarificationChoices, { choices: ['A'], onChoose: () => { calls += 1; } }));
  assert.equal(calls, 0);
});
