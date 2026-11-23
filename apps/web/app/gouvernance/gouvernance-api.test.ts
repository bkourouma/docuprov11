// Tests du message d'erreur de la gouvernance.
// Lancer : cd apps/web && npx tsx --test app/gouvernance/gouvernance-api.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GovernanceApiError, errorMessage } from './gouvernance-api';

test('403 de revue : message dédié au niveau d’accès', () => {
  const msg = errorMessage(new GovernanceApiError('forbidden'), 'review');
  assert.equal(msg, 'Votre niveau d’accès ne vous permet pas de relire cette proposition.');
});

test('403 hors revue : message d’accès à la gouvernance inchangé', () => {
  assert.equal(errorMessage(new GovernanceApiError('forbidden')), 'Vous n’avez pas accès à la gouvernance.');
});

// ANO-GED-T4-2 : l'analyse d'un numéro de document inconnu affichait un message sur une « proposition ».
test('404 d’analyse : le message porte sur le document saisi, pas sur une proposition', () => {
  const msg = errorMessage(new GovernanceApiError('not_found'), 'analyze');
  assert.equal(msg, 'Ce document est introuvable, n’est pas archivé ou ne vous est pas accessible.');
  assert.doesNotMatch(msg, /proposition/);
});

test('404 de revue ou de chargement : message de proposition inchangé', () => {
  const expected = 'Cette proposition n’existe plus ou n’est plus accessible.';
  assert.equal(errorMessage(new GovernanceApiError('not_found'), 'review'), expected);
  assert.equal(errorMessage(new GovernanceApiError('not_found')), expected);
});
