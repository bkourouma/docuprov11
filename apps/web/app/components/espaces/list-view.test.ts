// Tests de l'état d'affichage de la liste des espaces.
// Lancer : cd apps/web && npx tsx --test app/components/espaces/list-view.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spacesListView } from './list-view';

test('chargement initial sans ligne : squelette', () => {
  assert.equal(spacesListView({ loading: true, rowCount: 0, error: null }), 'loading');
});

test('liste chargée et vide : état vide (invitation à créer)', () => {
  assert.equal(spacesListView({ loading: false, rowCount: 0, error: null }), 'empty');
});

test('échec du chargement sans ligne : état d’erreur, jamais l’état vide (ANO-GED-T2-1)', () => {
  assert.equal(
    spacesListView({ loading: false, rowCount: 0, error: "Vous n'avez pas accès à cette section." }),
    'error',
  );
});

test('lignes présentes : tableau, même pendant un rechargement ou après son échec', () => {
  assert.equal(spacesListView({ loading: false, rowCount: 3, error: null }), 'table');
  assert.equal(spacesListView({ loading: true, rowCount: 3, error: null }), 'table');
  assert.equal(spacesListView({ loading: false, rowCount: 3, error: 'HTTP 500' }), 'table');
});

test('nouveau chargement après un échec : squelette tant que la réponse n’est pas arrivée', () => {
  assert.equal(spacesListView({ loading: true, rowCount: 0, error: 'HTTP 500' }), 'loading');
});
