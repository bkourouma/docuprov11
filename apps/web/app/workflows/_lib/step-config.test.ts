// Tests de la lecture/écriture tolérante de step.config.
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/step-config.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatConditionValue,
  isValidHours,
  parseConditionValue,
  readChoices,
  readEscalation,
  readFields,
  readItems,
  readManual,
  readMaxAttempts,
  readPriority,
  validateFieldKey,
  writeChoices,
  writeEscalation,
  writeFields,
  writeItems,
  writeManual,
  writeMaxAttempts,
  writePriority,
} from './step-config';

test('readFields accepte objets et chaînes, ignore l’invalide', () => {
  const list = readFields({
    fields: [{ key: 'montant', label: 'Montant', required: true }, 'nom', { label: 'sans clé' }, 42, { key: '' }, null],
  });
  assert.deepEqual(list, [
    { key: 'montant', label: 'Montant', required: true },
    { key: 'nom', required: false },
  ]);
  assert.deepEqual(readFields(undefined), []);
  assert.deepEqual(readItems({ items: 'pas un tableau' }), []);
});

test('writeFields préserve les autres clés et ne mute pas l’entrée', () => {
  const config = Object.freeze({ priority: 2, fields: [{ key: 'a' }] });
  const out = writeFields(config, [{ key: 'b', label: 'B', required: true }, { key: 'c', required: false }]);
  assert.deepEqual(out, { priority: 2, fields: [{ key: 'b', label: 'B', required: true }, { key: 'c' }] });
  assert.deepEqual(config, { priority: 2, fields: [{ key: 'a' }] });
});

test('liste vide : la clé est retirée, objet vide devient undefined', () => {
  assert.deepEqual(writeItems({ items: [{ key: 'a' }], manual: true }, []), { manual: true });
  assert.equal(writeItems({ items: [{ key: 'a' }] }, []), undefined);
  assert.equal(writeFields(undefined, []), undefined);
});

test('choix et décision manuelle', () => {
  assert.deepEqual(readChoices({ choices: ['oui', '', 3, 'non'] }), ['oui', 'non']);
  assert.deepEqual(writeChoices({ manual: true }, ['a', ' ', 'b']), { manual: true, choices: ['a', 'b'] });
  assert.equal(writeChoices({ choices: ['a'] }, []), undefined);
  assert.equal(readManual({ manual: true }), true);
  assert.equal(readManual({ manual: 'true' }), false);
  assert.deepEqual(writeManual({ choices: ['a'] }, true), { choices: ['a'], manual: true });
  assert.deepEqual(writeManual({ choices: ['a'], manual: true }, false), { choices: ['a'] });
});

test('priorité : nombres et mots en lecture, numérique en écriture', () => {
  assert.equal(readPriority({ priority: 2 }), 2);
  assert.equal(readPriority({ priority: 'basse' }), 0);
  assert.equal(readPriority({ priority: 'Haute' }), 2);
  assert.equal(readPriority({ priority: 'urgent' }), undefined);
  assert.equal(readPriority({ priority: 3 }), undefined);
  assert.deepEqual(writePriority({ x: 1 }, 1), { x: 1, priority: 1 });
  assert.equal(writePriority({ priority: 1 }, undefined), undefined);
});

test('maxAttempts borné 1..100', () => {
  assert.equal(readMaxAttempts({ maxAttempts: 3 }), 3);
  assert.equal(readMaxAttempts({ maxAttempts: 0 }), undefined);
  assert.equal(readMaxAttempts({ maxAttempts: 101 }), undefined);
  assert.equal(readMaxAttempts({ maxAttempts: 2.5 }), undefined);
  assert.deepEqual(writeMaxAttempts({ a: 1 }, 100), { a: 1, maxAttempts: 100 });
  assert.deepEqual(writeMaxAttempts({ a: 1, maxAttempts: 5 }, 0), { a: 1 });
  assert.equal(writeMaxAttempts(undefined, undefined), undefined);
});

test('escalade valide et invalide', () => {
  const ok = { assignee: { kind: 'user', id: 7 }, dueInHours: 24, maxEscalations: 2, message: 'Vite' };
  assert.deepEqual(readEscalation({ escalation: ok }), ok);
  const base = { assignee: { kind: 'role', id: 1 } };
  assert.equal(readEscalation({ escalation: { ...base, dueInHours: 0 } }), undefined);
  assert.equal(readEscalation({ escalation: { ...base, dueInHours: 8761 } }), undefined);
  assert.equal(readEscalation({ escalation: base }), undefined);
  assert.equal(readEscalation({ escalation: { ...base, dueInHours: 4, maxEscalations: 6 } }), undefined);
  assert.equal(readEscalation({ escalation: { assignee: { kind: 'initiator' }, dueInHours: 4 } }), undefined);
  assert.equal(readEscalation(undefined), undefined);
});

test('writeEscalation préserve les autres clés et retire sur undefined', () => {
  const esc = { assignee: { kind: 'group' as const, id: 3 }, dueInHours: 12 };
  assert.deepEqual(writeEscalation({ priority: 1 }, esc), { priority: 1, escalation: esc });
  assert.deepEqual(writeEscalation({ priority: 1, escalation: esc }, undefined), { priority: 1 });
  assert.equal(writeEscalation({ escalation: esc }, undefined), undefined);
});

test('bornes d’heures 1..8760', () => {
  assert.equal(isValidHours(1), true);
  assert.equal(isValidHours(8760), true);
  assert.equal(isValidHours(0), false);
  assert.equal(isValidHours(8761), false);
  assert.equal(isValidHours(1.5), false);
  assert.equal(isValidHours(undefined), false);
});

test('parseConditionValue / formatConditionValue : aller-retour', () => {
  assert.equal(parseConditionValue('true', 'eq'), true);
  assert.equal(parseConditionValue('false', 'eq'), false);
  assert.equal(parseConditionValue('null', 'eq'), null);
  assert.equal(parseConditionValue('1000', 'gt'), 1000);
  assert.equal(parseConditionValue('-2.5', 'lt'), -2.5);
  assert.equal(parseConditionValue('urgent  fort', 'eq'), 'urgent  fort');
  assert.equal(parseConditionValue('', 'eq'), '');
  assert.equal(parseConditionValue('"true"', 'eq'), 'true');
  assert.equal(parseConditionValue('quoi que ce soit', 'exists'), undefined);
  assert.deepEqual(parseConditionValue('a, b ,, 3, true', 'in'), ['a', 'b', 3, true]);
  assert.deepEqual(parseConditionValue('', 'in'), []);

  const samples: unknown[] = [true, false, null, 0, 12, -3.5, 'texte avec espaces', 'true', '42', ''];
  for (const v of samples) {
    assert.deepEqual(parseConditionValue(formatConditionValue(v), 'eq'), v, `aller-retour de ${JSON.stringify(v)}`);
  }
  const arr = ['a', 'b', 3, false];
  assert.deepEqual(parseConditionValue(formatConditionValue(arr), 'in'), arr);
  assert.equal(formatConditionValue(undefined), '');
});

test('validateFieldKey', () => {
  assert.equal(validateFieldKey('montant_ht', ['nom']), null);
  assert.match(validateFieldKey('', [])!, /obligatoire/);
  assert.match(validateFieldKey('Montant', [])!, /invalide/);
  assert.match(validateFieldKey('1abc', [])!, /invalide/);
  assert.match(validateFieldKey('a-b', [])!, /invalide/);
  assert.match(validateFieldKey('x'.repeat(101), [])!, /100/);
  assert.match(validateFieldKey('nom', ['nom'])!, /déjà/);
});
