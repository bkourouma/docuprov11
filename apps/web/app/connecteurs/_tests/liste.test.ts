// Tests purs (node:test) de l'ordre de la liste des connecteurs (ANO-GED-14). Depuis apps/web :
// `node --import tsx --test app/connecteurs/_tests/liste.test.ts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newestFirst } from '../../lib/connecteurs';

test('newestFirst : le connecteur le plus récent en tête', () => {
  const rows = [1, 7, 3].map((gedSourceConnectorId) => ({ gedSourceConnectorId, label: `c${gedSourceConnectorId}` }));
  assert.deepEqual(
    newestFirst(rows).map((r) => r.gedSourceConnectorId),
    [7, 3, 1],
  );
});

test('newestFirst : ne modifie pas la liste reçue', () => {
  const rows = [{ gedSourceConnectorId: 1 }, { gedSourceConnectorId: 2 }];
  const sorted = newestFirst(rows);
  assert.deepEqual(
    rows.map((r) => r.gedSourceConnectorId),
    [1, 2],
  );
  assert.notEqual(sorted, rows);
});

test('newestFirst : liste vide', () => {
  assert.deepEqual(newestFirst([]), []);
});
