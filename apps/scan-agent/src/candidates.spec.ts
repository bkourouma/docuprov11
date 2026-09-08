import {
  contentTypeFor,
  isCandidate,
  markAndCheckStable,
  pruneTracker,
  type StabilityTracker,
} from './candidates';

describe('isCandidate', () => {
  it('accepte les extensions de la file §07, casse indifférente', () => {
    for (const name of [
      'scan.pdf',
      'SCAN.PDF',
      'photo.jpg',
      'a.jpeg',
      'b.png',
      'c.tiff',
      'd.tif',
    ]) {
      expect(isCandidate(name)).toBe(true);
    }
  });

  it("refuse les extensions que l'API rejetterait en 400", () => {
    expect(isCandidate('note.bmp')).toBe(false);
    expect(isCandidate('note.docx')).toBe(false);
    expect(isCandidate('sans-extension')).toBe(false);
  });

  it('ignore les fichiers en cours d’écriture et les fichiers système', () => {
    expect(isCandidate('scan.pdf.tmp')).toBe(false);
    expect(isCandidate('scan.pdf.part')).toBe(false);
    expect(isCandidate('scan.pdf.crdownload')).toBe(false);
    expect(isCandidate('.hidden.pdf')).toBe(false);
    expect(isCandidate('~$note.pdf')).toBe(false);
  });
});

describe('contentTypeFor', () => {
  it('déduit le type du contenu de l’extension', () => {
    expect(contentTypeFor('a.pdf')).toBe('application/pdf');
    expect(contentTypeFor('a.TIF')).toBe('image/tiff');
    expect(contentTypeFor('a.inconnu')).toBe('application/octet-stream');
  });
});

describe('markAndCheckStable', () => {
  const stableMs = 4_000;
  let tracker: StabilityTracker;
  beforeEach(() => {
    tracker = new Map();
  });

  it('ne déclare jamais stable une première observation', () => {
    expect(markAndCheckStable(tracker, 'a.pdf', { size: 10, mtimeMs: 1, at: 0 }, stableMs)).toBe(
      false,
    );
  });

  it('attend le délai complet avec taille et date figées', () => {
    markAndCheckStable(tracker, 'a.pdf', { size: 10, mtimeMs: 1, at: 0 }, stableMs);
    expect(
      markAndCheckStable(tracker, 'a.pdf', { size: 10, mtimeMs: 1, at: 3_999 }, stableMs),
    ).toBe(false);
    expect(
      markAndCheckStable(tracker, 'a.pdf', { size: 10, mtimeMs: 1, at: 4_000 }, stableMs),
    ).toBe(true);
  });

  it('remet le compteur à zéro dès que le fichier grossit encore', () => {
    markAndCheckStable(tracker, 'a.pdf', { size: 10, mtimeMs: 1, at: 0 }, stableMs);
    markAndCheckStable(tracker, 'a.pdf', { size: 50, mtimeMs: 2, at: 5_000 }, stableMs);
    // Le délai repart de 5 000, pas de 0 : à 8 000 on est encore trop tôt.
    expect(
      markAndCheckStable(tracker, 'a.pdf', { size: 50, mtimeMs: 2, at: 8_000 }, stableMs),
    ).toBe(false);
    expect(
      markAndCheckStable(tracker, 'a.pdf', { size: 50, mtimeMs: 2, at: 9_000 }, stableMs),
    ).toBe(true);
  });

  it('détecte une réécriture à taille égale via la date de modification', () => {
    markAndCheckStable(tracker, 'a.pdf', { size: 10, mtimeMs: 1, at: 0 }, stableMs);
    expect(
      markAndCheckStable(tracker, 'a.pdf', { size: 10, mtimeMs: 99, at: 9_000 }, stableMs),
    ).toBe(false);
  });

  it('ne déclare jamais stable un fichier vide', () => {
    markAndCheckStable(tracker, 'a.pdf', { size: 0, mtimeMs: 1, at: 0 }, stableMs);
    expect(markAndCheckStable(tracker, 'a.pdf', { size: 0, mtimeMs: 1, at: 9_000 }, stableMs)).toBe(
      false,
    );
  });
});

describe('pruneTracker', () => {
  it('oublie les fichiers qui ont quitté le dossier', () => {
    const tracker = new Map([
      ['a.pdf', 1],
      ['b.pdf', 2],
    ]);
    pruneTracker(tracker, ['a.pdf']);
    expect([...tracker.keys()]).toEqual(['a.pdf']);
  });
});
