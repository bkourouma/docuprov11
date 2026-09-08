import { regrouperTopN } from './top-n';

const total = (rows: { valeur: number }[]) => rows.reduce((a, r) => a + r.valeur, 0);

describe('regrouperTopN', () => {
  it('trie par valeur décroissante et conserve tout sous la limite', () => {
    const r = regrouperTopN([
      { cle: 'B', valeur: 5 },
      { cle: 'A', valeur: 12 },
    ]);
    expect(r).toEqual([
      { label: 'A', valeur: 12 },
      { label: 'B', valeur: 5 },
    ]);
  });

  it('agrège le surplus dans « Autres »', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ cle: `E${i}`, valeur: 12 - i }));
    const r = regrouperTopN(rows, { limite: 8 });

    expect(r).toHaveLength(9); // 8 nommées + Autres
    expect(r[8]).toEqual({ label: 'Autres', valeur: 4 + 3 + 2 + 1 });
  });

  it('épingle la tranche nulle en dernier sans la fondre dans « Autres »', () => {
    // « Non renseigné » est une information actionnable (défaut de saisie) : la noyer dans un
    // agrégat la rendrait invisible, alors que c'est souvent la ligne la plus utile.
    const rows = Array.from({ length: 10 }, (_, i) => ({ cle: `E${i}`, valeur: 10 - i }));
    const r = regrouperTopN([...rows, { cle: null, valeur: 99 }], { limite: 8 });

    expect(r.at(-1)).toEqual({ label: '— Non renseigné —', valeur: 99 });
    expect(r.find((t) => t.label === 'Autres')).toBeDefined();
  });

  it('place la tranche nulle en dernier même quand elle domine', () => {
    const r = regrouperTopN([
      { cle: 'A', valeur: 1 },
      { cle: null, valeur: 500 },
    ]);
    expect(r.map((t) => t.label)).toEqual(['A', '— Non renseigné —']);
  });

  it('conserve le total — le camembert doit réconcilier avec le compteur', () => {
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => ({ cle: `E${i}`, valeur: i + 1 })),
      { cle: null, valeur: 7 },
    ];
    expect(total(regrouperTopN(rows, { limite: 8 }))).toBe(total(rows));
  });

  it('omet les tranches vides plutôt que d’afficher des zéros', () => {
    const r = regrouperTopN([{ cle: 'A', valeur: 3 }], { limite: 8 });
    expect(r).toEqual([{ label: 'A', valeur: 3 }]);
  });

  it('accepte des libellés personnalisés', () => {
    const r = regrouperTopN([{ cle: null, valeur: 4 }], { labelNull: '— Non rattaché —' });
    expect(r).toEqual([{ label: '— Non rattaché —', valeur: 4 }]);
  });

  it('gère une entrée vide', () => {
    expect(regrouperTopN([])).toEqual([]);
  });
});
