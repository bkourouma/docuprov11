import { formatPayload, parsePayload, isOpeningCategory } from '../src/payload';

describe('QR payload contract (DOCUPRO|1|INTERCALAIRE|cat|id)', () => {
  describe('formatPayload', () => {
    it('formats an opening category', () => {
      expect(formatPayload('TYPE_DOCUMENT', 42)).toBe('DOCUPRO|1|INTERCALAIRE|TYPE_DOCUMENT|42');
      expect(formatPayload('DOSSIER', 1387)).toBe('DOCUPRO|1|INTERCALAIRE|DOSSIER|1387');
    });

    it('forces id 0 for BLANK', () => {
      expect(formatPayload('BLANK', 999)).toBe('DOCUPRO|1|INTERCALAIRE|BLANK|0');
    });

    it('rejects a non-positive id for opening categories', () => {
      expect(() => formatPayload('PLAN', 0)).toThrow();
      expect(() => formatPayload('PLAN', -1)).toThrow();
    });
  });

  describe('parsePayload', () => {
    it('parses a valid opening payload', () => {
      expect(parsePayload('DOCUPRO|1|INTERCALAIRE|LOCALISATION|7')).toEqual({
        status: 'ok',
        payload: { category: 'LOCALISATION', id: 7 },
      });
    });

    it('parses a valid BLANK payload', () => {
      expect(parsePayload('DOCUPRO|1|INTERCALAIRE|BLANK|0')).toEqual({
        status: 'ok',
        payload: { category: 'BLANK', id: 0 },
      });
    });

    it('ignores a foreign namespace (treated as no-QR)', () => {
      expect(parsePayload('OTHER|1|INTERCALAIRE|DOSSIER|3').status).toBe('ignore');
    });

    it('ignores an unexpected object', () => {
      expect(parsePayload('DOCUPRO|1|SOMETHING|DOSSIER|3').status).toBe('ignore');
    });

    it('rejects an unknown version', () => {
      expect(parsePayload('DOCUPRO|9|INTERCALAIRE|DOSSIER|3').status).toBe('reject');
    });

    it('rejects an unknown category', () => {
      expect(parsePayload('DOCUPRO|1|INTERCALAIRE|FOO|3').status).toBe('reject');
    });

    it('rejects BLANK with a non-zero id', () => {
      expect(parsePayload('DOCUPRO|1|INTERCALAIRE|BLANK|5').status).toBe('reject');
    });

    it('rejects an opening category with id 0', () => {
      expect(parsePayload('DOCUPRO|1|INTERCALAIRE|TYPE_DOCUMENT|0').status).toBe('reject');
    });

    it('ignores a malformed segment count', () => {
      expect(parsePayload('DOCUPRO|1|INTERCALAIRE|DOSSIER').status).toBe('ignore');
    });

    it('round-trips format -> parse', () => {
      const result = parsePayload(formatPayload('DOSSIER', 1387));
      expect(result).toEqual({ status: 'ok', payload: { category: 'DOSSIER', id: 1387 } });
    });
  });

  describe('isOpeningCategory', () => {
    it('is true for everything except BLANK', () => {
      expect(isOpeningCategory('TYPE_DOCUMENT')).toBe(true);
      expect(isOpeningCategory('BLANK')).toBe(false);
    });
  });
});
