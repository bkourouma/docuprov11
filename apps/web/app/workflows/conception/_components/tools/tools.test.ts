// Rendu statique léger de la liste des outils (sans effets : pas de réseau).
// Lancer : cd apps/web && npx tsx --test app/workflows/conception/_components/tools/tools.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildGrantRows } from '../../../_lib/guardrails-logic';
import { ToolsList } from './ToolsList';
import { toEditRows, usedByIndex } from './tools-logic';

// tsx compile le JSX en transformation classique : les composants attendent `React` global.
(globalThis as { React?: unknown }).React = React;

const catalog = [
  { toolKey: 'doc.read', label: 'Lire un document', description: 'Lit le contenu', sideEffect: 0, requiresValidation: false, isEnabled: true },
  { toolKey: 'mail.send', label: 'Envoyer un courriel', description: '<b>x</b>', sideEffect: 2, requiresValidation: true, isEnabled: true },
  { toolKey: 'old.tool', label: 'Ancien outil', description: null, sideEffect: 1, requiresValidation: false, isEnabled: false },
];
const graph = { steps: [{ key: 'a', name: 'Lecture', type: 'agent', agent: { tools: ['doc.read'] } }] };

const render = (rows = toEditRows(buildGrantRows(catalog, [{ toolKey: 'doc.read', maxCallsPerInstance: 3 }, { toolKey: 'zzz', maxCallsPerInstance: null }]))) =>
  renderToStaticMarkup(
    createElement(ToolsList, { rows, usedBy: usedByIndex(graph), onToggle: () => {}, onMaxCalls: () => {} }),
  );

test('liste : en-têtes, cases accessibles, effet en texte, outil utilisé marqué', () => {
  const html = render();
  assert.match(html, /<th scope="col">Autoriser<\/th>/);
  assert.match(html, /Plafond d&#x27;appels par instance/);
  assert.match(html, /Autoriser<span class="wf-sr-only"> l&#x27;outil Lire un document/);
  assert.match(html, /utilisé par l&#x27;étape « Lecture »/);
  assert.match(html, /Lecture seule/i);
  assert.match(html, /irréversible, validation obligatoire/);
  assert.match(html, /value="3"/);
});

test('liste : outil désactivé non autorisable, explication, orpheline signalée', () => {
  const html = render();
  assert.match(html, /Désactivé dans le catalogue : cet outil ne peut pas être autorisé/);
  assert.match(html, /Absent du catalogue/);
  assert.match(html, /n&#x27;existe plus dans le catalogue/);
});

test('liste : texte de l\'API échappé, erreur de plafond sous le champ', () => {
  const rows = toEditRows(buildGrantRows(catalog, [{ toolKey: 'doc.read', maxCallsPerInstance: 3 }])).map((r) =>
    r.toolKey === 'doc.read' ? { ...r, maxCallsText: 'abc' } : r,
  );
  const html = render(rows);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /Saisissez un nombre entier positif/);
});
