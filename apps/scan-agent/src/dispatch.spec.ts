import { failureNote, nthName, sentSubdir } from './dispatch';

describe('sentSubdir', () => {
  it('classe par jour UTC', () => {
    expect(sentSubdir(new Date('2026-07-24T23:30:00Z'))).toBe('2026-07-24');
  });
});

describe('nthName', () => {
  it('rend le nom inchangé au premier essai', () => {
    expect(nthName('scan.pdf', 1)).toBe('scan.pdf');
  });

  it('suffixe avant l’extension', () => {
    expect(nthName('scan.pdf', 2)).toBe('scan (2).pdf');
    expect(nthName('scan.final.pdf', 3)).toBe('scan.final (3).pdf');
  });

  it('gère un nom sans extension', () => {
    expect(nthName('scan', 2)).toBe('scan (2)');
  });
});

describe('failureNote', () => {
  it('conserve le nom d’origine et le motif', () => {
    const note = failureNote('scan.pdf', 'HTTP 400 — Extension non acceptée', new Date(0));
    expect(note).toContain('scan.pdf');
    expect(note).toContain('Extension non acceptée');
    expect(note).toContain('1970-01-01T00:00:00.000Z');
  });
});
