import { chunkText, normalizeChunkText, pagesFromFiles } from './embedding-chunker';

const sentence = (i: number) => `Phrase numero ${i} du document de test avec quelques mots.`;
const longText = (n: number) => Array.from({ length: n }, (_, i) => sentence(i)).join(' ');

describe('chunkText', () => {
  it('texte vide ou blanc : aucun segment', () => {
    expect(chunkText([])).toEqual([]);
    expect(chunkText([{ page: 1, text: '  \n\t \u0000 ' }])).toEqual([]);
  });

  it('texte court : un seul segment, hash SHA-256 valide, tokens ~ chars/4', () => {
    const [c, ...rest] = chunkText([{ page: null, text: 'Bonjour   le\nmonde.' }]);
    expect(rest).toEqual([]);
    expect(c!.content).toBe('Bonjour le monde.');
    expect(c!.chunkIndex).toBe(0);
    expect(c!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c!.tokenCount).toBe(Math.ceil(17 / 4));
    expect(c!.pageFrom).toBeNull();
    expect(c!.pageTo).toBeNull();
  });

  it('respecte la cible, coupe sur espace, chevauche et couvre tout le texte', () => {
    const text = longText(60);
    const chunks = chunkText([{ page: null, text }], { targetChars: 300, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(5);
    chunks.forEach((c, i) => {
      expect(c.chunkIndex).toBe(i);
      expect(c.content.length).toBeLessThanOrEqual(300);
      expect(c.content).toBe(c.content.trim());
      // jamais de mot coupé : chaque segment est une sous-chaîne du texte, sur mots entiers
      expect(text).toContain(c.content);
      const at = text.indexOf(c.content);
      const after = text[at + c.content.length];
      expect(at === 0 || text[at - 1] === ' ').toBe(true);
      expect(after === undefined || after === ' ').toBe(true);
    });
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.content;
      const firstWord = chunks[i]!.content.split(' ')[0]!;
      // chevauchement : le début du segment suivant figure dans la fin du précédent
      expect(prev.slice(-130).includes(firstWord)).toBe(true);
    }
    expect(chunks[chunks.length - 1]!.content.endsWith('mots.')).toBe(true);
  });

  it('préfère une fin de paragraphe', () => {
    const p1 = longText(4);
    const text = `${p1}\n\n${longText(10)}`;
    const [first] = chunkText([{ page: null, text }], { targetChars: 400, overlapChars: 40 });
    expect(first!.content).toBe(p1);
  });

  it('mot géant > cible : coupe franche, terminaison garantie', () => {
    const giant = 'x'.repeat(2500);
    const chunks = chunkText([{ page: null, text: giant }], { targetChars: 800, overlapChars: 120 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => c.content.length <= 800)).toBe(true);
    expect(chunks.map((c) => c.content).join('').length).toBeGreaterThanOrEqual(2500);
  });

  it('chevauchement >= taille : borné, pas de boucle infinie', () => {
    const chunks = chunkText([{ page: null, text: longText(30) }], {
      targetChars: 100,
      overlapChars: 500,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(2000);
    const tiny = chunkText([{ page: null, text: longText(5) }], { targetChars: 1, overlapChars: 1 });
    expect(tiny.length).toBeGreaterThan(0);
  });

  it('options invalides : valeurs par défaut (800 / 120)', () => {
    const chunks = chunkText([{ page: null, text: longText(100) }], {
      targetChars: -5,
      overlapChars: Number.NaN,
    });
    expect(chunks.every((c) => c.content.length <= 800)).toBe(true);
    expect(chunks.length).toBeGreaterThan(3);
  });

  it('déterministe', () => {
    const pages = [{ page: 1, text: longText(40) }];
    expect(chunkText(pages)).toEqual(chunkText(pages));
  });

  it('pages : plage couverte par chaque segment ; page inconnue => null', () => {
    const pages = [
      { page: 1, text: longText(8) },
      { page: 2, text: '   ' },
      { page: 3, text: longText(8) },
    ];
    const chunks = chunkText(pages, { targetChars: 200, overlapChars: 30 });
    expect(chunks[0]!.pageFrom).toBe(1);
    expect(chunks[chunks.length - 1]!.pageTo).toBe(3);
    expect(chunks.some((c) => c.pageFrom === 1 && c.pageTo === 3)).toBe(true);
    chunks.forEach((c) => expect(c.pageTo! >= c.pageFrom!).toBe(true));

    const mixed = chunkText([
      { page: 1, text: 'un' },
      { page: null, text: 'deux' },
    ]);
    expect(mixed[0]!.pageFrom).toBeNull();
    expect(mixed[0]!.pageTo).toBeNull();
  });

  it('retire les caractères de contrôle (NUL)', () => {
    expect(normalizeChunkText('a\u0000b\r\n\r\nc')).toBe('a b\n\nc');
  });
});

describe('pagesFromFiles', () => {
  it('texte agrégé sans séparateur : page inconnue (null)', () => {
    expect(pagesFromFiles([{ ocrText: 'p1\np2\np3', pageCount: 3 }])).toEqual([
      { page: null, text: 'p1\np2\np3' },
    ]);
  });
  it('sauts de page \\f cohérents avec page_count : pages numérotées', () => {
    expect(pagesFromFiles([{ ocrText: 'a\fb', pageCount: 2 }])).toEqual([
      { page: 1, text: 'a' },
      { page: 2, text: 'b' },
    ]);
  });
  it('fichier d’une page puis fichier suivant : décalage cumulé', () => {
    expect(
      pagesFromFiles([
        { ocrText: 'x', pageCount: 1 },
        { ocrText: 'y\fz', pageCount: 2 },
      ]).map((p) => p.page),
    ).toEqual([1, 2, 3]);
  });
  it('décompte incohérent : null, puis décalage conservé via page_count', () => {
    expect(
      pagesFromFiles([
        { ocrText: 'a\fb\fc', pageCount: 2 },
        { ocrText: 'z', pageCount: 1 },
      ]).map((p) => p.page),
    ).toEqual([null, null, null, 3]);
  });
  it('page_count inconnu sans séparateur : inconnu et décalage perdu', () => {
    expect(
      pagesFromFiles([
        { ocrText: 'a', pageCount: null },
        { ocrText: 'b', pageCount: 1 },
      ]).map((p) => p.page),
    ).toEqual([null, null]);
  });
  it('texte nul : entrée vide ignorée par le chunker', () => {
    expect(chunkText(pagesFromFiles([{ ocrText: null, pageCount: 1 }]))).toEqual([]);
  });
});
