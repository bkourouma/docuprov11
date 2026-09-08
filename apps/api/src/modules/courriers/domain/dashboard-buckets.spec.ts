import { bucketAnciennete, bucketPalier } from './dashboard-buckets';

describe('bucketPalier (KPI D4)', () => {
  it('classe une échéance dépassée en « retard », quelle que soit son ancienneté', () => {
    expect(bucketPalier(-1)).toBe('retard');
    expect(bucketPalier(-5)).toBe('retard');
    // Au-delà de -3, le worker n'envoie PLUS aucune relance (§3.6) : la tranche doit quand même
    // capturer ces courriers, sinon ils sortent du radar du tableau de bord comme des rappels.
    expect(bucketPalier(-90)).toBe('retard');
  });

  it("distingue l'échéance du jour", () => {
    expect(bucketPalier(0)).toBe('aujourd_hui');
  });

  it('couvre les jours que les paliers de notification ignorent', () => {
    // Les niveaux de relance sont des valeurs EXACTES : 7, 3, 1, 0. Les valeurs 6, 5, 4 et 2 ne
    // déclenchent rien. Ce test fige que le tableau de bord, lui, ne les perd pas.
    expect(bucketPalier(2)).toBe('j1_j3');
    expect(bucketPalier(4)).toBe('j4_j7');
    expect(bucketPalier(5)).toBe('j4_j7'); // « J-5 » en notation métier = 5 jours restants
    expect(bucketPalier(6)).toBe('j4_j7');
  });

  it('respecte les bornes des tranches', () => {
    expect(bucketPalier(1)).toBe('j1_j3');
    expect(bucketPalier(3)).toBe('j1_j3');
    expect(bucketPalier(7)).toBe('j4_j7');
    expect(bucketPalier(8)).toBe('au_dela');
  });
});

describe('bucketAnciennete (KPI D5)', () => {
  it('respecte les bornes des tranches', () => {
    expect(bucketAnciennete(0)).toBe('moins_7');
    expect(bucketAnciennete(6)).toBe('moins_7');
    expect(bucketAnciennete(7)).toBe('entre_7_15');
    expect(bucketAnciennete(15)).toBe('entre_7_15');
    expect(bucketAnciennete(16)).toBe('entre_16_30');
    expect(bucketAnciennete(30)).toBe('entre_16_30');
    expect(bucketAnciennete(31)).toBe('plus_30');
  });

  it('reste couvrant sur une ancienneté négative (donnée incohérente)', () => {
    // Enregistrement daté dans le futur : anomalie de saisie, relevée par l'hygiène (G),
    // mais le regroupement ne doit pas laisser tomber la ligne au passage.
    expect(bucketAnciennete(-3)).toBe('moins_7');
  });
});
