// Rendu statique de l'explication d'une proposition d'agent.
// Lancer : cd apps/web && npx tsx --test app/workflows/boite/_components/AgentProposalPanel.test.ts
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// tsconfig a `jsx: preserve` (Next compile le JSX lui-même) : sous tsx le JSX devient `React.createElement`,
// donc `React` doit exister globalement AVANT le chargement du composant (import dynamique).
type PanelComponent = typeof import('./AgentProposalPanel').AgentProposalPanel;
let AgentProposalPanel: PanelComponent;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ AgentProposalPanel } = await import('./AgentProposalPanel'));
});

interface PanelItem {
  explanation: string | null;
  proposal: unknown;
  sources: unknown;
  confidence: string | null;
}
const base: PanelItem = { explanation: null, proposal: null, sources: null, confidence: null };
const render = (item: Partial<PanelItem>) =>
  renderToStaticMarkup(createElement(AgentProposalPanel, { item: { ...base, ...item } }));

test('explication, proposition texte, sources et confiance', () => {
  const html = render({
    explanation: 'Le montant dépasse le seuil habituel.',
    proposal: { content: 'Refuser la facture.' },
    sources: ['Contrat 2024', { label: 'Annexe 3' }, { documentId: 9 }],
    confidence: '0.8500',
  });
  assert.match(html, /Ce que l’agent propose et pourquoi/);
  assert.match(html, /Le montant dépasse le seuil habituel\./);
  assert.match(html, /Refuser la facture\./);
  assert.match(html, /<li>Contrat 2024<\/li>/);
  assert.match(html, /<li>Annexe 3<\/li>/);
  assert.match(html, /Document n° 9/);
  assert.match(html, /aria-label="Confiance : 85 %"/);
  assert.match(html, /n’a aucun effet tant que vous ne l’avez pas acceptée/);
});

test('proposition objet sans « content » : JSON indenté dans .wf-pre', () => {
  const html = render({ proposal: { approved: true, note: 'ok' } });
  assert.match(html, /<pre class="wf-pre">/);
  assert.match(html, /&quot;approved&quot;: true/);
});

test('le contenu venant de l’agent est échappé et jamais un lien', () => {
  const html = render({
    explanation: '<img src=x onerror=alert(1)>',
    sources: [{ label: '<script>alert(1)</script>', url: 'https://exemple.test' }],
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<a /);
});

test('repli clair quand explication et proposition sont vides', () => {
  const html = render({});
  assert.match(html, /n’a fourni ni explication ni proposition lisible/);
  assert.match(html, /Confiance : non indiquée/);
  assert.match(html, /n’a aucun effet/);
});
