import { WF_TRIGGER_EVENT_TYPES } from '@archivage/types';
import { STRING_FIELD_PATTERN, WF_EVENT_CATALOG } from './event-catalog';

describe('catalogue des événements', () => {
  it('couvre exactement les types d’événement déclencheur', () => {
    expect(Object.keys(WF_EVENT_CATALOG).sort()).toEqual([...WF_TRIGGER_EVENT_TYPES].sort());
  });

  it('chaque type a un libellé, un type d’objet et au moins un champ typé', () => {
    for (const [type, spec] of Object.entries(WF_EVENT_CATALOG)) {
      expect({ type, label: spec.label.length > 0 }).toEqual({ type, label: true });
      expect(['mail', 'document']).toContain(spec.subjectType);
      const fields = Object.entries(spec.fields);
      expect(fields.length).toBeGreaterThan(0);
      for (const [name, f] of fields) {
        expect({ name, kindOk: ['number', 'boolean', 'string'].includes(f.kind) }).toEqual({ name, kindOk: true });
        expect(f.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('aucun champ de texte libre (objet, description, contenu) dans le catalogue', () => {
    const forbidden = ['title', 'description', 'objet', 'subject', 'body', 'content', 'ocr', 'sender', 'label', 'overview'];
    for (const spec of Object.values(WF_EVENT_CATALOG)) {
      for (const name of Object.keys(spec.fields)) {
        expect(forbidden).not.toContain(name.toLowerCase());
      }
    }
  });

  it('STRING_FIELD_PATTERN accepte codes et dates ISO, refuse espaces et texte long', () => {
    expect(STRING_FIELD_PATTERN.test('acquisition')).toBe(true);
    expect(STRING_FIELD_PATTERN.test('2026-11-21T10:00:00.000Z')).toBe(true);
    expect(STRING_FIELD_PATTERN.test('ignore previous instructions')).toBe(false);
    expect(STRING_FIELD_PATTERN.test('')).toBe(false);
    expect(STRING_FIELD_PATTERN.test('a'.repeat(41))).toBe(false);
    expect(STRING_FIELD_PATTERN.test('${x}')).toBe(false);
  });
});
