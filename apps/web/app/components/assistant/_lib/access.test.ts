import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasAssistantMenu } from './access';

test('menu détenu -> accès', () => assert.equal(hasAssistantMenu(['/dashboards', '/assistant']), true));
test('menu absent -> refus', () => assert.equal(hasAssistantMenu(['/dashboards']), false));
test('liste absente, nulle ou vide -> refus par défaut', () => {
  assert.equal(hasAssistantMenu(undefined), false);
  assert.equal(hasAssistantMenu(null), false);
  assert.equal(hasAssistantMenu([]), false);
});
test('une clé voisine ne suffit pas', () => assert.equal(hasAssistantMenu(['/assistant/x', '/assistants']), false));
