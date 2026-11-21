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
