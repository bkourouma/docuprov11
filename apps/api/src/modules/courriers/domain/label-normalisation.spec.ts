import { findLabelConflict, labelDedupKey, normaliseLabel } from './label-normalisation';

describe('normaliseLabel (§16)', () => {
  it('retire les espaces de bordure et compacte les espaces internes', () => {
    expect(normaliseLabel('  Note   de  service  ')).toBe('Note de service');
    expect(normaliseLabel('Officiel')).toBe('Officiel');
  });

  it('ne touche ni à la casse ni aux accents (le libellé reste celui de l’utilisateur)', () => {
    expect(normaliseLabel('MINISTÈRE des Finances')).toBe('MINISTÈRE des Finances');
    expect(normaliseLabel('ministère des FINANCES')).toBe('ministère des FINANCES');
  });

  it('compacte tabulations et sauts de ligne comme des espaces', () => {
    expect(normaliseLabel('Note\tde\nservice')).toBe('Note de service');
  });
});

describe('labelDedupKey (§16)', () => {
  it('rend « Officiel » et « officiel » équivalents — le bug corrigé', () => {
    expect(labelDedupKey('Officiel')).toBe(labelDedupKey('officiel'));
    expect(labelDedupKey('OFFICIEL')).toBe(labelDedupKey('officiel'));
  });

  it('ignore les espaces, comme le dédoublonnage du source', () => {
    expect(labelDedupKey('Note de service')).toBe(labelDedupKey('notedeservice'));
    expect(labelDedupKey('  Note   de service ')).toBe(labelDedupKey('NoteDeService'));
  });

  it('distingue toujours des libellés réellement différents', () => {
    expect(labelDedupKey('Officiel')).not.toBe(labelDedupKey('Officieux'));
  });

  it('conserve les accents : « Reserve » et « Réservé » restent distincts', () => {
    // On ne dépiste PAS les accents : deux libellés accentués différemment sont deux libellés.
    expect(labelDedupKey('Réservé')).not.toBe(labelDedupKey('Reserve'));
  });

  it("est le miroir de l’index SQL lower(replace(label, ' ', ''))", () => {
    const sqlEquivalent = (s: string) => s.replace(/ /g, '').toLowerCase();
    for (const label of ['Officiel', 'Note de service', 'MINISTÈRE des Finances']) {
      expect(labelDedupKey(label)).toBe(sqlEquivalent(label.trim()));
    }
  });
});

describe('findLabelConflict (§16)', () => {
  const existing = [
    { id: 1, label: 'Officiel' },
    { id: 2, label: 'Note de service' },
  ];

  it('détecte un doublon à la casse près', () => {
    expect(findLabelConflict('officiel', existing, null)).toMatchObject({ id: 1 });
    expect(findLabelConflict('  OFFICIEL ', existing, null)).toMatchObject({ id: 1 });
  });

  it('détecte un doublon aux espaces près', () => {
    expect(findLabelConflict('notedeservice', existing, null)).toMatchObject({ id: 2 });
  });

  it('laisse passer un libellé neuf', () => {
    expect(findLabelConflict('Confidentiel', existing, null)).toBeNull();
  });

  it('permet de se renommer soi-même (changement de casse sur son propre libellé)', () => {
    expect(findLabelConflict('OFFICIEL', existing, 1)).toBeNull();
    // …mais pas de prendre le libellé d'un autre.
    expect(findLabelConflict('Note de service', existing, 1)).toMatchObject({ id: 2 });
  });
});
