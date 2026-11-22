// Rendu statique léger du bandeau de relecture et du sélecteur de modèles (sans effets : pas de réseau).
// Lancer : cd apps/web && npx tsx --test app/workflows/conception/_components/authoring/authoring.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WfGraph } from '@archivage/types';
import { buildBannerModel, normalizeExplanation, type BannerState } from '../../../_lib/authoring-logic';
import { AuthoringBannerView, type ExplainState } from './AuthoringBanner';
import { TemplatePickerView } from './TemplatePickerModal';

// tsx compile le JSX en transformation classique (tsconfig `jsx: preserve`) : les composants attendent `React` global.
(globalThis as { React?: unknown }).React = React;

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const HOSTILE = '<script>alert(1)</script><img src=x onerror=alert(2)>';

const graph = {
  schemaVersion: 1,
  start: 'a',
  steps: [{ key: 'a', name: 'Validation DAF', type: 'validation', next: [] }],
} as unknown as WfGraph;

const state: BannerState = {
  v: 1,
  assumptions: [`Hypothèse ${HOSTILE}`],
  issues: [{ code: 'X', message: `Problème ${HOSTILE}`, stepKey: 'a' }],
  toComplete: [{ stepKey: 'a', stepName: `Nom ${HOSTILE}`, what: 'assignee', hint: 'DAF' }],
  trigger: { label: `Déclencheur ${HOSTILE}`, eventType: 'document.created' },
};

const view = (explain: ExplainState = { kind: 'idle' }, extra: Record<string, unknown> = {}) => {
  const model = buildBannerModel({ state, graph });
  assert.ok(model);
  return render(
    createElement(AuthoringBannerView, {
      model,
      explain,
      onExplain: () => {},
      onHide: () => {},
      ...extra,
    }),
  );
};

test('bandeau : titre, hypothèses, à compléter, problèmes, déclencheur, boutons', () => {
  const html = view();
  assert.match(html, /Brouillon généré à partir de votre description — à relire avant toute publication/);
  assert.match(html, /Hypothèses à relire \(1\)/);
  assert.match(html, /À compléter \(1\)/);
  assert.match(html, /Problèmes signalés \(1\)/);
  assert.match(html, /Déclencheur suggéré : Déclencheur/);
  assert.match(html, /rien n’a été créé/);
  assert.match(html, /Expliquer ce workflow/);
  assert.match(html, /Masquer/);
  assert.match(html, /3 points à relire/);
  assert.match(html, /aria-live="polite"/);
});

test('bandeau : texte hostile échappé, aucune balise injectée', () => {
  const html = view();
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('bandeau : « Aller à l’étape » seulement si la sélection est possible et l’étape existe', () => {
  assert.doesNotMatch(view(), /Aller à l’étape/);
  const html = view({ kind: 'idle' }, { onSelectStep: () => {}, knownSteps: new Set(['a']) });
  assert.match(html, /Aller à l’étape/);
  assert.doesNotMatch(view({ kind: 'idle' }, { onSelectStep: () => {}, knownSteps: new Set(['z']) }), /Aller à l’étape/);
});

test('bandeau : explication affichée en texte brut, erreur en alerte, chargement annoncé', () => {
  const explanation = normalizeExplanation({
    versionNumber: 1,
    summary: `Résumé ${HOSTILE}`,
    steps: [{ key: 'a', name: 'Étape <b>A</b>', text: `Texte ${HOSTILE}` }],
    toComplete: [],
  });
  assert.ok(explanation);
  const html = view({ kind: 'ready', explanation });
  assert.match(html, /Explication de la dernière version enregistrée \(version n° 1\)/);
  assert.match(html, /Résumé &lt;script&gt;/);
  assert.match(html, /Étape &lt;b&gt;A&lt;\/b&gt; : /);
  assert.doesNotMatch(html, /<script>|<img |<b>A/);
  assert.match(view({ kind: 'error', message: 'Trop de demandes de génération. Réessayez dans 30 s.' }), /role="alert"[^>]*>Trop de demandes/);
  const loading = view({ kind: 'loading' });
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Explication en cours…/);
});

test('bandeau : sans hypothèse, pas de panneau repliable', () => {
  const model = buildBannerModel({ state: { ...state, assumptions: [] }, graph });
  assert.ok(model);
  const html = render(createElement(AuthoringBannerView, { model, explain: { kind: 'idle' }, onExplain: () => {}, onHide: () => {} }));
  assert.doesNotMatch(html, /Hypothèses à relire/);
});

const templates = [
  { key: 'facture_fournisseur', name: `Facture ${HOSTILE}`, description: 'Validation en deux niveaux', agentKey: 'extracteur', tags: ['compta', 'achats'] },
  { key: 'conge', name: 'Demande de congé', description: '', agentKey: null, tags: [] },
];

test('sélecteur de modèles : nom, description, étiquettes, mention agent, texte échappé', () => {
  const html = render(createElement(TemplatePickerView, { templates, query: '', busyKey: null, onQuery: () => {}, onPick: () => {} }));
  assert.match(html, /Demande de congé/);
  assert.match(html, /Validation en deux niveaux/);
  assert.match(html, /Étiquettes : compta, achats/);
  assert.match(html, /Contient une étape agent/);
  assert.match(html, /Utiliser ce modèle/);
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;script&gt;/);
  // Moins de 7 modèles : pas de champ de recherche.
  assert.doesNotMatch(html, /Rechercher un modèle/);
});

test('sélecteur de modèles : création en cours désactive les boutons ; recherche sans résultat', () => {
  const busy = render(createElement(TemplatePickerView, { templates, query: '', busyKey: 'conge', onQuery: () => {}, onPick: () => {} }));
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /Création en cours…/);
  const none = render(createElement(TemplatePickerView, { templates, query: 'zzz', busyKey: null, onQuery: () => {}, onPick: () => {} }));
  assert.match(none, /Aucun modèle ne correspond/);
});
