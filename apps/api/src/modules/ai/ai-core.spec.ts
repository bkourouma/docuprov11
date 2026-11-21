import {
  GED_AI_API_KEY_REF_REGEX,
  GED_AI_DISABLED_MESSAGE,
  GED_AI_INPUT_EXCERPT_MAX_CHARS,
  GED_AI_MASKING_ENTITIES,
  GED_AI_MASKING_MAX_TEXT_CHARS,
  GED_AI_MASKING_PATTERN_MAX_LENGTH,
  GedAiDecisionStatus,
  GedAiMaskingKind,
  GedAiTask,
  applyAiMasking,
  buildDocumentPatch,
  buildInputExcerpt,
  clampConfidence,
  decideAiStatus,
  gedAiClassificationOutputSchema,
  gedAiExtractionOutputSchema,
  validateAiMaskingRule,
} from '@archivage/types';

// Suite du noyau partagé « Socle IA » (packages/types/src/ged.ts). Aucun réseau, aucune base.

/** Masquage cloud : règles vides + entités prédéfinies et filet [NUMÉRO]. */
const cloud = (text: string) => applyAiMasking(text, [], { includeDefaults: true });

describe('Socle IA - masquage cloud (includeDefaults)', () => {
  describe('e-mails', () => {
    it.each([
      ['jean.kouassi@exemple.ci', 'Écrire à jean.kouassi@exemple.ci pour suite.'],
      ['élodie.noël+facture@société.fr', 'Contact : élodie.noël+facture@société.fr merci.'],
      ['a_b-c%d@sous.domaine.example.com', 'mail a_b-c%d@sous.domaine.example.com fin'],
    ])('masque %s', (sensible, texte) => {
      const r = cloud(texte);
      expect(r.text).toContain('[EMAIL]');
      expect(r.text).not.toContain(sensible);
      expect(r.text).not.toContain('@');
      expect(r.count).toBeGreaterThanOrEqual(1);
    });
  });

  describe('téléphones', () => {
    it.each([
      ['+225 07 12 34 56 78', '07 12 34 56 78'],
      ['07 12 34 56 78', '07 12 34 56 78'],
      ['0712345678', '0712345678'],
      ['+33 6 12 34 56 78', '6 12 34 56 78'],
      ['07.12.34.56.78', '12.34.56.78'],
      ['07-12-34-56-78', '12-34-56-78'],
      ['07 12 34 56 78', '12 34'],
      ['+225 07 12 34 56 78', '12 34'],
    ])('masque %s', (numero, fragment) => {
      const r = cloud(`Appeler le ${numero} dès demain.`);
      expect(r.text).toContain('[TÉLÉPHONE]');
      expect(r.text).not.toContain(fragment);
      expect(r.text).not.toMatch(/\d{2}/);
      expect(r.text.startsWith('Appeler le ')).toBe(true);
      expect(r.text.endsWith(' dès demain.')).toBe(true);
    });

    it('masque un numéro précédé d\'un libellé', () => {
      const r = cloud('Tél : 07 12 34');
      expect(r.text).not.toContain('07 12 34');
    });
  });

  describe('montants', () => {
    it.each([
      ['1 500 000 FCFA', '1 500 000'],
      ['2 500,50 €', '2 500,50'],
      ['$120', '120'],
      ['45 000 francs CFA', '45 000'],
      ['1 500 000 FCFA', '500'],
    ])('masque %s', (montant, chiffres) => {
      const r = cloud(`Le règlement s'élève à ${montant} au total.`);
      expect(r.text).toContain('[MONTANT]');
      expect(r.text).not.toContain(chiffres);
      expect(r.text).not.toMatch(/FCFA|francs|€|\$/);
    });

    it('masque un nombre après un libellé « Montant : »', () => {
      const r = cloud('Montant : 1 250 000');
      expect(r.text).toContain('[MONTANT]');
      expect(r.text).not.toContain('250');
    });
  });

  describe('identités', () => {
    it.each([
      ['M. Jean KOUASSI', ['KOUASSI', 'Jean']],
      ['Mme Awa TRAORE', ['TRAORE', 'Awa']],
    ])('masque la civilité %s', (identite, noms) => {
      const r = cloud(`Dossier de ${identite} déposé hier.`);
      expect(r.text).toContain('[IDENTITÉ]');
      for (const n of noms) expect(r.text).not.toContain(n);
      expect(r.text).toContain('déposé hier.');
    });

    it('masque « Nom : … » en conservant le libellé', () => {
      const r = cloud('Nom : Kouamé Yao\nObjet : demande');
      expect(r.text).toContain('Nom : [IDENTITÉ]');
      expect(r.text).not.toContain('Kouamé');
      expect(r.text).toContain('Objet : demande');
    });

    it('masque « Nom et prénoms : … » en conservant le libellé', () => {
      const r = cloud('Nom et prénoms : Awa Traoré épouse Koné\nFin');
      expect(r.text).toContain('Nom et prénoms : [IDENTITÉ]');
      expect(r.text).not.toContain('Traoré');
      expect(r.text).not.toContain('Koné');
    });
  });

  describe('IBAN, carte, NIR', () => {
    it('masque un IBAN français', () => {
      const r = cloud('IBAN FR76 3000 6000 0112 3456 7890 189 à créditer');
      expect(r.text).toContain('[IBAN]');
      expect(r.text).not.toContain('3456');
      expect(r.text).not.toContain('FR76');
    });

    it('masque un IBAN UEMOA', () => {
      const r = cloud('Compte CI93 CI00 8012 3456 7890 1234 5678');
      expect(r.text).toContain('[IBAN]');
      expect(r.text).not.toContain('CI93');
      expect(r.text).not.toContain('7890');
    });

    it('masque une carte valide (Luhn)', () => {
      const r = cloud('Carte 4111 1111 1111 1111 expirée');
      expect(r.text).toContain('[CARTE]');
      expect(r.text).not.toContain('4111');
    });

    it('masque une carte à clé de Luhn fausse via le filet [NUMÉRO]', () => {
      const r = cloud('Carte 4111 1111 1111 1112 expirée');
      expect(r.text).not.toContain('4111');
      expect(r.text).not.toContain('1112');
      expect(r.text).toMatch(/\[(CARTE|NUMÉRO)\]/);
    });

    it('masque un NIR', () => {
      const r = cloud('NIR 1 85 05 78 006 084 36 relevé');
      // Clé de contrôle invalide : le filet « numéro résiduel » prend le relais, la valeur est masquée.
      expect(r.text).toMatch(/\[(NIR|NUMÉRO)\]/);
      expect(r.text).not.toContain('006 084');
      expect(r.text).not.toContain('85 05');
    });
  });

  describe('textes sans donnée sensible (restent inchangés)', () => {
    it.each([
      'Réunion du 12/03/2026 à la direction générale.',
      'Dossier N°2026/045 transmis au service juridique.',
      'En 2025, le contrat a été renouvelé pour l\'année 2026.',
      'Le comité se réunira le 2026-03-15 pour examiner la demande.',
      'Merci de bien vouloir trouver ci-joint le compte rendu de la séance.',
      'Page 3 sur 12 - Version 2.1 - Réf. ABC-123',
    ])('inchangé : %s', (texte) => {
      const r = cloud(texte);
      expect(r.text).toBe(texte);
      expect(r.count).toBe(0);
    });
  });

  describe('propriétés générales', () => {
    const SENSIBLES = [
      'jean.kouassi@exemple.ci',
      '+225 07 12 34 56 78',
      '0712345678',
      '1 500 000 FCFA',
      'KOUASSI',
      'TRAORE',
      'FR76 3000 6000 0112 3456 7890 189',
      '4111 1111 1111 1111',
    ];
    const DOC = [
      'Contrat de M. Jean KOUASSI (jean.kouassi@exemple.ci).',
      'Joignable au +225 07 12 34 56 78 ou 0712345678.',
      'Montant : 1 500 000 FCFA, payable par carte 4111 1111 1111 1111',
      'ou virement FR76 3000 6000 0112 3456 7890 189.',
      'Garant : Mme Awa TRAORE.',
    ].join('\n');

    it('ne laisse fuir aucune valeur sensible', () => {
      const { text } = cloud(DOC);
      for (const s of SENSIBLES) expect(text).not.toContain(s);
      for (const frag of ['KOUASSI', 'TRAORE', 'exemple.ci', '07 12', '0712345678', '4111', '3456', '1 500']) {
        expect(text).not.toContain(frag);
      }
    });

    it('est idempotent', () => {
      const premier = cloud(DOC);
      const second = cloud(premier.text);
      expect(second.text).toBe(premier.text);
      expect(second.count).toBe(0);
    });

    it('compte une substitution par donnée', () => {
      expect(cloud('a@b.fr et c@d.fr').count).toBe(2);
      expect(cloud('texte neutre').count).toBe(0);
      expect(cloud('M. Jean KOUASSI joint au 0712345678').count).toBe(2);
    });

    it('normalise en NFKC (chiffres et arobase pleine chasse)', () => {
      const r = cloud('jean＠exemple.ci');
      expect(r.text).toContain('[EMAIL]');
      expect(r.text).not.toContain('exemple');
    });

    it('rejette un texte non chaîne', () => {
      expect(() => applyAiMasking(undefined as unknown as string, [])).toThrow();
    });

    it('rejette un texte trop long (échec fermé)', () => {
      expect(() => applyAiMasking('a'.repeat(GED_AI_MASKING_MAX_TEXT_CHARS + 1), [])).toThrow(/trop long/);
    });

    it('masque ~200 000 caractères en moins de 2 s', () => {
      const bloc =
        'Réunion du 12/03/2026, dossier N°2026/045. Contact jean.kouassi@exemple.ci, ' +
        'tél 07 12 34 56 78, montant 1 500 000 FCFA, M. Jean KOUASSI. Fin de paragraphe courant.\n';
      let texte = '';
      while (texte.length + bloc.length <= GED_AI_MASKING_MAX_TEXT_CHARS) texte += bloc;
      expect(texte.length).toBeGreaterThan(190_000);
      const t0 = Date.now();
      const r = cloud(texte);
      const dureeMs = Date.now() - t0;
      expect(dureeMs).toBeLessThan(2000);
      expect(r.text).not.toContain('KOUASSI');
      expect(r.text).not.toContain('@');
    });

    it('reste rapide sur un texte pathologique de chiffres et séparateurs', () => {
      const texte = '1 '.repeat(100_000);
      const t0 = Date.now();
      cloud(texte);
      expect(Date.now() - t0).toBeLessThan(2000);
    });
  });
});

describe('Socle IA - règles de masquage de table', () => {
  it('liste les entités prédéfinies attendues', () => {
    expect([...GED_AI_MASKING_ENTITIES]).toEqual(['email', 'phone', 'amount', 'iban', 'card', 'nir', 'identity']);
  });

  it('regex : remplace avec le marqueur par défaut', () => {
    const r = applyAiMasking('Dossier ABC-1234 et ABC-9876', [{ kind: GedAiMaskingKind.Regex, pattern: 'ABC-\\d{4}' }]);
    expect(r.text).toBe('Dossier [MASQUÉ] et [MASQUÉ]');
    expect(r.count).toBe(2);
  });

  it('regex : remplacement personnalisé et insensible à la casse', () => {
    const r = applyAiMasking('abc-1234', [{ kind: GedAiMaskingKind.Regex, pattern: 'ABC-\\d{4}', replacement: '[REF]' }]);
    expect(r.text).toBe('[REF]');
  });

  it('texte exact : insensible à la casse et aux accents', () => {
    const rule = { kind: GedAiMaskingKind.Exact, pattern: 'Koné Séraphin' } as const;
    const r = applyAiMasking('Dossier de KONE SERAPHIN et de koné séraphin.', [rule]);
    expect(r.text).toBe('Dossier de [MASQUÉ] et de [MASQUÉ].');
    expect(r.count).toBe(2);
  });

  it('texte exact : tolère espaces multiples, insécables et apostrophes typographiques', () => {
    const rule = { kind: GedAiMaskingKind.Exact, pattern: "N'Guessan Paul" } as const;
    const r = applyAiMasking('Mr N’Guessan  Paul est venu', [rule], {});
    expect(r.text).toBe('Mr [MASQUÉ] est venu');
  });

  it('texte exact : les caractères spéciaux de regex sont littéraux', () => {
    const r = applyAiMasking('prix (a+b) et a+b', [{ kind: GedAiMaskingKind.Exact, pattern: '(a+b)' }]);
    expect(r.text).toBe('prix [MASQUÉ] et a+b');
  });

  it('entité prédéfinie : marqueur par défaut, sans toucher aux autres entités', () => {
    const r = applyAiMasking('mail a@b.fr tel 0712345678', [{ kind: GedAiMaskingKind.Entite, pattern: 'email' }]);
    expect(r.text).toBe('mail [EMAIL] tel 0712345678');
    expect(r.count).toBe(1);
  });

  it('entité prédéfinie : code insensible à la casse, remplacement personnalisé', () => {
    const r = applyAiMasking('mail a@b.fr', [{ kind: GedAiMaskingKind.Entite, pattern: ' EMAIL ', replacement: '***' }]);
    expect(r.text).toBe('mail ***');
  });

  it('règles appliquées dans l\'ordre puis défauts cloud', () => {
    const r = applyAiMasking(
      'Projet Alpha, contact a@b.fr',
      [{ kind: GedAiMaskingKind.Exact, pattern: 'projet alpha', replacement: '[P]' }],
      { includeDefaults: true },
    );
    expect(r.text).toBe('[P], contact [EMAIL]');
    expect(r.count).toBe(2);
  });

  describe('échec fermé', () => {
    const invalides: Array<[string, { kind: number; pattern: string; replacement?: string | null }]> = [
      ['entité inconnue', { kind: GedAiMaskingKind.Entite, pattern: 'passeport' }],
      ['motif vide', { kind: GedAiMaskingKind.Exact, pattern: '' }],
      ['motif blanc', { kind: GedAiMaskingKind.Regex, pattern: '   ' }],
      ['motif trop long', { kind: GedAiMaskingKind.Exact, pattern: 'x'.repeat(GED_AI_MASKING_PATTERN_MAX_LENGTH + 1) }],
      ['remplacement trop long', { kind: GedAiMaskingKind.Exact, pattern: 'x', replacement: 'y'.repeat(201) }],
      ['type de règle inconnu', { kind: 9, pattern: 'x' }],
      ['regex incorrecte', { kind: GedAiMaskingKind.Regex, pattern: '(abc' }],
      ['ReDoS (a+)+$', { kind: GedAiMaskingKind.Regex, pattern: '(a+)+$' }],
      ['répétition illimitée', { kind: GedAiMaskingKind.Regex, pattern: '[a-z]+\\d+' }],
      ['{n,} illimité', { kind: GedAiMaskingKind.Regex, pattern: 'a{2,}' }],
      ['borne trop grande', { kind: GedAiMaskingKind.Regex, pattern: 'a{1,500}' }],
      ['quantificateurs imbriqués', { kind: GedAiMaskingKind.Regex, pattern: '(a{1,5}){1,5}' }],
      ['alternative répétée', { kind: GedAiMaskingKind.Regex, pattern: '(a|ab){1,5}' }],
      ['rétro-référence', { kind: GedAiMaskingKind.Regex, pattern: '(a)\\1' }],
      ['coût trop élevé', { kind: GedAiMaskingKind.Regex, pattern: '\\w{1,99}\\w{1,99}x' }],
      ['correspondance vide', { kind: GedAiMaskingKind.Regex, pattern: 'x?' }],
    ];

    it.each(invalides)('validateAiMaskingRule refuse : %s', (_nom, rule) => {
      const message = validateAiMaskingRule(rule as Parameters<typeof validateAiMaskingRule>[0]);
      expect(message).toMatch(/^Règle de masquage invalide : /);
    });

    it.each(invalides)('applyAiMasking lève une erreur : %s', (_nom, rule) => {
      expect(() =>
        applyAiMasking('texte aaaa neutre', [rule as Parameters<typeof validateAiMaskingRule>[0]], {
          includeDefaults: true,
        }),
      ).toThrow(/Règle de masquage invalide/);
    });

    it('une règle invalide après des règles valides n\'applique rien à moitié', () => {
      expect(() =>
        applyAiMasking(
          'a@b.fr',
          [
            { kind: GedAiMaskingKind.Entite, pattern: 'email' },
            { kind: GedAiMaskingKind.Regex, pattern: '(a+)+$' },
          ],
          { includeDefaults: true },
        ),
      ).toThrow();
    });

    it('le message d\'erreur ne cite jamais le motif', () => {
      const message = validateAiMaskingRule({ kind: GedAiMaskingKind.Entite, pattern: 'SecretKouassi' });
      expect(message).not.toBeNull();
      expect(message).not.toContain('SecretKouassi');
    });

    it('accepte des règles valides', () => {
      expect(validateAiMaskingRule({ kind: GedAiMaskingKind.Regex, pattern: 'ABC-\\d{4}' })).toBeNull();
      expect(validateAiMaskingRule({ kind: GedAiMaskingKind.Exact, pattern: 'Jean Kouassi' })).toBeNull();
      expect(validateAiMaskingRule({ kind: GedAiMaskingKind.Entite, pattern: 'iban', replacement: null })).toBeNull();
    });
  });
});

describe('Socle IA - decideAiStatus', () => {
  const { Proposee, AppliqueeAuto } = GedAiDecisionStatus;

  it.each([
    ['seuil null', 0.99, null, true, Proposee],
    ['confiance null', null, 0.8, true, Proposee],
    ['confiance égale au seuil', 0.8, 0.8, true, AppliqueeAuto],
    ['confiance au-dessus du seuil', 0.95, 0.8, true, AppliqueeAuto],
    ['confiance sous le seuil', 0.79, 0.8, true, Proposee],
    ['application auto interdite', 0.99, 0.5, false, Proposee],
    ['confiance NaN', Number.NaN, 0.5, true, Proposee],
    ['seuil NaN', 0.9, Number.NaN, true, Proposee],
    ['confiance > 1', 1.5, 0.5, true, Proposee],
    ['confiance < 0', -0.1, 0.5, true, Proposee],
    ['seuil > 1', 1, 1.2, true, Proposee],
    ['seuil < 0', 0.5, -0.5, true, Proposee],
    ['confiance infinie', Number.POSITIVE_INFINITY, 0.5, true, Proposee],
    ['seuil 0 et confiance 0', 0, 0, true, AppliqueeAuto],
    ['seuil 1 et confiance 1', 1, 1, true, AppliqueeAuto],
  ])('%s', (_nom, confiance, seuil, autorise, attendu) => {
    expect(decideAiStatus(confiance, seuil, autorise)).toBe(attendu);
  });

  it('application automatique autorisée par défaut', () => {
    expect(decideAiStatus(0.9, 0.5)).toBe(AppliqueeAuto);
  });

  it('un autoApplyAllowed non booléen vrai n\'autorise rien', () => {
    expect(decideAiStatus(0.9, 0.5, 'oui' as unknown as boolean)).toBe(Proposee);
  });
});

describe('Socle IA - clampConfidence', () => {
  it.each([
    [null, null],
    [undefined, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    ['0.8', null],
    [{}, null],
    [0, 0],
    [1, 1],
    [0.5, 0.5],
    [0.8569, 0.856],
    [0.9999, 0.999],
    [0.3, 0.3],
    [85, null],
    [1.5, null],
    [-0.2, null],
  ])('clampConfidence(%p) = %p', (entree, attendu) => {
    expect(clampConfidence(entree)).toBe(attendu);
  });

  it('tolère un léger dépassement flottant', () => {
    expect(clampConfidence(1 + 1e-9)).toBe(1);
    expect(clampConfidence(-1e-9)).toBe(0);
  });
});

describe('Socle IA - buildInputExcerpt', () => {
  it('conserve un texte court', () => {
    expect(buildInputExcerpt('Bonjour')).toBe('Bonjour');
  });

  it('conserve un texte de longueur exacte maximale', () => {
    const t = 'a'.repeat(GED_AI_INPUT_EXCERPT_MAX_CHARS);
    expect(buildInputExcerpt(t)).toBe(t);
  });

  it('tronque un texte long avec « … »', () => {
    const r = buildInputExcerpt('a'.repeat(GED_AI_INPUT_EXCERPT_MAX_CHARS + 500));
    expect(r).toBe(`${'a'.repeat(GED_AI_INPUT_EXCERPT_MAX_CHARS)}…`);
  });

  it('remplace le caractère NUL par U+FFFD', () => {
    const r = buildInputExcerpt('a\u0000b');
    expect(r).toBe('a�b');
    expect(r).not.toContain('\u0000');
  });

  it('ne coupe pas une paire de substitution', () => {
    const t = `${'a'.repeat(GED_AI_INPUT_EXCERPT_MAX_CHARS - 1)}\u{1F600}suite`;
    const r = buildInputExcerpt(t);
    expect(r).toBe(`${'a'.repeat(GED_AI_INPUT_EXCERPT_MAX_CHARS - 1)}…`);
    const dernier = r.charCodeAt(r.length - 2);
    expect(dernier >= 0xd800 && dernier <= 0xdbff).toBe(false);
  });

  it('garde une paire de substitution entière quand la coupe tombe après elle', () => {
    const t = `${'a'.repeat(GED_AI_INPUT_EXCERPT_MAX_CHARS - 2)}\u{1F600}suite`;
    expect(buildInputExcerpt(t)).toBe(`${'a'.repeat(GED_AI_INPUT_EXCERPT_MAX_CHARS - 2)}\u{1F600}…`);
  });
});

describe('Socle IA - buildDocumentPatch', () => {
  const classement = (documentTypeId: number | null) => ({
    documentTypeId,
    documentTypeLabel: 'Contrat',
    confidence: 0.9,
    rationale: 'ok',
  });
  const extraction = (over: Partial<{ date: string | null; summary: string | null }> = {}) => ({
    title: 'Titre',
    date: '2026-03-15',
    reference: 'N°2026/045',
    summary: 'Un résumé.',
    confidence: 0.8,
    ...over,
  });

  it('classement : renvoie documentTypeId', () => {
    expect(buildDocumentPatch(GedAiTask.Classement, classement(7))).toEqual({ documentTypeId: 7 });
  });

  it.each([null, 0, -3, 2_147_483_648])('classement : id %p donne {}', (id) => {
    expect(buildDocumentPatch(GedAiTask.Classement, classement(id))).toEqual({});
  });

  it('classement : sortie invalide donne {}', () => {
    expect(buildDocumentPatch(GedAiTask.Classement, { documentTypeId: 'x' })).toEqual({});
    expect(buildDocumentPatch(GedAiTask.Classement, null)).toEqual({});
    expect(buildDocumentPatch(GedAiTask.Classement, { documentTypeId: 3, confidence: 0.9 })).toEqual({});
  });

  it('extraction : date valide et résumé', () => {
    expect(buildDocumentPatch(GedAiTask.ExtractionMetadonnees, extraction())).toEqual({
      documentDate: '2026-03-15',
      overview: 'Un résumé.',
    });
  });

  it.each(['2026-02-30', '2026-13-01', '15/03/2026', '0999-01-01', '2101-01-01', 'hier'])(
    'extraction : date %s ignorée',
    (date) => {
      expect(buildDocumentPatch(GedAiTask.ExtractionMetadonnees, extraction({ date }))).toEqual({
        overview: 'Un résumé.',
      });
    },
  );

  it('extraction : année bissextile acceptée', () => {
    const p = buildDocumentPatch(GedAiTask.ExtractionMetadonnees, extraction({ date: '2028-02-29' }));
    expect(p.documentDate).toBe('2028-02-29');
  });

  it('extraction : champs nuls donnent {}', () => {
    expect(buildDocumentPatch(GedAiTask.ExtractionMetadonnees, extraction({ date: null, summary: null }))).toEqual({});
  });

  it('extraction : le résumé est assaini (contrôles retirés, rogné)', () => {
    const p = buildDocumentPatch(GedAiTask.ExtractionMetadonnees, extraction({ summary: '  a\u0000b\u0007c  ' }));
    expect(p.overview).toBe('abc');
  });

  it('extraction : un résumé trop long est plafonné', () => {
    const p = buildDocumentPatch(GedAiTask.ExtractionMetadonnees, extraction({ summary: 'x'.repeat(10_000) }));
    expect(p.overview?.length).toBe(4000);
  });

  it('extraction : sortie invalide donne {}', () => {
    expect(buildDocumentPatch(GedAiTask.ExtractionMetadonnees, { title: 'x' })).toEqual({});
    expect(buildDocumentPatch(GedAiTask.ExtractionMetadonnees, 'texte')).toEqual({});
  });

  it.each([GedAiTask.Resume, GedAiTask.TypeDocument, GedAiTask.Question, GedAiTask.Similarite, GedAiTask.Autre])(
    'tâche %p : donne {}',
    (task) => {
      expect(buildDocumentPatch(task, extraction())).toEqual({});
      expect(buildDocumentPatch(task, classement(7))).toEqual({});
    },
  );
});

describe('Socle IA - GED_AI_API_KEY_REF_REGEX', () => {
  it.each(['OPENAI_API_KEY', 'GED_AI_KEY', 'GED_AI_MISTRAL_KEY_2'])('accepte %s', (v) => {
    expect(GED_AI_API_KEY_REF_REGEX.test(v)).toBe(true);
  });

  it.each([
    'JWT_SECRET',
    'DATABASE_URL',
    'sk-abc',
    'OPENAI API KEY',
    'GED_AI_',
    'GED_AI__X',
    'ged_ai_key',
    'OPENAI_API_KEY\n',
    ' OPENAI_API_KEY',
    'GED_AI_KEY;DROP',
    '',
  ])('refuse %p', (v) => {
    expect(GED_AI_API_KEY_REF_REGEX.test(v)).toBe(false);
  });
});

describe('Socle IA - schémas de sortie et constantes', () => {
  it('classement : accepte une sortie conforme et refuse une sortie incomplète', () => {
    const ok = { documentTypeId: 3, documentTypeLabel: 'Facture', confidence: 0.9, rationale: null };
    expect(gedAiClassificationOutputSchema.safeParse(ok).success).toBe(true);
    expect(gedAiClassificationOutputSchema.safeParse({ documentTypeId: 3, confidence: 0.9 }).success).toBe(false);
    expect(gedAiClassificationOutputSchema.safeParse({ ...ok, documentTypeId: 1.5 }).success).toBe(false);
    expect(gedAiClassificationOutputSchema.safeParse({ ...ok, confidence: 'haute' }).success).toBe(false);
  });

  it('extraction : accepte une sortie conforme et refuse une sortie incomplète', () => {
    const ok = { title: null, date: '2026-01-01', reference: null, summary: 'r', confidence: 0.5 };
    expect(gedAiExtractionOutputSchema.safeParse(ok).success).toBe(true);
    expect(gedAiExtractionOutputSchema.safeParse({ title: 'x', confidence: 0.5 }).success).toBe(false);
    const { confidence: _omis, ...sansConfiance } = ok;
    expect(gedAiExtractionOutputSchema.safeParse(sansConfiance).success).toBe(false);
  });

  it('message de désactivation', () => {
    expect(GED_AI_DISABLED_MESSAGE).toBe('IA désactivée');
  });
});
