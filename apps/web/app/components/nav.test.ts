// Tests du rangement des écrans en modules et en gestes (rail + panneau de navigation).
// Lancer : cd apps/web && npx tsx --test app/components/nav.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODULES, NAV, NAV_FLAT, placeOf, placeOfPath } from './nav';

test('chaque écran de NAV est rangé dans un module, une fois et une seule', () => {
  const ranges = MODULES.flatMap((m) => m.groups.flatMap((g) => g.items.map((i) => i.key)));
  assert.equal(new Set(ranges).size, ranges.length, 'un écran est rangé deux fois');
  assert.deepEqual([...ranges].sort(), NAV_FLAT.map((i) => i.key).sort());
});

test('un module ne déclare aucun écran : il reprend les objets de NAV', () => {
  for (const m of MODULES) {
    for (const g of m.groups) {
      assert.ok(g.items.length > 0, `groupe vide : ${m.label} / ${g.label}`);
      for (const item of g.items) assert.ok(NAV_FLAT.includes(item), item.key);
    }
  }
});

test('les réglages reprennent telles quelles les quatre sections de paramétrage', () => {
  const reglages = MODULES.find((m) => m.id === 'reglages');
  assert.deepEqual(
    reglages?.groups.map((g) => g.label),
    ['Paramétrage Archives', 'Paramétrage Courrier', 'Sécurité Documentaire', 'Administration'],
  );
  for (const g of reglages?.groups ?? []) {
    assert.deepEqual(g.items, NAV.find((s) => s.label === g.label)?.items);
  }
});

test('emplacement d’un écran : module, geste, écran', () => {
  const suivi = placeOf('/courriers/suivi');
  assert.deepEqual(
    [suivi?.module.label, suivi?.group.label, suivi?.item.label],
    ['Docu-Courriers', 'Suivre', 'Suivi des courriers'],
  );
  // Une route fille retombe sur l'écran de menu le plus spécifique.
  assert.equal(placeOfPath('/courriers/suivi/42')?.item.key, '/courriers/suivi');
  assert.equal(
    placeOfPath('/workflows/administration/plafonds')?.item.key,
    '/workflows/administration/plafonds',
  );
  // Écran hors menu : aucun emplacement, la barre retombe sur son titre propre.
  assert.equal(placeOfPath('/profil'), undefined);
});
