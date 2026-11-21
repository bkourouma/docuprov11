import { hashPhone, normalizePhone, principalForPhone } from './whatsapp-phone';

describe('normalizePhone', () => {
  it.each([
    ['221771234567', '221771234567'],
    ['+221771234567', '221771234567'],
    ['+221 77 123 45 67', '221771234567'],
    ['  +221 77 123 45 67  ', '221771234567'],
    ['+221-77-123.45.67', '221771234567'],
    ['+33 6 12 34 56 78', '33612345678'],
    ['+1 (415) 555-0100', '14155550100'],
    ['12345678', '12345678'], // 8 chiffres : minimum admis
    ['123456789012345', '123456789012345'], // 15 chiffres : maximum E.164
  ])('accepte %j -> %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([
    ['0 de tête (numéro national)', '0771234567'],
    ['préfixe international 00 (pas de devinette)', '00221771234567'],
    ['+ suivi de 0', '+0221771234567'],
    ['trop court (7 chiffres)', '1234567'],
    ['trop long (16 chiffres)', '1234567890123456'],
    ['lettres', '22177123abcd'],
    ['chaîne vide', ''],
    ['espaces seulement', '   '],
    ['+ seul', '+'],
    ['double +', '++221771234567'],
    ['+ au milieu', '221+771234567'],
    ['chiffres arabes-indiens', '٢٢١٧٧١٢٣٤٥٦٧'],
    ['caractère de contrôle', '22177123\u00004567'],
    ['plus de 40 caractères', `221771234567${' '.repeat(40)}`],
    ['principal déjà préfixé', 'wa:221771234567'],
  ])('refuse : %s', (_label, raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });

  it.each([
    ['nombre', 221771234567],
    ['null', null],
    ['undefined', undefined],
    ['objet', { phone: '221771234567' }],
    ['tableau', ['221771234567']],
  ])('refuse une non-chaîne : %s', (_label, raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });
});

describe('principalForPhone', () => {
  it('préfixe wa:', () => {
    expect(principalForPhone('221771234567')).toBe('wa:221771234567');
  });
});

describe('hashPhone', () => {
  const KEY = 'cle-secrete-du-connecteur-0123456789';

  it('est déterministe', () => {
    expect(hashPhone('221771234567', KEY)).toBe(hashPhone('221771234567', KEY));
  });

  it('16 caractères hexadécimaux', () => {
    expect(hashPhone('221771234567', KEY)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('dépend de la clé', () => {
    expect(hashPhone('221771234567', KEY)).not.toBe(hashPhone('221771234567', `${KEY}x`));
  });

  it('dépend du numéro', () => {
    expect(hashPhone('221771234567', KEY)).not.toBe(hashPhone('221771234568', KEY));
  });

  it('ne contient pas le numéro, ni un fragment significatif', () => {
    const phone = '221771234567';
    const h = hashPhone(phone, KEY);
    expect(h).not.toContain(phone);
    // Aucun fragment de 6 chiffres consécutifs du numéro.
    for (let i = 0; i + 6 <= phone.length; i++) expect(h).not.toContain(phone.slice(i, i + 6));
  });
});
