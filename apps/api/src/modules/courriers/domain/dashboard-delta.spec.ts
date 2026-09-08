import { periodePrecedente, variation } from './dashboard-delta';

describe('variation (zone 3)', () => {
  it('calcule un ratio signé', () => {
    expect(variation(125, 100)).toMatchObject({ ratio: 0.25, sens: 'hausse' });
    expect(variation(75, 100)).toMatchObject({ ratio: -0.25, sens: 'baisse' });
    expect(variation(100, 100)).toMatchObject({ ratio: 0, sens: 'stable' });
  });

  it('rend null quand la période précédente vaut 0 — pas de division par zéro', () => {
    // Passer de 0 à 12 est une apparition, pas une hausse de +1200 %. L'écran affichera « — ».
    const r = variation(12, 0);
    expect(r.ratio).toBeNull();
    expect(r.sens).toBe('indetermine');
  });

  it('rend null quand la période précédente est inconnue', () => {
    expect(variation(12, null).ratio).toBeNull();
  });

  it('conserve les valeurs brutes pour affichage', () => {
    expect(variation(12, 0)).toMatchObject({ valeur: 12, precedent: 0 });
  });
});

describe('periodePrecedente', () => {
  it('rend une fenêtre de même durée, contiguë et sans recouvrement', () => {
    const debut = new Date('2026-03-01T00:00:00Z');
    const fin = new Date('2026-03-30T00:00:00Z'); // 29 jours d'écart

    const p = periodePrecedente(debut, fin);

    expect(p.fin).toEqual(new Date('2026-02-28T00:00:00Z')); // la veille du début
    expect(p.debut).toEqual(new Date('2026-01-30T00:00:00Z'));
    expect(p.fin.getTime() - p.debut.getTime()).toBe(fin.getTime() - debut.getTime());
    expect(p.fin.getTime()).toBeLessThan(debut.getTime());
  });
});
