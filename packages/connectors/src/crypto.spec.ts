import { createCipheriv, randomBytes } from 'node:crypto';
import {
  CREDENTIALS_REF_REGEX,
  CredentialsCryptoError,
  decryptCredentials,
  encryptCredentials,
  loadKeyRing,
  needsReencryption,
  redactSecrets,
  reencryptCredentials,
  resolveCredentialsRef,
  type KeyRing,
} from './crypto';

// Clés générées à la volée : aucun secret réel dans le dépôt.
const b64Key = (bytes = 32): string => randomBytes(bytes).toString('base64');

const CREDS = { user: 'archiviste@example.org', password: 'MotDePasse-Tres-Secret-42' };

/** Capture l'erreur levée (et vérifie son type) pour en inspecter le message. */
function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CredentialsCryptoError);
    return e as Error;
  }
  throw new Error('aucune erreur levée');
}

/** Le message d'erreur ne doit contenir AUCUN des secrets donnés (ni leur base64). */
function expectNoLeak(err: Error, secrets: string[]): void {
  for (const s of secrets) {
    expect(err.message).not.toContain(s);
    expect(String(err.stack)).not.toContain(s);
  }
}

/** Retourne un bit à l'octet `index` du binaire de l'enveloppe. */
function flipByte(enc: string, index: number): string {
  const buf = Buffer.from(enc, 'base64');
  const i = index < 0 ? buf.length + index : index;
  buf[i] = (buf[i] as number) ^ 0x01;
  return buf.toString('base64');
}

describe('loadKeyRing', () => {
  it('charge la clé active avec l’identifiant par défaut k1', () => {
    const key = b64Key();
    const ring = loadKeyRing({ GED_CONNECTOR_KEY: key });
    expect(ring.activeKeyId).toBe('k1');
    expect(ring.keys.k1?.equals(Buffer.from(key, 'base64'))).toBe(true);
  });

  it('accepte un identifiant de clé et des clés précédentes (rotation)', () => {
    const ring = loadKeyRing({
      GED_CONNECTOR_KEY: b64Key(),
      GED_CONNECTOR_KEY_ID: 'k3',
      GED_CONNECTOR_KEY_PREVIOUS: ` k1:${b64Key()} , k2:${b64Key()} `,
    });
    expect(ring.activeKeyId).toBe('k3');
    expect(Object.keys(ring.keys).sort()).toEqual(['k1', 'k2', 'k3']);
  });

  it.each([
    ['absente', undefined],
    ['vide', '   '],
    ['trop courte (16 octets)', randomBytes(16).toString('base64')],
    ['trop longue (64 octets)', randomBytes(64).toString('base64')],
    ['non base64', 'pas-du-base64-du-tout!!'],
    ['base64 sans remplissage', randomBytes(32).toString('base64').replace(/=+$/, '')],
    ['base64url', randomBytes(32).toString('base64url')],
  ])('refuse une clé %s, sans jamais l’afficher', (_label, value) => {
    const err = errorOf(() => loadKeyRing({ GED_CONNECTOR_KEY: value }));
    expect(err.message).toMatch(/GED_CONNECTOR_KEY/);
    if (value && value.trim() !== '') expectNoLeak(err, [value]);
  });

  it('identifiant de clé vide → défaut k1', () => {
    expect(
      loadKeyRing({ GED_CONNECTOR_KEY: b64Key(), GED_CONNECTOR_KEY_ID: '  ' }).activeKeyId,
    ).toBe('k1');
  });

  it.each(['k 1', 'k:1', 'k,1', 'é', 'x'.repeat(51)])('refuse l’identifiant de clé %p', (id) => {
    errorOf(() => loadKeyRing({ GED_CONNECTOR_KEY: b64Key(), GED_CONNECTOR_KEY_ID: id }));
  });

  it('refuse les identifiants en double (active/précédente et entre précédentes)', () => {
    errorOf(() =>
      loadKeyRing({ GED_CONNECTOR_KEY: b64Key(), GED_CONNECTOR_KEY_PREVIOUS: `k1:${b64Key()}` }),
    );
    errorOf(() =>
      loadKeyRing({
        GED_CONNECTOR_KEY: b64Key(),
        GED_CONNECTOR_KEY_ID: 'k3',
        GED_CONNECTOR_KEY_PREVIOUS: `k1:${b64Key()},k1:${b64Key()}`,
      }),
    );
  });

  it('refuse une clé précédente mal formée ou de mauvaise taille, sans l’afficher', () => {
    const short = randomBytes(24).toString('base64');
    const err = errorOf(() =>
      loadKeyRing({
        GED_CONNECTOR_KEY: b64Key(),
        GED_CONNECTOR_KEY_ID: 'k2',
        GED_CONNECTOR_KEY_PREVIOUS: `k1:${short}`,
      }),
    );
    expect(err.message).toMatch(/entrée n° 1/);
    expectNoLeak(err, [short]);
    errorOf(() =>
      loadKeyRing({ GED_CONNECTOR_KEY: b64Key(), GED_CONNECTOR_KEY_PREVIOUS: b64Key() }),
    );
    errorOf(() =>
      loadKeyRing({ GED_CONNECTOR_KEY: b64Key(), GED_CONNECTOR_KEY_PREVIOUS: `:${b64Key()}` }),
    );
  });

  it.each(['__proto__', 'constructor'])(
    'un identifiant %p reste une clé propre du trousseau',
    (id) => {
      const ring = loadKeyRing({ GED_CONNECTOR_KEY: b64Key(), GED_CONNECTOR_KEY_ID: id });
      expect(Object.hasOwn(ring.keys, id)).toBe(true);
      const e = encryptCredentials(CREDS, ring);
      expect(e.credentialsKeyId).toBe(id);
      expect(decryptCredentials(e.credentialsEnc, id, ring)).toEqual(CREDS);
    },
  );
});

describe('encryptCredentials / decryptCredentials', () => {
  const ring = loadKeyRing({ GED_CONNECTOR_KEY: b64Key() });

  it('aller-retour', () => {
    const { credentialsEnc, credentialsKeyId } = encryptCredentials(CREDS, ring);
    expect(credentialsKeyId).toBe('k1');
    expect(credentialsEnc).not.toContain(CREDS.password);
    expect(Buffer.from(credentialsEnc, 'base64').toString('latin1')).not.toContain(CREDS.password);
    expect(decryptCredentials(credentialsEnc, credentialsKeyId, ring)).toEqual(CREDS);
  });

  it('aller-retour d’identifiants vides et Unicode', () => {
    const cases: Array<Record<string, string>> = [{}, { jeton: 'éàü-字-🔑' }];
    for (const c of cases) {
      const e = encryptCredentials(c, ring);
      expect(decryptCredentials(e.credentialsEnc, e.credentialsKeyId, ring)).toEqual(c);
    }
  });

  it('enveloppe versionnée : version 1, IV 12 octets, tag 16 octets', () => {
    const { credentialsEnc } = encryptCredentials(CREDS, ring);
    const buf = Buffer.from(credentialsEnc, 'base64');
    expect(buf[0]).toBe(1);
    expect(buf.length).toBe(1 + 12 + 16 + Buffer.byteLength(JSON.stringify(CREDS)));
  });

  it('deux chiffrements du même clair diffèrent (IV aléatoire)', () => {
    const a = encryptCredentials(CREDS, ring).credentialsEnc;
    const b = encryptCredentials(CREDS, ring).credentialsEnc;
    expect(a).not.toBe(b);
    expect(
      Buffer.from(a, 'base64').subarray(1, 13).equals(Buffer.from(b, 'base64').subarray(1, 13)),
    ).toBe(false);
  });

  it.each([
    ['version', 0],
    ['IV', 5],
    ['tag', 20],
    ['texte chiffré (début)', 29],
    ['texte chiffré (fin)', -1],
  ])('refuse une altération : %s', (_label, index) => {
    const { credentialsEnc, credentialsKeyId } = encryptCredentials(CREDS, ring);
    const err = errorOf(() =>
      decryptCredentials(flipByte(credentialsEnc, index), credentialsKeyId, ring),
    );
    expectNoLeak(err, [CREDS.password, CREDS.user, ring.keys.k1!.toString('base64')]);
  });

  it('refuse un chiffré tronqué ou un tag raccourci', () => {
    const { credentialsEnc } = encryptCredentials(CREDS, ring);
    const buf = Buffer.from(credentialsEnc, 'base64');
    errorOf(() => decryptCredentials(buf.subarray(0, 29).toString('base64'), 'k1', ring));
    // Tag réduit à 4 octets : GCM l'accepterait sans `authTagLength` explicite.
    const shortTag = Buffer.concat([buf.subarray(0, 13), buf.subarray(13, 17), buf.subarray(29)]);
    errorOf(() => decryptCredentials(shortTag.toString('base64'), 'k1', ring));
    errorOf(() => decryptCredentials('', 'k1', ring));
    errorOf(() => decryptCredentials('%%%%', 'k1', ring));
  });

  it('AAD : un chiffré n’est pas déchiffrable sous un autre identifiant, même avec la même clé', () => {
    const key = b64Key();
    const twin = loadKeyRing({
      GED_CONNECTOR_KEY: key,
      GED_CONNECTOR_KEY_ID: 'k2',
      GED_CONNECTOR_KEY_PREVIOUS: `k1:${key}`,
    });
    const { credentialsEnc } = encryptCredentials(CREDS, twin);
    expect(decryptCredentials(credentialsEnc, 'k2', twin)).toEqual(CREDS);
    errorOf(() => decryptCredentials(credentialsEnc, 'k1', twin));
  });

  it('refuse la mauvaise clé, sans fuite', () => {
    const other = loadKeyRing({ GED_CONNECTOR_KEY: b64Key() });
    const { credentialsEnc } = encryptCredentials(CREDS, ring);
    const err = errorOf(() => decryptCredentials(credentialsEnc, 'k1', other));
    expectNoLeak(err, [
      CREDS.password,
      CREDS.user,
      ring.keys.k1!.toString('base64'),
      other.keys.k1!.toString('base64'),
    ]);
  });

  it('clé inconnue → message « rotation ? », sans fuite', () => {
    const { credentialsEnc } = encryptCredentials(CREDS, ring);
    const err = errorOf(() => decryptCredentials(credentialsEnc, 'k9', ring));
    expect(err.message).toMatch(/clé de chiffrement inconnue \(rotation \?\)/i);
    expectNoLeak(err, [CREDS.password, ring.keys.k1!.toString('base64')]);
  });

  it('identifiant de clé nul ou hérité d’Object.prototype refusé', () => {
    const { credentialsEnc } = encryptCredentials(CREDS, ring);
    errorOf(() => decryptCredentials(credentialsEnc, null, ring));
    errorOf(() => decryptCredentials(credentialsEnc, 'constructor', ring));
    errorOf(() => decryptCredentials(credentialsEnc, 'toString', ring));
  });

  it('refuse des identifiants non « nom → chaîne » au chiffrement', () => {
    const bad: unknown[] = [
      null,
      [],
      'texte',
      { port: 993 },
      { a: { b: 'c' } },
      JSON.parse('{"__proto__":"x"}'),
    ];
    for (const b of bad) errorOf(() => encryptCredentials(b as Record<string, string>, ring));
  });

  it('refuse un clair valide mais qui n’est pas un objet de chaînes (chiffré forgé avec la clé)', () => {
    // Simule un chiffré produit par un autre outil avec la bonne clé : la forme est revalidée.
    const forge = (payload: unknown): string => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', ring.keys.k1!, iv, { authTagLength: 16 });
      c.setAAD(Buffer.from('docupro-ged-connector-credentials\u0000v1\u0000k1', 'utf8'));
      const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload))), c.final()]);
      return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]).toString('base64');
    };
    expect(decryptCredentials(forge({ a: 'b' }), 'k1', ring)).toEqual({ a: 'b' });
    errorOf(() => decryptCredentials(forge(['a']), 'k1', ring));
    errorOf(() => decryptCredentials(forge({ a: 1 }), 'k1', ring));
    errorOf(() => decryptCredentials(forge('secret-en-clair'), 'k1', ring));
  });

  it('trousseau sans clé active → erreur', () => {
    const broken: KeyRing = { activeKeyId: 'k2', keys: { k1: randomBytes(32) } };
    errorOf(() => encryptCredentials(CREDS, broken));
  });
});

describe('rotation', () => {
  it('chiffré avec k1 ; clé active k2 + k1 en PREVIOUS → déchiffre ; reencrypt donne k2', () => {
    const k1 = b64Key();
    const before = loadKeyRing({ GED_CONNECTOR_KEY: k1, GED_CONNECTOR_KEY_ID: 'k1' });
    const stored = encryptCredentials(CREDS, before);

    const after = loadKeyRing({
      GED_CONNECTOR_KEY: b64Key(),
      GED_CONNECTOR_KEY_ID: 'k2',
      GED_CONNECTOR_KEY_PREVIOUS: `k1:${k1}`,
    });
    expect(needsReencryption(stored.credentialsKeyId, after)).toBe(true);
    expect(decryptCredentials(stored.credentialsEnc, stored.credentialsKeyId, after)).toEqual(
      CREDS,
    );

    const rotated = reencryptCredentials(stored.credentialsEnc, stored.credentialsKeyId, after);
    expect(rotated.credentialsKeyId).toBe('k2');
    expect(needsReencryption(rotated.credentialsKeyId, after)).toBe(false);
    expect(decryptCredentials(rotated.credentialsEnc, rotated.credentialsKeyId, after)).toEqual(
      CREDS,
    );

    // Une fois k1 retirée du trousseau, l'ancien chiffré n'est plus lisible, le nouveau oui.
    const final = loadKeyRing({
      GED_CONNECTOR_KEY: after.keys.k2!.toString('base64'),
      GED_CONNECTOR_KEY_ID: 'k2',
    });
    expect(decryptCredentials(rotated.credentialsEnc, 'k2', final)).toEqual(CREDS);
    expect(errorOf(() => decryptCredentials(stored.credentialsEnc, 'k1', final)).message).toMatch(
      /rotation/,
    );
  });
});

describe('redactSecrets', () => {
  it('masque toute valeur ≥ 4 caractères, y compris ses formes encodées', () => {
    const creds = { user: 'bob', password: 'p@ss w0rd/"x"', token: 'abcd' };
    const text =
      `LOGIN bob p@ss w0rd/"x" refusé ; url=?pw=${encodeURIComponent(creds.password)} ; ` +
      `json={"password":${JSON.stringify(creds.password)}} ; jeton abcd ; b64 ${Buffer.from('abcd').toString('base64')}`;
    const out = redactSecrets(text, creds);
    expect(out).not.toContain(creds.password);
    expect(out).not.toContain(encodeURIComponent(creds.password));
    expect(out).not.toContain('abcd');
    expect(out).not.toContain('YWJjZA');
    // « bob » (3 caractères) n'est pas masqué : trop de faux positifs.
    expect(out).toContain('LOGIN bob ***');
  });

  it('masque la plus longue valeur en entier quand une autre en est un fragment', () => {
    const out = redactSecrets('erreur: secret-long-123', { a: 'secret', b: 'secret-long-123' });
    expect(out).toBe('erreur: ***');
  });

  it('caractères spéciaux d’expression régulière traités littéralement', () => {
    expect(redactSecrets('x a.b*c(d) y aXbbc(d)', { p: 'a.b*c(d)' })).toBe('x *** y aXbbc(d)');
  });

  it('sans identifiants ou texte vide → inchangé', () => {
    expect(redactSecrets('rien', null)).toBe('rien');
    expect(redactSecrets('rien', undefined)).toBe('rien');
    expect(redactSecrets('', { p: 'secret' })).toBe('');
    expect(redactSecrets('rien', { p: 'abc' })).toBe('rien');
  });
});

describe('resolveCredentialsRef', () => {
  const ref = 'GED_CONNECTOR_SECRET_IMAP_COMPTA';

  it('résout un JSON d’identifiants depuis une variable autorisée', () => {
    expect(resolveCredentialsRef(ref, { [ref]: JSON.stringify(CREDS) })).toEqual(CREDS);
  });

  it.each([
    'JWT_SECRET',
    'DATABASE_URL',
    'GED_CONNECTOR_KEY',
    'GED_CONNECTOR_SECRET_',
    'ged_connector_secret_x',
    'GED_CONNECTOR_SECRET_X-Y',
    `${ref}\n`,
    '',
  ])('refuse le nom hors liste blanche %p, même si la variable existe', (name) => {
    const env = {
      [name]: JSON.stringify({ password: 'valeur-sensible-99' }),
      JWT_SECRET: 'jwt-ultra-secret',
    };
    const err = errorOf(() => resolveCredentialsRef(name, env));
    expectNoLeak(err, ['valeur-sensible-99', 'jwt-ultra-secret']);
    expect(CREDENTIALS_REF_REGEX.test(name)).toBe(false);
  });

  it('variable absente ou vide → erreur', () => {
    expect(errorOf(() => resolveCredentialsRef(ref, {})).message).toContain(ref);
    errorOf(() => resolveCredentialsRef(ref, { [ref]: '  ' }));
  });

  it('JSON invalide ou de mauvaise forme → erreur sans afficher la valeur', () => {
    for (const raw of [
      '{"password": "fuite-possible-77"',
      'fuite-possible-77',
      '["fuite-possible-77"]',
      '{"port": 993}',
      'null',
    ]) {
      const err = errorOf(() => resolveCredentialsRef(ref, { [ref]: raw }));
      expectNoLeak(err, ['fuite-possible-77', raw]);
    }
  });
});
