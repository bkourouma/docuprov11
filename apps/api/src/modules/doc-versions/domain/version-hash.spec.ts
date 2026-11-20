import { createHash } from 'node:crypto';
import { computeVersionHash, sha256Hex } from './version-hash';

describe('sha256Hex', () => {
  it('calcule le SHA-256 hexadécimal minuscule', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('computeVersionHash', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);

  it('une seule pièce : renvoie son empreinte telle quelle', () => {
    expect(computeVersionHash([a])).toBe(a);
  });

  it('plusieurs pièces : SHA-256 des empreintes jointes par un saut de ligne', () => {
    const expected = createHash('sha256').update(`${a}\n${b}`).digest('hex');
    expect(computeVersionHash([a, b])).toBe(expected);
  });

  it("l'ordre des pièces change l'empreinte", () => {
    expect(computeVersionHash([a, b])).not.toBe(computeVersionHash([b, a]));
  });

  it('refuse une liste vide', () => {
    expect(() => computeVersionHash([])).toThrow();
  });
});
