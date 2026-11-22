import {
  classifyMetadataLabel,
  normalizeAmount,
  normalizeDate,
  normalizeField,
  normalizeReference,
} from './piece-fields';

describe('normalisation des champs (déterministe, en code)', () => {
  it('montants : 2 décimales, séparateurs et devises tolérés', () => {
    expect(normalizeAmount('1 250,50 FCFA')).toBe('1250.50');
    expect(normalizeAmount('1.250,50')).toBe('1250.50');
    expect(normalizeAmount('1,250.50')).toBe('1250.50');
    expect(normalizeAmount('1250.5')).toBe('1250.50');
    expect(normalizeAmount('1.250')).toBe('1250.00'); // milliers
    expect(normalizeAmount('12,5 €')).toBe('12.50');
    expect(normalizeAmount('-300')).toBe('-300.00');
    expect(normalizeAmount('abc')).toBeNull();
  });

  it('dates : ISO, jj/mm/aaaa, mois en lettres, calendrier valide', () => {
    expect(normalizeDate('2026-03-12')).toBe('2026-03-12');
    expect(normalizeDate('12/03/2026')).toBe('2026-03-12');
    expect(normalizeDate('12.03.2026')).toBe('2026-03-12');
    expect(normalizeDate('1er février 2026')).toBe('2026-02-01');
    expect(normalizeDate('12 mars 2026')).toBe('2026-03-12');
    expect(normalizeDate('31/02/2026')).toBeNull();
    expect(normalizeDate('bientôt')).toBeNull();
  });

  it('références : ponctuation, casse et préfixes ignorés, sans amputer un mot', () => {
    expect(normalizeReference('N° fac-2026/001')).toBe('FAC2026001');
    expect(normalizeReference('Réf. : FAC 2026 001')).toBe('FAC2026001');
    expect(normalizeReference('NOVA-12')).toBe('NOVA12');
    expect(normalizeReference('---')).toBeNull();
  });

  it('une valeur illisible n’est jamais égale à une valeur lue', () => {
    expect(normalizeField('montant', 'environ mille')).toMatch(/^brut:/);
    expect(normalizeField('montant', 'environ mille')).not.toBe(normalizeField('montant', '1000'));
    expect(normalizeField('objet', 'Achat de Papier')).toBe(normalizeField('objet', 'achat de papier.'));
  });

  it('classement des libellés de métadonnées', () => {
    expect(classifyMetadataLabel('Montant TTC')).toBe('montant');
    expect(classifyMetadataLabel('Date de la facture')).toBe('date');
    expect(classifyMetadataLabel('Fournisseur')).toBe('tiers');
    expect(classifyMetadataLabel('Objet du contrat')).toBe('objet');
    expect(classifyMetadataLabel('Numéro de facture')).toBe('reference');
    expect(classifyMetadataLabel('Service émetteur interne')).toBe('tiers');
    expect(classifyMetadataLabel('Couleur')).toBeNull();
  });
});
