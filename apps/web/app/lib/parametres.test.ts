// Tests des contrôles locaux du paramétrage e-mail : ils doivent refléter EXACTEMENT les règles de
// l'API (email-template.dto.ts / email-template.service.ts), sans quoi l'écran laisse passer une
// saisie que le serveur refuse ensuite sans message lisible.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOGO_MAX_BYTES, WEBSITE_URL_PATTERN, checkLogoFile } from './parametres';

describe('WEBSITE_URL_PATTERN', () => {
  it('accepte une URL absolue http(s)', () => {
    for (const v of ['https://exemple.ci', 'http://exemple.ci/contact', 'HTTPS://EXEMPLE.CI']) {
      assert.equal(WEBSITE_URL_PATTERN.test(v), true, v);
    }
  });

  it('refuse ce que l’API refuse (y compris ce que `type: url` d’AntD acceptait)', () => {
    for (const v of [
      'exemple.ci',
      'www.exemple.ci',
      '//exemple.ci',
      'ftp://exemple.ci',
      'https://',
    ]) {
      assert.equal(WEBSITE_URL_PATTERN.test(v), false, v);
    }
  });
});

describe('checkLogoFile', () => {
  it('accepte les formats de l’API, quelle que soit la casse de l’extension', () => {
    for (const name of ['logo.png', 'logo.JPG', 'logo.jpeg', 'logo.gif', 'logo.webp']) {
      assert.equal(checkLogoFile({ name, size: 10 }), null, name);
    }
  });

  it('refuse le SVG et les extensions inconnues avec le message de l’API', () => {
    assert.equal(
      checkLogoFile({ name: 'logo.svg', size: 10 }),
      'Format non accepté (.svg) — attendu : .png, .jpg, .jpeg, .gif, .webp',
    );
    assert.match(
      checkLogoFile({ name: 'logo', size: 10 }) ?? '',
      /^Format non accepté \(inconnu\)/,
    );
    // Fichier caché sans extension : `extname('.png')` vaut '' côté Node, même lecture ici.
    assert.match(
      checkLogoFile({ name: '.png', size: 10 }) ?? '',
      /^Format non accepté \(inconnu\)/,
    );
  });

  it('borne le poids à 1 Mo inclus', () => {
    assert.equal(checkLogoFile({ name: 'logo.png', size: LOGO_MAX_BYTES }), null);
    assert.equal(
      checkLogoFile({ name: 'logo.png', size: LOGO_MAX_BYTES + 1 }),
      'Logo trop volumineux (1 Mo maximum)',
    );
  });

  it('refuse un fichier vide', () => {
    assert.equal(checkLogoFile({ name: 'logo.png', size: 0 }), 'Aucun fichier reçu');
  });
});
