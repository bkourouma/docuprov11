import { MetaDataType } from '@archivage/types';
import { MetadataValueError, normalizeMetadataValue } from './metadata-value';

const raw = (value: string | null, metaDataListItemId?: number | null) => ({
  metaDataId: 1,
  value,
  metaDataListItemId,
});

describe('normalizeMetadataValue — champ vidé', () => {
  it.each([
    ['texte', MetaDataType.Texte],
    ['texte long', MetaDataType.TexteLong],
    ['entier', MetaDataType.Entier],
    ['date', MetaDataType.Date],
    ['booléen', MetaDataType.Booleen],
  ])('renvoie null pour un %s vide ou blanc', (_label, dataType) => {
    expect(normalizeMetadataValue(dataType, raw(''))).toBeNull();
    expect(normalizeMetadataValue(dataType, raw('   '))).toBeNull();
    expect(normalizeMetadataValue(dataType, raw(null))).toBeNull();
  });

  it('renvoie null pour une liste sans élément choisi', () => {
    expect(normalizeMetadataValue(MetaDataType.Liste, raw(null, null))).toBeNull();
  });
});

describe('normalizeMetadataValue — Texte', () => {
  it('conserve la saisie en retirant les blancs de bord', () => {
    expect(normalizeMetadataValue(MetaDataType.Texte, raw('  FAC-2026-001 '))).toEqual({
      value: 'FAC-2026-001',
      metaDataListItemId: null,
    });
  });
});

describe('normalizeMetadataValue — Entier', () => {
  it('canonise la notation (zéros de tête, signe)', () => {
    expect(normalizeMetadataValue(MetaDataType.Entier, raw('007'))?.value).toBe('7');
    expect(normalizeMetadataValue(MetaDataType.Entier, raw('-42'))?.value).toBe('-42');
  });

  it('refuse un décimal ou un texte', () => {
    expect(() => normalizeMetadataValue(MetaDataType.Entier, raw('12.5'))).toThrow(MetadataValueError);
    expect(() => normalizeMetadataValue(MetaDataType.Entier, raw('5 000'))).toThrow(MetadataValueError);
  });
});

describe('normalizeMetadataValue — Date', () => {
  it('accepte une date civile réelle au format ISO', () => {
    expect(normalizeMetadataValue(MetaDataType.Date, raw('2026-02-28'))).toEqual({
      value: '2026-02-28',
      metaDataListItemId: null,
    });
  });

  it('refuse un mauvais format', () => {
    expect(() => normalizeMetadataValue(MetaDataType.Date, raw('28/02/2026'))).toThrow(MetadataValueError);
  });

  it('refuse une date inexistante malgré le bon format', () => {
    expect(() => normalizeMetadataValue(MetaDataType.Date, raw('2026-02-31'))).toThrow(MetadataValueError);
  });
});

describe('normalizeMetadataValue — Booléen', () => {
  it('accepte true/false quelle que soit la casse', () => {
    expect(normalizeMetadataValue(MetaDataType.Booleen, raw('TRUE'))?.value).toBe('true');
    expect(normalizeMetadataValue(MetaDataType.Booleen, raw('false'))?.value).toBe('false');
  });

  it('refuse oui/non', () => {
    expect(() => normalizeMetadataValue(MetaDataType.Booleen, raw('oui'))).toThrow(MetadataValueError);
  });
});

describe('normalizeMetadataValue — Liste', () => {
  it('ne retient que la clé étrangère, jamais le libellé saisi', () => {
    expect(normalizeMetadataValue(MetaDataType.Liste, raw('Approuvé', 12))).toEqual({
      value: null,
      metaDataListItemId: 12,
    });
  });
});

describe('normalizeMetadataValue — métadonnée non paramétrée', () => {
  it('refuse une saisie sur un type « Aucun »', () => {
    expect(() => normalizeMetadataValue(MetaDataType.Aucun, raw('x'))).toThrow(MetadataValueError);
  });
});
