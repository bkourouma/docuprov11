// Rendu statique léger des panneaux (sans effets : pas de réseau).
// Lancer : cd apps/web && npx tsx --test app/workflows/conception/_components/panels/panels.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WfTriggerDto } from '@archivage/types';
import { LowRiskToggle } from './LowRiskToggle';
import { TriggersSlot, TriggersView } from './TriggersSlot';
import { AgentSpecFields } from './AgentSpecFields';

// tsx compile le JSX en transformation classique (tsconfig `jsx: preserve`) : les composants attendent `React` global.
(globalThis as { React?: unknown }).React = React;

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

test('LowRiskToggle : administrateur => interrupteur, sinon pastille lecture seule', () => {
  const admin = render(
    createElement(LowRiskToggle, { isLowRisk: false, canMark: true, busy: false, hasAutonomousStep: false, onChange: () => {} }),
  );
  assert.match(admin, /Workflow à faible risque/);
  assert.match(admin, /role="switch"/);

  const reader = render(
    createElement(LowRiskToggle, { isLowRisk: true, canMark: false, busy: false, hasAutonomousStep: false, onChange: () => {} }),
  );
  assert.match(reader, /Faible risque : oui/);
  assert.match(reader, /Réservé aux administrateurs/);
  assert.doesNotMatch(reader, /role="switch"/);
});

test('LowRiskToggle : retrait bloqué tant qu’une étape autonome existe', () => {
  const html = render(
    createElement(LowRiskToggle, { isLowRisk: true, canMark: true, busy: false, hasAutonomousStep: true, onChange: () => {} }),
  );
  assert.match(html, /disabled/);
  assert.match(html, /étape agent est autonome/);
});

test('TriggersSlot : rien à l’écran au premier rendu (chargement) et sans déclencheur', () => {
  assert.equal(render(createElement(TriggersSlot, { definitionId: 1, loader: async () => null })), '');
  assert.equal(render(createElement(TriggersView, { triggers: null })), '');
  assert.equal(render(createElement(TriggersView, { triggers: [] })), '');
});

test('TriggersView : affiche nom, événement, état et exécutant', () => {
  const t: WfTriggerDto = {
    wfTriggerId: 1,
    definitionId: 1,
    name: 'Facture reçue',
    eventType: 'document.created',
    conditions: {},
    runAsUserGroupId: 42,
    isActive: false,
    lastFiredAt: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const html = render(createElement(TriggersView, { triggers: [t] }));
  assert.match(html, /Déclencheurs/);
  assert.match(html, /Facture reçue/);
  assert.match(html, /document\.created/);
  assert.match(html, /Inactif/);
  assert.match(html, /utilisateur n° 42/);
  // Élision : « en tant qu'utilisateur », jamais « en tant que utilisateur ».
  assert.match(html, /Exécuté en tant qu(’|&#x27;|')utilisateur n° 42/);
  assert.doesNotMatch(html, /en tant que utilisateur/);
});

test('AgentSpecFields : « Autonome » grisé avec son motif tant que non permis', () => {
  const html = render(
    createElement(AgentSpecFields, {
      spec: { objective: 'Trier', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' },
      readOnly: false,
      isLowRisk: false,
      hasPassedEval: null,
      tools: null,
      onChange: () => {},
    }),
  );
  assert.match(html, /Le catalogue d(&#x27;|')outils n(&#x27;|')est pas encore disponible/);
  assert.match(html, /faible risque par un administrateur/);
  assert.match(html, /aria-describedby="[^"]*autonomy-reason/);
});

test('StepPropertiesPanel et EdgePropertiesPanel : rendu sans erreur, blocs selon le type', async () => {
  const { StepPropertiesPanel } = await import('./StepPropertiesPanel');
  const { EdgePropertiesPanel } = await import('./EdgePropertiesPanel');
  const base = {
    stepKeys: ['a', 'b'],
    isStart: true,
    readOnly: true,
    isLowRisk: false,
    hasPassedEval: null,
    tools: null,
    issues: [{ code: 'SELF_LOOP' as const, message: 'x', stepKey: 'a' }],
    onChange: () => {},
    onRenameKey: () => undefined,
    onSetStart: () => {},
    onRemove: () => {},
  };
  const form = render(
    createElement(StepPropertiesPanel, {
      ...base,
      step: { key: 'a', name: 'Saisie', type: 'formulaire', next: [], config: { fields: [{ key: 'montant', required: true }] } },
    }),
  );
  assert.match(form, /Propriétés de l(&#x27;|')étape/);
  assert.match(form, /1 problème sur cette étape/);
  assert.match(form, /Champs du formulaire/);
  assert.match(form, /Escalade/);
  assert.match(form, /Supprimer l(&#x27;|')étape/);
  const agent = render(
    createElement(StepPropertiesPanel, {
      ...base,
      step: { key: 'a', name: 'IA', type: 'agent', next: [], agent: { objective: 'x', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' } },
    }),
  );
  assert.doesNotMatch(agent, /Escalader si/);
  assert.match(agent, /Niveau d(&#x27;|')autonomie/);

  const edge = render(
    createElement(EdgePropertiesPanel, {
      fromName: 'A',
      toName: 'B',
      edge: { to: 'b', condition: { field: 'last.approved', op: 'eq', value: true } },
      position: 1,
      count: 2,
      hasOtherFallback: true,
      readOnly: false,
      onChange: () => {},
      onMove: () => {},
      onRemove: () => {},
    }),
  );
  assert.match(edge, /Propriétés de la transition/);
  assert.match(edge, /Monter/);
  assert.match(edge, /Conditionnelle/);
});
