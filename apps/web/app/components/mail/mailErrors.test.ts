// Tests des messages d'erreur du module courriers (ANO-COU-16 / ANO-COU-18).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imputationOutcomeMessage, readableApiError, summarizeImputations } from './mailErrors';

const ok = (value: unknown = {}): PromiseFulfilledResult<unknown> => ({
  status: 'fulfilled',
  value,
});
const ko = (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason });

describe('readableApiError', () => {
  it('garde le message métier du serveur', () => {
    assert.equal(
      readableApiError(new Error('Courrier lié introuvable'), 'Création impossible'),
      'Courrier lié introuvable',
    );
  });

  it('traduit le repli technique « HTTP 400 » en message lisible', () => {
    const msg = readableApiError(new Error('HTTP 400'), 'Création impossible');
    assert.equal(msg, 'Saisie refusée par le serveur : vérifiez les champs du formulaire.');
    assert.ok(!msg.includes('HTTP'));
  });

  it('traduit les 5xx et retombe sur le repli pour un statut inconnu', () => {
    assert.equal(
      readableApiError(new Error('HTTP 502'), 'x'),
      'Erreur du serveur : réessayez dans un instant.',
    );
    assert.equal(readableApiError(new Error('HTTP 418'), 'Création impossible'), 'Création impossible');
  });

  it('retombe sur le repli pour une valeur qui n’est pas une Error ou un message vide', () => {
    assert.equal(readableApiError('boom', 'Création impossible'), 'Création impossible');
    assert.equal(readableApiError(new Error('   '), 'Création impossible'), 'Création impossible');
  });
});

describe('summarizeImputations', () => {
  it('tout réussi : aucun échec', () => {
    assert.deepEqual(summarizeImputations([4, 5], [ok(), ok()]), {
      created: 2,
      failedIds: [],
      reasons: [],
    });
  });

  it('échec partiel : garde les destinataires en échec et leurs raisons distinctes', () => {
    const o = summarizeImputations(
      [4, 5, 6, 7],
      [ok(), ko(new Error('Déjà imputé')), ok(), ko(new Error('Déjà imputé'))],
    );
    assert.deepEqual(o, { created: 2, failedIds: [5, 7], reasons: ['Déjà imputé'] });
  });

  it('traduit les erreurs techniques dans les raisons', () => {
    const o = summarizeImputations([4], [ko(new Error('HTTP 403'))]);
    assert.deepEqual(o.reasons, ['Action non autorisée pour votre profil.']);
  });

  it('refuse des résultats non alignés sur les destinataires', () => {
    assert.throws(() => summarizeImputations([4, 5], [ok()]));
  });
});

describe('imputationOutcomeMessage', () => {
  it('null quand tout a réussi', () => {
    assert.equal(imputationOutcomeMessage({ created: 3, failedIds: [], reasons: [] }), null);
  });

  it('échec partiel : « N imputation(s) créée(s), M en échec : raison »', () => {
    assert.deepEqual(
      imputationOutcomeMessage({ created: 2, failedIds: [7], reasons: ['Déjà imputé'] }),
      { level: 'warning', text: '2 imputation(s) créée(s), 1 en échec : Déjà imputé' },
    );
  });

  it('échec total : erreur, raisons jointes', () => {
    assert.deepEqual(
      imputationOutcomeMessage({ created: 0, failedIds: [4, 5], reasons: ['A', 'B'] }),
      { level: 'error', text: 'Aucune imputation créée, 2 en échec : A ; B' },
    );
    assert.deepEqual(imputationOutcomeMessage({ created: 0, failedIds: [4], reasons: ['A'] }), {
      level: 'error',
      text: 'Imputation non créée : A',
    });
  });
});
