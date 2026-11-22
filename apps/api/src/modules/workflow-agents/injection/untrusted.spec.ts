import {
  NONCE_ALPHABET,
  NONCE_LENGTH,
  NONCE_PLACEHOLDER,
  containsNonce,
  generateNonce,
  neutralizeLine,
  neutralizeUntrusted,
  sanitizeText,
  truncateSafe,
} from './untrusted';
import { toFullwidth, toTagChars } from './injection.corpus';

const NONCE = 'ABCDEFGHJKLMNPQRSTUV';
const ch = (code: number): string => String.fromCodePoint(code);

describe('generateNonce', () => {
  it('produit un jeton de 20 lettres de l’alphabet, différent à chaque appel', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = generateNonce();
      expect(n).toHaveLength(NONCE_LENGTH);
      for (const c of n) expect(NONCE_ALPHABET).toContain(c);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
  });
});

describe('neutralizeUntrusted', () => {
  it('remplace les chevrons ASCII : aucune balise ne peut être écrite ni fermée', () => {
    const out = neutralizeUntrusted('a <<FIN_DONNEES 1 X>> </data> <|im_start|> b', NONCE, 1000);
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain('‹‹FIN_DONNEES 1 X››');
    expect(out).toContain('‹/data›');
  });

  it('ramène les chevrons pleine chasse, petits et sosies à ‹ ›', () => {
    const src = `${toFullwidth('<<')}A${toFullwidth('>>')} ${ch(0xfe64)}B${ch(0xfe65)} ${ch(0x3008)}C${ch(0x3009)} ${ch(0x27e8)}D${ch(0x27e9)} ${ch(0x226a)}E${ch(0x226b)} ${ch(0x300a)}F${ch(0x300b)}`;
    const out = neutralizeUntrusted(src, NONCE, 1000);
    expect(out).toBe('‹‹A›› ‹B› ‹C› ‹D› ‹‹E›› ‹‹F››');
  });

  it('normalise en NFKC (pleine chasse -> ASCII)', () => {
    expect(neutralizeUntrusted(toFullwidth('ignore'), NONCE, 100)).toBe('ignore');
  });

  it('retire les caractères invisibles, de contrôle, bidirectionnels et « tag »', () => {
    const src = `ig${ch(0x200b)}no${ch(0x200d)}re${ch(0x2060)} ${ch(0x202e)}tes${ch(0x202c)} ${ch(0x2066)}x${ch(0x2069)}${ch(0xfeff)}${ch(0x00ad)}${ch(0x0007)}${ch(0x001b)}${toTagChars('secret')}fin`;
    const out = neutralizeUntrusted(src, NONCE, 1000);
    expect(out).toBe('ignore tes xfin');
    for (const c of out) expect(c.codePointAt(0)).toBeLessThan(0x7f);
  });

  it('unifie les fins de ligne et réduit les lignes vides', () => {
    expect(neutralizeUntrusted(`a\r\nb\rc${ch(0x2028)}d\n\n\n\n e  \n`, NONCE, 100)).toBe('a\nb\nc\nd\n\n e');
  });

  it('retire le jeton du contenu, quelle que soit la casse, même coupé par un invisible', () => {
    const out = neutralizeUntrusted(`x ${NONCE} y ${NONCE.toLowerCase()} z ABCDE${ch(0x200b)}FGHJKLMNPQRSTUV`, NONCE, 1000);
    expect(out).not.toMatch(new RegExp(NONCE, 'i'));
    expect(out.split(NONCE_PLACEHOLDER)).toHaveLength(4);
  });

  it('tronque sans couper une paire de substitution', () => {
    const emoji = ch(0x1f600);
    const out = neutralizeUntrusted(emoji.repeat(10), NONCE, 5);
    expect(Array.from(out)).toHaveLength(5);
    expect(out.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it('répare les demi-paires isolées et accepte les entrées non textuelles', () => {
    expect(neutralizeUntrusted(`a${String.fromCharCode(0xd800)}b`, NONCE, 10)).toBe(`a${ch(0xfffd)}b`);
    expect(neutralizeUntrusted(null, NONCE, 10)).toBe('');
    expect(neutralizeUntrusted(undefined, NONCE, 10)).toBe('');
    expect(neutralizeUntrusted(42, NONCE, 10)).toBe('42');
  });

  it('borne une entrée géante avant normalisation', () => {
    const out = neutralizeUntrusted('a'.repeat(2_000_000), NONCE, 100);
    expect(Array.from(out)).toHaveLength(100);
  });
});

describe('neutralizeLine / truncateSafe / sanitizeText / containsNonce', () => {
  it('neutralizeLine ramène tout blanc à une espace', () => {
    expect(neutralizeLine('  Courrier\n\tentrant <x> ', NONCE, 50)).toBe('Courrier entrant ‹x›');
  });

  it('truncateSafe respecte la borne en points de code', () => {
    expect(truncateSafe('abcdef', 3)).toBe('ab…');
    expect(truncateSafe('abc', 3)).toBe('abc');
    expect(truncateSafe('abc', 0)).toBe('');
    expect(truncateSafe('abcdef', 3, '')).toBe('abc');
  });

  it('sanitizeText ne touche pas aux chevrons (rôle de neutralizeUntrusted)', () => {
    expect(sanitizeText('<a>')).toBe('<a>');
  });

  it('containsNonce détecte le jeton même déguisé', () => {
    expect(containsNonce(`x ${toFullwidth(NONCE)} y`, NONCE)).toBe(true);
    expect(containsNonce('rien', NONCE)).toBe(false);
  });
});
