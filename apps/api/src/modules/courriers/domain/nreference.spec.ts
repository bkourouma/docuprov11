import {
  parseReferenceNumber,
  formatReference,
  nextReferenceNumber,
  nextReference,
  NREFERENCE_FALLBACK,
} from './nreference';

describe('nreference (numérotation §05/§19)', () => {
  describe('parseReferenceNumber', () => {
    it('parse une chaîne strictement numérique (zéros initiaux inclus)', () => {
      expect(parseReferenceNumber('00042')).toBe(42);
      expect(parseReferenceNumber(' 7 ')).toBe(7);
    });
    it('renvoie null pour non numérique / vide / null', () => {
      expect(parseReferenceNumber('DEP-2026/12')).toBeNull();
      expect(parseReferenceNumber('12A')).toBeNull();
      expect(parseReferenceNumber('')).toBeNull();
      expect(parseReferenceNumber(null)).toBeNull();
      expect(parseReferenceNumber(undefined)).toBeNull();
    });
  });

  describe('formatReference', () => {
    it('formate sur 5 chiffres (D5) par défaut', () => {
      expect(formatReference(1)).toBe('00001');
      expect(formatReference(42)).toBe('00042');
    });
    it('ne tronque pas au-delà de la largeur', () => {
      expect(formatReference(123456)).toBe('123456');
    });
  });

  describe('nextReferenceNumber', () => {
    it('1 si aucun numéro valide', () => {
      expect(nextReferenceNumber([])).toBe(1);
      expect(nextReferenceNumber([null, undefined, 'X'])).toBe(1);
    });
    it('max + 1 en ignorant les non numériques et les trous', () => {
      expect(nextReferenceNumber(['00003', '00001', 'ABC', null, '00002'])).toBe(4);
    });
  });

  describe('nextReference', () => {
    it('repli "00001" quand aucun existant', () => {
      expect(nextReference([])).toBe(NREFERENCE_FALLBACK);
    });
    it('formate le prochain numéro sur 5 chiffres', () => {
      expect(nextReference(['00009'])).toBe('00010');
    });
  });
});
