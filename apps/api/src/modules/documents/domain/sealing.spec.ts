import { generateKeyPairSync } from 'node:crypto';
import {
  canonicalSealPayload,
  generateSealingKeyPair,
  keyFingerprint,
  loadSealingKey,
  parseSealPayload,
  sealTimestamp,
  signPayload,
  verifyPayload,
} from './sealing';

const at = (iso: string) => new Date(iso);

describe('canonicalSealPayload — forme canonique', () => {
  it('trie les fichiers par identifiant : l’ordre d’entrée ne change pas la charge', () => {
    const a = canonicalSealPayload({
      documentId: 7,
      files: [
        { fileId: 2, hash: 'b'.repeat(64) },
        { fileId: 1, hash: 'a'.repeat(64) },
      ],
      sealedAt: at('2026-08-01T10:00:00.000Z'),
    });
    const b = canonicalSealPayload({
      documentId: 7,
      files: [
        { fileId: 1, hash: 'a'.repeat(64) },
        { fileId: 2, hash: 'b'.repeat(64) },
      ],
      sealedAt: at('2026-08-01T10:00:00.000Z'),
    });
    expect(a).toBe(b);
  });

  it('inclut l’horodatage — c’est ce qui le rend infalsifiable', () => {
    const payload = canonicalSealPayload({
      documentId: 7,
      files: [{ fileId: 1, hash: 'a'.repeat(64) }],
      sealedAt: at('2026-08-01T10:00:00.000Z'),
    });
    expect(payload).toContain('sealedAt:2026-08-01T10:00:00.000Z');
  });

  it('change si le contenu change', () => {
    const base = { documentId: 7, sealedAt: at('2026-08-01T10:00:00.000Z') };
    const p1 = canonicalSealPayload({ ...base, files: [{ fileId: 1, hash: 'a'.repeat(64) }] });
    const p2 = canonicalSealPayload({ ...base, files: [{ fileId: 1, hash: 'c'.repeat(64) }] });
    expect(p1).not.toBe(p2);
  });
});

describe('sealTimestamp — précision alignée sur la colonne', () => {
  it('tronque les millisecondes', () => {
    expect(sealTimestamp(at('2026-08-01T00:46:51.987Z')).toISOString()).toBe(
      '2026-08-01T00:46:51.000Z',
    );
  });

  it('laisse intacte une date déjà à la seconde', () => {
    expect(sealTimestamp(at('2026-08-01T00:46:51.000Z')).toISOString()).toBe(
      '2026-08-01T00:46:51.000Z',
    );
  });

  /**
   * Régression : `sealed_at` est un TIMESTAMPTZ(0). Signer une date au millième donnait une charge
   * que la relecture ne reconstruisait plus — le cachet se déclarait « contenu modifié » dès son
   * apposition. Ce test rejoue le cycle signer → relire (millisecondes perdues) → recomparer.
   */
  it('permet à la charge de survivre à l’aller-retour en base', () => {
    const files = [{ fileId: 1, hash: 'e'.repeat(64) }];
    const sealedAt = sealTimestamp(at('2026-08-01T00:46:51.987Z'));
    const signe = canonicalSealPayload({ documentId: 5, files, sealedAt });
    // Ce que la base rend : la même date, millisecondes déjà à zéro.
    const relu = canonicalSealPayload({
      documentId: 5,
      files,
      sealedAt: at(sealedAt.toISOString().replace(/\.\d{3}Z$/, '.000Z')),
    });
    expect(relu).toBe(signe);
  });
});

describe('signature Ed25519', () => {
  const { privateKeyPem } = generateSealingKeyPair();
  const { privateKey, publicKey } = loadSealingKey(privateKeyPem);
  const payload = canonicalSealPayload({
    documentId: 42,
    files: [{ fileId: 9, hash: 'd'.repeat(64) }],
    sealedAt: at('2026-08-01T12:00:00.000Z'),
  });

  it('vérifie une signature authentique', () => {
    expect(verifyPayload(payload, signPayload(payload, privateKey), publicKey)).toBe(true);
  });

  it('REJETTE une charge modifiée après signature — cœur de la garantie', () => {
    const signature = signPayload(payload, privateKey);
    const falsifie = payload.replace(
      'sealedAt:2026-08-01T12:00:00.000Z',
      'sealedAt:2020-01-01T00:00:00.000Z',
    );
    expect(verifyPayload(falsifie, signature, publicKey)).toBe(false);
  });

  it('rejette une signature produite par une AUTRE clé', () => {
    const autre = loadSealingKey(generateSealingKeyPair().privateKeyPem);
    expect(verifyPayload(payload, signPayload(payload, autre.privateKey), publicKey)).toBe(false);
  });

  it('rejette une signature illisible sans lever d’exception', () => {
    expect(verifyPayload(payload, 'pas-du-base64-valide!!', publicKey)).toBe(false);
  });
});

describe('parseSealPayload', () => {
  it('relit ce que canonicalSealPayload a produit', () => {
    const input = {
      documentId: 12,
      files: [
        { fileId: 3, hash: 'a'.repeat(64) },
        { fileId: 1, hash: 'b'.repeat(64) },
      ],
      sealedAt: at('2026-08-01T09:30:00.000Z'),
    };
    const parsed = parseSealPayload(canonicalSealPayload(input));
    expect(parsed).not.toBeNull();
    expect(parsed!.documentId).toBe(12);
    expect(parsed!.sealedAt.toISOString()).toBe('2026-08-01T09:30:00.000Z');
    // Relu dans l'ordre canonique (trié), pas dans celui de la saisie.
    expect(parsed!.files).toEqual([
      { fileId: 1, hash: 'b'.repeat(64) },
      { fileId: 3, hash: 'a'.repeat(64) },
    ]);
  });

  it.each([
    ['format inconnu', 'v2|document:1|sealedAt:2026-08-01T00:00:00.000Z|files:'],
    ['date illisible', 'v1|document:1|sealedAt:pas-une-date|files:1:' + 'a'.repeat(64)],
    ['empreinte non SHA-256', 'v1|document:1|sealedAt:2026-08-01T00:00:00.000Z|files:1:trop-court'],
  ])('renvoie null sur une charge %s plutôt que de lever', (_cas, payload) => {
    expect(parseSealPayload(payload)).toBeNull();
  });
});

describe('keyFingerprint', () => {
  it('est stable pour une même clé et distincte entre deux clés', () => {
    const k1 = loadSealingKey(generateSealingKeyPair().privateKeyPem);
    const k2 = loadSealingKey(generateSealingKeyPair().privateKeyPem);
    expect(keyFingerprint(k1.publicKey)).toBe(keyFingerprint(k1.publicKey));
    expect(keyFingerprint(k1.publicKey)).not.toBe(keyFingerprint(k2.publicKey));
    expect(keyFingerprint(k1.publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('loadSealingKey', () => {
  it('refuse une clé qui n’est pas Ed25519', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadSealingKey(pem)).toThrow(/Ed25519/);
  });
});
