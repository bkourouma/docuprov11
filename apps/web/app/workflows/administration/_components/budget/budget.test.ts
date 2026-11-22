// Rendu statique de la carte de consommation et de la confirmation d'arrêt d'urgence.
// Lancer : cd apps/web && npx tsx --test app/workflows/administration/_components/budget/budget.test.ts
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WfBudgetDto } from '@archivage/types';

// tsconfig a `jsx: preserve` : sous tsx le JSX devient `React.createElement`, `React` doit exister globalement
// AVANT le chargement des composants (import dynamique).
type CardComponent = typeof import('./ConsumptionCard').ConsumptionCard;
type ConfirmComponent = typeof import('./EmergencyStopConfirm').EmergencyStopConfirm;
let ConsumptionCard: CardComponent;
let EmergencyStopConfirm: ConfirmComponent;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ ConsumptionCard } = await import('./ConsumptionCard'));
  ({ EmergencyStopConfirm } = await import('./EmergencyStopConfirm'));
});

const budget = (over: Partial<WfBudgetDto>): WfBudgetDto => ({
  wfBudgetId: 1,
  definitionId: null,
  periodKind: 0,
  periodStart: '2026-11-01T00:00:00.000Z',
  capAmount: '1000.0000',
  consumedAmount: '0',
  consumedTokens: '12345',
  alertThreshold: '0.8000',
  currency: 'XOF',
  emergencyStop: false,
  emergencyStopAt: null,
  emergencyStopBy: null,
  emergencyStopReason: null,
  updatedAt: '2026-11-21T00:00:00.000Z',
  updatedBy: null,
  ...over,
});

const card = (b: WfBudgetDto) => renderToStaticMarkup(createElement(ConsumptionCard, { budget: b, title: 'Plafond global', headingId: 'h1' }));

test('carte : niveau ok (72 %)', () => {
  const html = card(budget({ consumedAmount: '720' }));
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="72"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="100"/);
  assert.match(html, /72 % du plafond/);
  assert.match(html, /Niveau ok/);
  assert.match(html, /Dans le budget/);
  assert.match(html, /Mensuel/);
  assert.match(html, /12\s345/);
});

test('carte : niveau attention (85 %)', () => {
  const html = card(budget({ consumedAmount: '850' }));
  assert.match(html, /85 % du plafond/);
  assert.match(html, /Niveau attention/);
  assert.match(html, /data-level="attention"/);
  assert.match(html, /Seuil d’alerte \(indicatif\)/);
});

test('carte : niveau dépassé (120 %, barre bornée à 100)', () => {
  const html = card(budget({ consumedAmount: '1200' }));
  assert.match(html, /120 % du plafond/);
  assert.match(html, /aria-valuenow="100"/);
  assert.match(html, /Niveau dépassé/);
});

test('carte : sans plafond, pas de barre ; arrêt actif avec motif en texte brut', () => {
  const html = card(
    budget({
      capAmount: null,
      emergencyStop: true,
      emergencyStopBy: 7,
      emergencyStopAt: '2026-11-21T10:00:00.000Z',
      emergencyStopReason: '<b>coût</b>',
    }),
  );
  assert.doesNotMatch(html, /role="progressbar"/);
  assert.match(html, /Aucun plafond défini/);
  assert.match(html, /Arrêt d’urgence actif/);
  assert.match(html, /utilisateur n° 7/);
  assert.match(html, /&lt;b&gt;coût&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>coût<\/b>/);
});

const confirm = (typed: string, over: Partial<React.ComponentProps<ConfirmComponent>> = {}) =>
  renderToStaticMarkup(
    createElement(EmergencyStopConfirm, {
      active: true,
      definitionId: null,
      typed,
      reason: '',
      onTypedChange: () => undefined,
      onReasonChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
      ...over,
    }),
  );

const activateButton = (html: string): string => {
  const m = html.match(/<button[^>]*>(?:(?!<\/button>).)*Activer l’arrêt d’urgence(?:(?!<\/button>).)*<\/button>/s);
  assert.ok(m, 'bouton d’activation présent');
  return m[0];
};

test('confirmation : bouton désactivé sans le mot, actif avec le mot', () => {
  const without = confirm('');
  assert.match(without, /Tous les workflows \(arrêt global\)/);
  assert.match(without, /plus aucun appel au modèle d(?:'|&#x27;)IA/);
  assert.match(without, /saisissez le mot/);
  assert.match(activateButton(without), /disabled/);
  assert.match(activateButton(confirm('arret')), /^(?!.*disabled)/s);
  assert.match(activateButton(confirm('ARRÊT')), /^(?!.*disabled)/s);
  assert.match(activateButton(confirm('ARRÊT', { busy: true })), /disabled/);
});

test('confirmation : « Annuler » est le bouton par défaut ; motif trop long bloque', () => {
  const html = confirm('ARRÊT');
  // `autoFocus` (React) donne le focus à « Annuler » au montage côté client ; il n'est pas rendu en HTML statique.
  assert.ok(html.indexOf('Annuler') < html.indexOf('Activer l’arrêt d’urgence'), 'Annuler précède le bouton destructif');
  assert.match(activateButton(confirm('ARRÊT', { reason: 'x'.repeat(501) })), /disabled/);
});

test('levée : confirmation simple, sans mot ni motif', () => {
  const html = confirm('', { active: false, definitionId: 5, workflowName: 'Facturation' });
  assert.match(html, /Lever l’arrêt d’urgence/);
  assert.match(html, /Workflow n° 5 « Facturation »/);
  assert.match(html, /les agents reprennent/);
  assert.doesNotMatch(html, /saisissez le mot/);
  assert.doesNotMatch(html, /Activer l’arrêt d’urgence/);
});
