import { extractFigures, findMoneyAmounts, formatFrenchInteger, parseFrenchNumber } from './authoring.assumptions';

const ZWSP = String.fromCharCode(0x200b);
const NUL = String.fromCharCode(0);
const SUFFIX = '— à vérifier avant publication.';

describe('extractFigures — montants', () => {
  it('« 5 M FCFA » : ligne de relecture avec valeur développée', () => {
    expect(extractFigures('Au-dessus de 5 M FCFA, router vers le DAF.')).toEqual([
      `Seuil lu dans la description : « 5 M FCFA » soit 5 000 000 FCFA ${SUFFIX}`,
    ]);
  });

  it.each([
    ['5 millions de FCFA', '« 5 millions de FCFA »', '5 000 000 FCFA'],
    ['5 000 000 FCFA', '« 5 000 000 FCFA »', '5 000 000 FCFA'],
    ['5000000 F CFA', '« 5000000 F CFA »', '5 000 000 FCFA'],
    ['5.000.000 FCFA', '« 5.000.000 FCFA »', '5 000 000 FCFA'],
    ['500 000 francs', '« 500 000 francs »', '500 000 francs'],
    ['2,5 millions', '« 2,5 millions »', '2 500 000'],
    ['2,5 millions de francs CFA', '« 2,5 millions de francs CFA »', '2 500 000 FCFA'],
    ['1 milliard', '« 1 milliard »', '1 000 000 000'],
    ['3 milliards de FCFA', '« 3 milliards de FCFA »', '3 000 000 000 FCFA'],
    ['10 000 XOF', '« 10 000 XOF »', '10 000 FCFA'],
    ['500 €', '« 500 € »', '500 euros'],
    ['1 200 euros', '« 1 200 euros »', '1 200 euros'],
    ['2 M€', '« 2 M€ »', '2 000 000 euros'],
    ["3 millions d'euros", "« 3 millions d'euros »", '3 000 000 euros'],
    ['1 million', '« 1 million »', '1 000 000'],
    ['750 k FCFA', '« 750 k FCFA »', '750 000 FCFA'],
  ])('« %s »', (text, quote, value) => {
    const lines = extractFigures(`Le montant est de ${text} environ.`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Seuil lu dans la description : ${quote}`);
    expect(lines[0]).toContain(value);
    expect(lines[0]?.endsWith(SUFFIX)).toBe(true);
  });

  it('plusieurs montants dans l’ordre du texte, dédoublonnés', () => {
    const lines = extractFigures('De 1 M FCFA à 5 M FCFA ; si 5 M FCFA est dépassé, alerter.');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('1 000 000 FCFA');
    expect(lines[1]).toContain('5 000 000 FCFA');
  });
});

describe('extractFigures — pourcentages et délais', () => {
  it('pourcentage en ligne distincte', () => {
    expect(extractFigures('Une remise de 10 % est appliquée.')).toEqual([
      `Pourcentage lu dans la description : « 10 % » ${SUFFIX}`,
    ]);
    expect(extractFigures('Taux de 12,5 pour cent.')[0]).toContain('Pourcentage lu');
    expect(extractFigures('Taux de 5%.')[0]).toContain('« 5% »');
  });

  it('délais en jours, heures, jours ouvrés, semaines, mois', () => {
    const lines = extractFigures('Répondre sous 48 heures, relancer à 30 jours, clore sous 3 jours ouvrés puis 2 semaines et 6 mois.');
    expect(lines).toEqual([
      `Délai lu dans la description : « 48 heures » ${SUFFIX}`,
      `Délai lu dans la description : « 30 jours » ${SUFFIX}`,
      `Délai lu dans la description : « 3 jours ouvrés » ${SUFFIX}`,
      `Délai lu dans la description : « 2 semaines » ${SUFFIX}`,
      `Délai lu dans la description : « 6 mois » ${SUFFIX}`,
    ]);
  });

  it('montant, pourcentage et délai se distinguent', () => {
    const lines = extractFigures('Facture de 2 millions de FCFA, escompte de 10 %, paiement sous 30 jours.');
    expect(lines.map((l) => l.split(' lu')[0])).toEqual(['Seuil', 'Pourcentage', 'Délai']);
  });

  it('une heure de la journée n’est pas un délai', () => {
    expect(extractFigures('La réunion a lieu à 10 heures.')).toEqual([]);
  });
});

describe('extractFigures — faux positifs écartés', () => {
  it.each([
    ['année', 'Rapport annuel 2026 du service.'],
    ['référence', 'Dossier n° 12345 et réf. 2026/458-B.'],
    ['date', 'Reçu le 15 mars 2026 à 14h30.'],
    ['numéro', 'Appeler le 07 08 09 10 11.'],
    ['numéro d’article', 'Voir l’article 5 et la page 12.'],
    ['mètres', 'Une salle de 5 mètres sur 3 m.'],
    ['nombre sans unité', 'Fournir 3 pièces et 2 copies.'],
    ['identifiant accolé', 'Le code AB5000FCFA ne compte pas.'],
    ['nombre précédé d’un tiret', 'Formulaire F-5000 francs-tireurs.'],
    ['heures abrégées', 'Rendez-vous à 14 h.'],
    ['vide', ''],
  ])('%s : aucune ligne', (_l, text) => {
    expect(extractFigures(text)).toEqual([]);
  });

  it('entrées non textuelles : liste vide', () => {
    expect(extractFigures(undefined as unknown as string)).toEqual([]);
    expect(extractFigures(null as unknown as string)).toEqual([]);
  });
});

describe('extractFigures — bornes et nettoyage', () => {
  it('au plus 15 lignes', () => {
    const text = Array.from({ length: 40 }, (_v, i) => `${i + 1} jours`).join(', ');
    expect(extractFigures(text)).toHaveLength(15);
  });

  it('texte cité nettoyé : caractères invisibles et contrôles retirés, 60 caractères au plus', () => {
    const lines = extractFigures(`Seuil : 5${ZWSP} 000${NUL} 000 FCFA`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(ZWSP);
    expect(lines[0]).not.toContain(NUL);
    for (const line of extractFigures('Seuil de 5 000 000 000 000 000 000 000 000 000 000 000 000 000 000 000 000 000 000 FCFA.')) {
      const quote = /« (.*?) » (?:soit|—)/.exec(line)?.[1] ?? '';
      expect(Array.from(quote).length).toBeLessThanOrEqual(60);
    }
  });

  it('aucune balise dans les lignes', () => {
    for (const line of extractFigures('<b>5 M FCFA</b> et <script>10 %</script>')) {
      expect(line).not.toMatch(/[<>]/);
    }
  });

  it('entrée géante : traitée vite (lecture bornée)', () => {
    const started = Date.now();
    const lines = extractFigures(`${'a '.repeat(200_000)} 5 M FCFA`);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lines).toEqual([]); // le montant est au-delà de la zone lue
  });
});

describe('utilitaires numériques', () => {
  it('parseFrenchNumber', () => {
    expect(parseFrenchNumber('5 000 000')).toBe(5000000);
    expect(parseFrenchNumber('5.000.000')).toBe(5000000);
    expect(parseFrenchNumber('2,5')).toBe(2.5);
    expect(parseFrenchNumber('5000000')).toBe(5000000);
    expect(parseFrenchNumber('abc')).toBeNull();
  });

  it('formatFrenchInteger', () => {
    expect(formatFrenchInteger(5000000)).toBe('5 000 000');
    expect(formatFrenchInteger(999)).toBe('999');
    expect(formatFrenchInteger(1000)).toBe('1 000');
  });

  it('findMoneyAmounts expose les valeurs', () => {
    const [a] = findMoneyAmounts('Au-dessus de 5 M FCFA');
    expect(a).toMatchObject({ value: 5000000, unit: 'FCFA', quote: '5 M FCFA' });
  });
});
