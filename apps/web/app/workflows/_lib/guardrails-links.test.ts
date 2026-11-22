// Tests des liens des garde-fous des agents et de l'entrée de navigation « Plafonds et arrêt d'urgence ».
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/guardrails-links.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NAV } from '../../components/nav';
import { budgetHref, evaluationHref, toolGrantsHref } from './guardrails-links';

test('toolGrantsHref : chemin figé, null si identifiant invalide', () => {
  assert.equal(toolGrantsHref(12), '/workflows/conception/12/outils');
  for (const bad of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '7' as unknown as number, undefined as unknown as number]) {
    assert.equal(toolGrantsHref(bad), null, String(bad));
  }
});

test('evaluationHref : étape facultative, encodée ; null si identifiant invalide', () => {
  assert.equal(evaluationHref(5), '/workflows/conception/5/evaluation');
  assert.equal(evaluationHref(5, ''), '/workflows/conception/5/evaluation');
  assert.equal(evaluationHref(5, 'tri_courrier'), '/workflows/conception/5/evaluation?etape=tri_courrier');
  assert.equal(evaluationHref(5, 'a b&c=d/é'), '/workflows/conception/5/evaluation?etape=a%20b%26c%3Dd%2F%C3%A9');
  assert.equal(evaluationHref(0, 'x'), null);
  assert.equal(evaluationHref(-1), null);
  assert.equal(evaluationHref(2.5), null);
});

test('budgetHref : chemin figé', () => {
  assert.equal(budgetHref(), '/workflows/administration/plafonds');
});

test('navigation : « Plafonds et arrêt d’urgence » visible exactement avec le menu administration', () => {
  const section = NAV.find((s) => s.label === 'Docu-Flow');
  assert.ok(section);
  const keys = section.items.map((i) => i.key);
  const item = section.items.find((i) => i.key === budgetHref());
  assert.ok(item, 'entrée manquante');
  assert.equal(keys.indexOf(item.key), keys.indexOf('/workflows/administration') + 1, 'juste après l’administration');
  assert.equal(item.label, 'Plafonds et arrêt d’urgence');
  assert.deepEqual(item.altKeys, ['/workflows/administration']);
  // Même règle que AuthShell / CommandPalette : clé propre OU l'une des clés alternatives.
  const visible = (allowed: string[]) =>
    allowed.includes(item.key) || (item.altKeys ?? []).some((k) => allowed.includes(k));
  assert.equal(visible(['/workflows/administration']), true);
  for (const other of [['/workflows/conception'], ['/workflows/lancer'], ['/workflows/boite'], []]) {
    assert.equal(visible(other), false, other.join(','));
  }
});
