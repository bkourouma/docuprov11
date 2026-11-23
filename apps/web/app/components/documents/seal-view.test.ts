// Tests de l'état d'affichage du cachet serveur (onglet « Sécurité et conformité »).
// Lancer : cd apps/web && npx tsx --test app/components/documents/seal-view.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocumentSealView } from '../../lib/archives';
import { SEAL_UNVERIFIABLE_LABEL, sealBadge, sealErrorMessage, sealView } from './seal-view';

const INTACT: DocumentSealView = {
  sealed: true,
  algorithm: 'Ed25519',
  sealedAt: '2026-11-22T10:00:00.000Z',
  keyFingerprint: 'abcdef0123456789abcdef0123456789',
  knownKey: true,
  signatureValid: true,
  contentMatches: true,
  timestampMatches: true,
};

test('échec du chargement : « Cachet non vérifiable », jamais « Non scellé » (ANO-GED-11)', () => {
  const model = sealView({ seal: null, integrityOk: true, sealError: 'HTTP 500' });
  assert.deepEqual(model.verdict, { label: 'Cachet non vérifiable', tone: null });
  assert.equal(model.verdict.label, SEAL_UNVERIFIABLE_LABEL);
  assert.notEqual(model.verdict.label, 'Non scellé');
  assert.equal(model.section, 'error');
});

test('échec du chargement : aucun geste sur le cachet proposé (ni apposer ni renouveler)', () => {
  assert.equal(sealView({ seal: null, integrityOk: null, sealError: 'Réseau' }).action, null);
});

test('l’échec l’emporte sur un état de cachet résiduel', () => {
  const model = sealView({ seal: INTACT, integrityOk: true, sealError: 'HTTP 503' });
  assert.equal(model.verdict.label, SEAL_UNVERIFIABLE_LABEL);
  assert.equal(model.section, 'error');
  assert.equal(model.action, null);
});

test('chargé et non scellé : « Non scellé », neutre, geste « apposer »', () => {
  const model = sealView({ seal: { sealed: false }, integrityOk: null, sealError: null });
  assert.deepEqual(model.verdict, { label: 'Non scellé', tone: null });
  assert.equal(model.section, 'unsealed');
  assert.equal(model.action, 'apply');
});

test('chargé et scellé intact : « Scellé et intact », geste « renouveler »', () => {
  const model = sealView({ seal: INTACT, integrityOk: true, sealError: null });
  assert.deepEqual(model.verdict, { label: 'Scellé et intact', tone: 'success' });
  assert.equal(model.section, 'sealed');
  assert.equal(model.action, 'renew');
});

test('libellés des autres états inchangés, dans le même ordre de priorité', () => {
  assert.deepEqual(sealBadge({ ...INTACT, knownKey: false }, false, null), {
    label: 'Clé inconnue',
    tone: null,
  });
  assert.deepEqual(sealBadge({ ...INTACT, signatureValid: false, timestampMatches: false }, true, null), {
    label: 'Cachet invalide',
    tone: 'danger',
  });
  assert.deepEqual(sealBadge({ ...INTACT, timestampMatches: false, contentMatches: false }, false, null), {
    label: 'Horodatage altéré',
    tone: 'danger',
  });
  assert.deepEqual(sealBadge({ ...INTACT, contentMatches: false }, false, null), {
    label: 'Contenu du coffre altéré',
    tone: 'danger',
  });
  assert.deepEqual(sealBadge({ ...INTACT, contentMatches: false }, true, null), {
    label: 'Contenu modifié depuis',
    tone: 'warning',
  });
  // Intégrité jamais vérifiée (`null`) : ne dégrade pas un cachet intact.
  assert.equal(sealBadge(INTACT, null, null).label, 'Scellé et intact');
});

test('message d’erreur : celui de l’API, sinon un libellé générique', () => {
  assert.equal(sealErrorMessage(new Error('Service indisponible')), 'Service indisponible');
  assert.equal(sealErrorMessage(new Error('   ')), 'État du cachet indisponible');
  assert.equal(sealErrorMessage('chaîne'), 'État du cachet indisponible');
  assert.equal(sealErrorMessage(undefined), 'État du cachet indisponible');
});
