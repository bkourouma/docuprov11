import {
  GED_GOVERNANCE_MAX_TEXT_CHARS,
  GOVERNANCE_PII_ENTITIES,
  buildDuplicateGroupKey,
  computeSensitivityScore,
  cosineSimilarity,
  detectPii,
  detectSensitivityKeywords,
  governanceSensitivityOutputSchema,
  maskPiiContextText,
  normalizeTitle,
  pickOriginalDocumentId,
  proposeSensitivity,
  titleSimilarity,
  type GovernanceConfidentialiteLevel,
  type GovernancePiiFinding,
  type GovernanceSensitivityReason,
} from '@archivage/types';

/** Clé NIR = 97 - (n mod 97) sur les 13 premiers caractères (calculée ici, pas recopiée). */
function nirKey(body13: string): string {
  const n = BigInt(body13.replace('2A', '19').replace('2B', '18'));
  return String(97n - (n % 97n)).padStart(2, '0');
}
const NIR_BODY = '1850578006084';
const NIR_OK = `1 85 05 78 006 084 ${nirKey(NIR_BODY)}`;
const NIR_OK_COMPACT = `${NIR_BODY}${nirKey(NIR_BODY)}`;
const NIR_BAD_KEY = `1 85 05 78 006 084 ${nirKey(NIR_BODY) === '00' ? '01' : String((Number(nirKey(NIR_BODY)) % 97) + 1).padStart(2, '0')}`;

const IBAN_OK = 'FR76 3000 6000 0112 3456 7890 189';
const IBAN_OK_COMPACT = IBAN_OK.replace(/ /g, '');

const finding = (entity: GovernancePiiFinding['entity'], count = 1, confidence = 0.9): GovernancePiiFinding => ({
  entity,
  count,
  confidence,
  contexts: [],
});
const byEntity = (findings: GovernancePiiFinding[], entity: string) => findings.find((f) => f.entity === entity);
const entities = (text: string) => detectPii(text).map((f) => f.entity);

/** Aucune valeur brute (telle quelle ou en chiffres collés) dans la sortie de détection ni dans le masquage. */
function expectNoLeak(text: string, raws: string[]): void {
  const json = JSON.stringify(detectPii(text));
  const masked = maskPiiContextText(text);
  for (const raw of raws) {
    const variants = new Set([raw, raw.replace(/[ .-]/g, '')]);
    for (const v of variants) {
      expect(json).not.toContain(v);
      expect(masked).not.toContain(v);
    }
  }
}

describe('detectPii : cas réalistes', () => {
  it('lettre avec signature : e-mail + téléphone détectés mais document non sensible', () => {
    const text =
      'Objet : demande de rendez-vous.\nMadame, Monsieur,\nVeuillez agréer mes salutations.\n' +
      'Jean Dupont\nTél : 06 12 34 56 78\njean.dupont@example.fr';
    const findings = detectPii(text);
    expect(findings.map((f) => f.entity)).toEqual(['email', 'phone']);
    expect(byEntity(findings, 'phone')?.confidence).toBe(0.9);
    const { score, reasons } = computeSensitivityScore({ findings, keywordReasons: [], aiScore: null });
    expect(score).toBe(0);
    expect(reasons).toEqual([]);
    expectNoLeak(text, ['jean.dupont@example.fr', '06 12 34 56 78']);
  });

  it('bulletin de paie : IBAN, NIR, e-mail et nom avec civilité', () => {
    const text =
      `Bulletin de paie - mars 2024\nSalarié : Mme Awa Traoré\nN° sécurité sociale : ${NIR_OK}\n` +
      `IBAN : ${IBAN_OK}\nContact : awa.traore@entreprise.ci\nSalaire net : 1 250 000 FCFA`;
    const findings = detectPii(text);
    expect(findings.map((f) => f.entity)).toEqual(['email', 'iban', 'nir']);
    expect(byEntity(findings, 'iban')).toMatchObject({ count: 1, confidence: 1 });
    expect(byEntity(findings, 'nir')).toMatchObject({ count: 1, confidence: 0.95 });
    const keywords = detectSensitivityKeywords(text);
    expect(keywords).toEqual(expect.arrayContaining(['keyword_hr']));
    const { score, reasons } = computeSensitivityScore({ findings, keywordReasons: keywords });
    expect(score).toBe(2);
    expect(reasons).toEqual(expect.arrayContaining(['pii_iban', 'pii_nir', 'keyword_hr']));
    expectNoLeak(text, [IBAN_OK, IBAN_OK_COMPACT, NIR_OK, NIR_OK_COMPACT, 'awa.traore@entreprise.ci']);
    const contexts = findings.flatMap((f) => f.contexts).join(' | ');
    expect(contexts).not.toContain('Awa');
    expect(contexts).not.toContain('Traoré');
  });

  it('facture : référence, montants, SIRET et dates ne donnent ni téléphone, ni carte, ni NIR', () => {
    const text =
      'Facture FA-2024-0001234 du 12.03.2024 (échéance 2024-04-12)\nSIRET 552 100 554 00025 - SIREN 552 100 554\n' +
      'Total HT : 1 234 567,89 EUR\nTVA 20 % : 246 913,58\nTotal TTC : 1 481 481,47 EUR\nCode postal 75008 Paris\n' +
      'Référence client REF-0612345678\nRéglée le 01-03-2024 12:30';
    const found = entities(text);
    expect(found).not.toContain('phone');
    expect(found).not.toContain('card');
    expect(found).not.toContain('nir');
    expect(found).toEqual([]);
  });

  it('carte de test 4111 1111 1111 1111 détectée, 4111 1111 1111 1112 non', () => {
    const ok = detectPii('Paiement par carte 4111 1111 1111 1111 validé.');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ entity: 'card', count: 1, confidence: 0.9 });
    expect(entities('Paiement par carte 4111 1111 1111 1112 validé.')).not.toContain('card');
    expect(entities('Carte 4111-1111-1111-1111')).toEqual(['card']);
    expect(entities('Carte 0000 0000 0000 0000')).not.toContain('card');
    expectNoLeak('Paiement par carte 4111 1111 1111 1111 validé.', ['4111 1111 1111 1111']);
  });

  it('IBAN : clé valide retenue (avec ou sans espaces), clé fausse écartée', () => {
    expect(byEntity(detectPii(`IBAN ${IBAN_OK}`), 'iban')?.confidence).toBe(1);
    expect(byEntity(detectPii(`IBAN ${IBAN_OK_COMPACT}`), 'iban')?.confidence).toBe(1);
    expect(byEntity(detectPii(`iban ${IBAN_OK_COMPACT.toLowerCase()}`), 'iban')?.confidence).toBe(1);
    const badKey = 'FR77 3000 6000 0112 3456 7890 189';
    expect(entities(`IBAN ${badKey}`)).not.toContain('iban');
    expect(entities('IBAN FR76 3000 6000 0112 3456 7890 18')).not.toContain('iban');
  });

  it('NIR : clé fausse => confiance 0,5, mois invalide => rien', () => {
    expect(byEntity(detectPii(`NIR ${NIR_BAD_KEY}`), 'nir')?.confidence).toBe(0.5);
    expect(byEntity(detectPii(`NIR ${NIR_OK_COMPACT}`), 'nir')?.confidence).toBe(0.95);
    const corsica = `2A`;
    const body = `285 05 ${corsica} 006 084`.replace(/ /g, '');
    expect(byEntity(detectPii(`NIR 2 85 05 2A 006 084 ${nirKey(body)}`), 'nir')?.confidence).toBe(0.95);
    expect(entities('NIR 1 85 15 78 006 084 12')).not.toContain('nir');
    const weak = computeSensitivityScore({ findings: detectPii(`NIR ${NIR_BAD_KEY}`), keywordReasons: [] });
    expect(weak.score).toBe(0);
  });

  it('téléphones : formats français et internationaux', () => {
    expect(byEntity(detectPii('Appelez le +221 77 123 45 67 svp'), 'phone')).toMatchObject({ count: 1, confidence: 0.9 });
    expect(byEntity(detectPii('Mobile 0033 6 12 34 56 78'), 'phone')).toMatchObject({ count: 1, confidence: 0.9 });
    expect(byEntity(detectPii('Tél +33 (0)6 12 34 56 78'), 'phone')?.count).toBe(1);
    expect(byEntity(detectPii('Tél 06.12.34.56.78'), 'phone')?.confidence).toBe(0.9);
    expect(byEntity(detectPii('Tél 06-12-34-56-78'), 'phone')?.confidence).toBe(0.9);
    expect(byEntity(detectPii('Tél +225 07 12 34 56 78'), 'phone')?.confidence).toBe(0.9);
    expect(byEntity(detectPii('Tél +212 6 12 34 56 78'), 'phone')?.confidence).toBe(0.9);
    expect(byEntity(detectPii('Tél +237 6 71 23 45 67'), 'phone')?.confidence).toBe(0.9);
    expect(byEntity(detectPii('Tél +243 81 234 5678'), 'phone')?.confidence).toBe(0.9);
    expect(byEntity(detectPii('Tél 0612345678'), 'phone')).toMatchObject({ count: 1, confidence: 0.6 });
    expect(byEntity(detectPii('A : 01 23 45 67 89 ou 06 12 34 56 78'), 'phone')).toMatchObject({ count: 2 });
    expect(entities('Total 1 234 567,89 et code 75008 et 123456789')).toEqual([]);
    expect(entities('SIRET 55210055400025')).toEqual([]);
    expect(entities('Indicatif +999 12 34 56 78')).not.toContain('phone');
    expectNoLeak('Mobile 0033 6 12 34 56 78 / 0612345678', ['0033 6 12 34 56 78', '0612345678']);
  });

  it('e-mails : motif raisonnable et faux positifs écartés', () => {
    expect(byEntity(detectPii('a.b+c@sub.exemple.co.uk'), 'email')?.count).toBe(1);
    expect(byEntity(detectPii('kone@société.ci et awa@ex.sn'), 'email')?.count).toBe(2);
    expect(entities('Voir logo@2x.png et sprite@3x.webp')).toEqual([]);
    expect(entities('Écrire à exemple@domaine')).toEqual([]);
    expect(entities('Contact : jean@ex.com.')).toEqual(['email']);
    expect(entities('Une arobase @ seule, et @mention')).toEqual([]);
  });

  it('pièces d\'identité : ancrées sur un mot-clé uniquement', () => {
    const text = 'Passeport n° 12AB34567 ; CNI : CI0123456789 ; carte nationale d’identité numéro 123456789.';
    expect(byEntity(detectPii(text), 'identity')).toMatchObject({ count: 3, confidence: 0.7 });
    expect(entities('Le code AB1234567 est valide')).toEqual([]);
    expect(entities('Passeport n° ABCDEFGH')).toEqual([]);
    expect(entities('Passeport n° 12A')).toEqual([]);
    expect(entities('cinéma n° 123456789')).toEqual([]);
    // Un identifiant de 10 chiffres derrière « CNI » n'est pas un téléphone.
    expect(entities('CNI n° 0123456789')).toEqual(['identity']);
    expectNoLeak(text, ['12AB34567', 'CI0123456789', '123456789']);
  });

  it('`name` n\'est jamais produit et l\'ordre suit GOVERNANCE_PII_ENTITIES', () => {
    const text = `Mme Awa Traoré, a@b.fr, 06 12 34 56 78, ${IBAN_OK}, ${NIR_OK}, 4111 1111 1111 1111, passeport n° 12AB34567`;
    const found = entities(text);
    expect(found).not.toContain('name');
    expect(found).toEqual(GOVERNANCE_PII_ENTITIES.filter((e) => found.includes(e)));
    expect(found).toEqual(['email', 'phone', 'iban', 'card', 'nir', 'identity']);
  });

  it('plafonne les contextes à 3 par famille et à 400 caractères', () => {
    const text = Array.from({ length: 8 }, (_, i) => `ligne ${i} : u${i}@exemple.fr`).join('\n');
    const email = byEntity(detectPii(text), 'email');
    expect(email?.count).toBe(8);
    expect(email?.contexts.length).toBeLessThanOrEqual(3);
    for (const c of email?.contexts ?? []) expect(c.length).toBeLessThanOrEqual(400);
  });

  it('entrées dégénérées', () => {
    expect(detectPii('')).toEqual([]);
    expect(detectPii(undefined as unknown as string)).toEqual([]);
    expect(detectPii('texte sans donnée personnelle')).toEqual([]);
  });
});

describe('detectPii : non-fuite des valeurs brutes', () => {
  const cases: Array<{ name: string; text: string; raws: string[] }> = [
    {
      name: 'valeurs voisines (fenêtres qui se chevauchent)',
      text: `Contact jean@ex.com ${IBAN_OK} 06 12 34 56 78 ${NIR_OK} 4111 1111 1111 1111 fin`,
      raws: ['jean@ex.com', IBAN_OK, IBAN_OK_COMPACT, '0612345678', '06 12 34 56 78', NIR_OK, NIR_OK_COMPACT, '4111 1111 1111 1111', '4111111111111111'],
    },
    {
      name: 'IBAN compact collé à du texte',
      text: `RIB:${IBAN_OK_COMPACT}.`,
      raws: [IBAN_OK_COMPACT],
    },
    {
      name: 'valeurs pleine chasse (NFKC)',
      text: 'Écrire à ｊｅａｎ＠ｅｘａｍｐｌｅ．ｆｒ ou appeler ０６ １２ ３４ ５６ ７８',
      raws: ['jean@example.fr', '0612345678', '06 12 34 56 78', 'ｊｅａｎ'],
    },
    {
      name: 'téléphone international et identifiants',
      text: 'Tél +221 77 123 45 67. Permis de conduire n° AB12345678 ; titre de séjour : 1234567890AB',
      raws: ['+221 77 123 45 67', '221771234567', 'AB12345678', '1234567890AB'],
    },
    {
      name: 'valeur en bord de fenêtre (rayon)',
      text: `${'x '.repeat(30)}${IBAN_OK} ${'y '.repeat(30)}marie@ex.org ${'z '.repeat(30)}`,
      raws: [IBAN_OK, IBAN_OK_COMPACT, 'marie@ex.org'],
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(detectPii(c.text).length).toBeGreaterThan(0);
      expectNoLeak(c.text, c.raws);
    });
  }
});

describe('maskPiiContextText', () => {
  it('masque les entités, les civilités + noms et les identifiants ancrés', () => {
    const out = maskPiiContextText(
      `M. Koné Ibrahim a écrit à kone@ex.ci depuis le 06 12 34 56 78 ; Dr Awa Sy ; Madame Marie-Claire Dupont de Lyon ; passeport n° 12AB34567 ; ${IBAN_OK}`,
    );
    expect(out).toContain('[NOM]');
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[TÉLÉPHONE]');
    expect(out).toContain('[IBAN]');
    expect(out).toContain('[IDENTITÉ]');
    expect(out).not.toMatch(/Koné|Ibrahim|Awa Sy|Dupont|12AB34567|kone@/);
    expect(out.toLowerCase()).toContain('passeport');
  });

  it('est idempotent', () => {
    const samples = [
      `M. Koné a écrit à kone@ex.ci, tel 06 12 34 56 78, ${IBAN_OK}, ${NIR_OK}, 4111 1111 1111 1111`,
      'Nom : Mme Traoré ; passeport n° 12AB34567 ; Montant : 1 250 000 FCFA',
      'Dr Sy et Me Diallo ; CNI : CI0123456789 ; [NOM] [EMAIL]',
      'rien à masquer ici',
      '',
    ];
    for (const s of samples) {
      const once = maskPiiContextText(s);
      expect(maskPiiContextText(once)).toBe(once);
    }
  });

  it('ne lève jamais pour un texte trop long : tronque avant', () => {
    const huge = 'Mme Awa Traoré 06 12 34 56 78 '.repeat(20_000);
    expect(huge.length).toBeGreaterThan(500_000 - 1);
    expect(() => maskPiiContextText(huge)).not.toThrow();
    expect(maskPiiContextText(huge).length).toBeLessThanOrEqual(200_000);
  });
});

describe('résistance aux textes énormes', () => {
  it('500 000 caractères : pas d\'exception, temps raisonnable, texte plafonné', () => {
    const filler = 'Lorem ipsum dolor sit amet 12 34 56 consectetur. ';
    const huge = `${'a'.repeat(1000)} jean@ex.com ${filler.repeat(Math.ceil(500_000 / filler.length))}`;
    const started = Date.now();
    const findings = detectPii(huge);
    const keywords = detectSensitivityKeywords(huge);
    const masked = maskPiiContextText(huge);
    const elapsed = Date.now() - started;
    expect(findings.map((f) => f.entity)).toEqual(['email']);
    expect(keywords).toEqual([]);
    expect(masked.length).toBeLessThanOrEqual(GED_GOVERNANCE_MAX_TEXT_CHARS + 50_000);
    expect(elapsed).toBeLessThan(15_000);
  });

  it('chaînes pathologiques (chiffres, séparateurs, arobases) sans explosion', () => {
    const samples = [
      '1'.repeat(300_000),
      '1 '.repeat(150_000),
      '06 '.repeat(100_000),
      'a@'.repeat(150_000),
      `${'+33 '.repeat(75_000)}`,
      'FR76'.repeat(75_000),
      'passeport '.repeat(30_000),
    ];
    const started = Date.now();
    for (const s of samples) expect(() => detectPii(s)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe('detectSensitivityKeywords', () => {
  it('insensible à la casse et aux accents, résultats uniques', () => {
    expect(detectSensitivityKeywords('DOSSIER MÉDICAL du patient, Ordonnance, ordonnance')).toEqual(['keyword_health']);
    expect(detectSensitivityKeywords('Arrêt maladie du 3 mars')).toEqual(['keyword_health']);
    expect(detectSensitivityKeywords('arret maladie')).toEqual(['keyword_health']);
    expect(detectSensitivityKeywords('Fiche de PAIE et licenciement')).toEqual(['keyword_hr']);
    expect(detectSensitivityKeywords('Entretien annuel d’évaluation 2024')).toEqual(['keyword_hr']);
    expect(detectSensitivityKeywords('Protocole transactionnel : contentieux prud\'homal')).toEqual(['keyword_legal']);
    expect(detectSensitivityKeywords('Relevé bancaire, RIB et Avis d\'imposition')).toEqual(['keyword_finance']);
    expect(detectSensitivityKeywords('Relevé d’identité bancaire')).toEqual(['keyword_finance']);
    expect(detectSensitivityKeywords('STRICTEMENT CONFIDENTIEL - Ne pas diffuser')).toEqual(['keyword_secret']);
    expect(detectSensitivityKeywords('Secret défense')).toEqual(['keyword_secret']);
    expect(detectSensitivityKeywords('Salaire, plainte et diagnostic')).toEqual([
      'keyword_health',
      'keyword_hr',
      'keyword_legal',
    ]);
  });

  it('mots entiers uniquement', () => {
    expect(detectSensitivityKeywords('nonconfidentielle')).toEqual([]);
    expect(detectSensitivityKeywords('Document non confidentiel')).toEqual(['keyword_secret']);
    expect(detectSensitivityKeywords('Libéral, ribambelle, plaintes')).toEqual(['keyword_legal']);
    expect(detectSensitivityKeywords('ribambelle')).toEqual([]);
    expect(detectSensitivityKeywords('')).toEqual([]);
  });
});

describe('computeSensitivityScore', () => {
  const kw = (...r: GovernanceSensitivityReason[]) => r;

  it('score 2 : famille forte >= 0,7, santé, avis IA = 2', () => {
    expect(computeSensitivityScore({ findings: [finding('iban', 1, 1)], keywordReasons: [] })).toEqual({
      score: 2,
      reasons: ['pii_iban'],
    });
    expect(computeSensitivityScore({ findings: [finding('card', 1, 0.9)], keywordReasons: [] }).score).toBe(2);
    expect(computeSensitivityScore({ findings: [finding('identity', 1, 0.7)], keywordReasons: [] }).score).toBe(2);
    expect(computeSensitivityScore({ findings: [finding('nir', 1, 0.5)], keywordReasons: [] }).score).toBe(0);
    expect(computeSensitivityScore({ findings: [], keywordReasons: kw('keyword_health') })).toEqual({
      score: 2,
      reasons: ['keyword_health'],
    });
    expect(computeSensitivityScore({ findings: [], keywordReasons: [], aiScore: 2 })).toEqual({
      score: 2,
      reasons: ['ai_high'],
    });
  });

  it('score 1 : cumul de familles, volume, nom, mot-clé, avis IA = 1', () => {
    expect(computeSensitivityScore({ findings: [finding('email', 2), finding('phone')], keywordReasons: [] })).toEqual({
      score: 1,
      reasons: ['pii_email', 'pii_phone'],
    });
    expect(computeSensitivityScore({ findings: [finding('email'), finding('name', 1, 0.3)], keywordReasons: [] }).score).toBe(0);
    expect(computeSensitivityScore({ findings: [finding('email', 5)], keywordReasons: [] })).toEqual({
      score: 1,
      reasons: ['pii_email'],
    });
    expect(computeSensitivityScore({ findings: [finding('email', 4)], keywordReasons: [] }).score).toBe(0);
    expect(computeSensitivityScore({ findings: [finding('name', 1, 0.6)], keywordReasons: [] })).toEqual({
      score: 1,
      reasons: ['pii_name'],
    });
    expect(computeSensitivityScore({ findings: [finding('name', 1, 0.5)], keywordReasons: [] }).score).toBe(0);
    for (const k of ['keyword_hr', 'keyword_legal', 'keyword_finance', 'keyword_secret'] as const) {
      expect(computeSensitivityScore({ findings: [], keywordReasons: [k] })).toEqual({ score: 1, reasons: [k] });
    }
    expect(computeSensitivityScore({ findings: [], keywordReasons: [], aiScore: 1 })).toEqual({
      score: 1,
      reasons: ['ai_moderate'],
    });
  });

  it('score 0 : un seul e-mail ou un seul téléphone', () => {
    expect(computeSensitivityScore({ findings: [finding('email')], keywordReasons: [] })).toEqual({ score: 0, reasons: [] });
    expect(computeSensitivityScore({ findings: [finding('phone', 2)], keywordReasons: [] }).score).toBe(0);
    expect(computeSensitivityScore({ findings: [], keywordReasons: [], aiScore: 0 }).score).toBe(0);
  });

  it('raisons sans doublon', () => {
    const { reasons } = computeSensitivityScore({
      findings: [finding('iban', 1, 1), finding('email', 2), finding('phone', 1)],
      keywordReasons: kw('keyword_hr', 'keyword_hr', 'keyword_health'),
      aiScore: 2,
    });
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons).toEqual(['pii_email', 'pii_phone', 'pii_iban', 'keyword_health', 'keyword_hr', 'ai_high']);
  });
});

describe('proposeSensitivity', () => {
  const makeLevels = (n: number): GovernanceConfidentialiteLevel[] =>
    Array.from({ length: n }, (_, i) => ({ confidentialiteId: 100 + i, label: `Niveau ${i}`, rank: (i + 1) * 10 }));
  const strong = [finding('iban', 1, 1)];
  const moderate = [finding('email', 2), finding('phone')];
  const base = { keywordReasons: [] as GovernanceSensitivityReason[], current: { confidentialiteId: null, rank: null } };

  it('cibles attendues pour 2, 3, 4 et 5 niveaux', () => {
    const expected: Record<number, [number, number]> = { 2: [0, 1], 3: [1, 2], 4: [1, 2], 5: [1, 3] };
    for (const n of [2, 3, 4, 5]) {
      const levels = makeLevels(n);
      const one = proposeSensitivity({ ...base, findings: moderate, levels });
      const two = proposeSensitivity({ ...base, findings: strong, levels });
      expect(one?.proposedConfidentialiteId).toBe(levels[expected[n]![0]]!.confidentialiteId);
      expect(two?.proposedConfidentialiteId).toBe(levels[expected[n]![1]]!.confidentialiteId);
      expect(one?.score).toBe(1);
      expect(two?.score).toBe(2);
      if (n >= 3) expect(two!.proposedRank).toBeGreaterThan(one!.proposedRank);
    }
  });

  it('sortie conforme au schéma zod', () => {
    const out = proposeSensitivity({ ...base, findings: strong, levels: makeLevels(4), aiScore: 2 });
    expect(out).not.toBeNull();
    expect(governanceSensitivityOutputSchema.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({
      schemaVersion: 1,
      kind: 'sensitivity',
      score: 2,
      currentConfidentialiteId: null,
      currentRank: null,
      direction: 'raise',
      detection: { deterministic: true, ai: true },
    });
    const noAi = proposeSensitivity({ ...base, findings: strong, levels: makeLevels(2) });
    expect(noAi?.detection.ai).toBe(false);
  });

  it('score 0 ou aucun niveau => null', () => {
    expect(proposeSensitivity({ ...base, findings: [finding('email')], levels: makeLevels(4) })).toBeNull();
    expect(proposeSensitivity({ ...base, findings: strong, levels: [] })).toBeNull();
    expect(
      proposeSensitivity({
        ...base,
        findings: strong,
        levels: [{ confidentialiteId: 0, label: 'x', rank: 1 }, { confidentialiteId: 3, label: 'y', rank: Number.NaN }],
      }),
    ).toBeNull();
  });

  it('tri défensif et rangs / identifiants invalides ignorés', () => {
    const levels: GovernanceConfidentialiteLevel[] = [
      { confidentialiteId: 3, label: 'C', rank: 30 },
      { confidentialiteId: -1, label: 'X', rank: 5 },
      { confidentialiteId: 1, label: 'A', rank: 10 },
      { confidentialiteId: 2, label: 'B', rank: 20 },
      { confidentialiteId: 9, label: 'D', rank: 1.5 },
    ];
    const out = proposeSensitivity({ ...base, findings: strong, levels });
    // 3 niveaux valides (10, 20, 30) : score 2 => indice 2 (forcé au-dessus de l'indice 1).
    expect(out?.proposedConfidentialiteId).toBe(3);
    expect(out?.proposedRank).toBe(30);
  });

  it('courant plus haut ou égal => null ; courant plus bas => élévation', () => {
    const levels = makeLevels(4); // rangs 10, 20, 30, 40 ; score 2 => rang 30
    const at = (rank: number) => ({ confidentialiteId: 7, rank });
    expect(proposeSensitivity({ ...base, findings: strong, levels, current: at(40) })).toBeNull();
    expect(proposeSensitivity({ ...base, findings: strong, levels, current: at(30) })).toBeNull();
    const raise = proposeSensitivity({ ...base, findings: strong, levels, current: at(10) });
    expect(raise).toMatchObject({ direction: 'raise', currentRank: 10, currentConfidentialiteId: 7, proposedRank: 30 });
    expect(governanceSensitivityOutputSchema.safeParse(raise).success).toBe(true);
  });

  it('abaissement uniquement avec allowLowering', () => {
    const levels = makeLevels(4);
    const current = { confidentialiteId: 103, rank: 40 };
    expect(proposeSensitivity({ ...base, findings: moderate, levels, current })).toBeNull();
    expect(proposeSensitivity({ ...base, findings: moderate, levels, current, allowLowering: false })).toBeNull();
    const lowered = proposeSensitivity({ ...base, findings: moderate, levels, current, allowLowering: true });
    expect(lowered).toMatchObject({ direction: 'lower', proposedRank: 20, currentRank: 40 });
    expect(governanceSensitivityOutputSchema.safeParse(lowered).success).toBe(true);
    // Même avec allowLowering : niveau égal => rien.
    expect(
      proposeSensitivity({ ...base, findings: moderate, levels, current: { confidentialiteId: 101, rank: 20 }, allowLowering: true }),
    ).toBeNull();
  });
});

describe('titres, similarité et original', () => {
  it('normalizeTitle', () => {
    expect(normalizeTitle('Rapport Annuel 2023.PDF')).toBe('rapport annuel 2023');
    expect(normalizeTitle('Procès-verbal  de l’AG.docx')).toBe('proces verbal de l ag');
    expect(normalizeTitle('Copie de Contrat Éclair.pdf')).toBe('contrat eclair');
    expect(normalizeTitle('Contrat Éclair - copie.pdf')).toBe('contrat eclair');
    expect(normalizeTitle('Contrat Éclair (1).pdf')).toBe('contrat eclair');
    expect(normalizeTitle('Contrat Éclair copy')).toBe('contrat eclair');
    expect(normalizeTitle('Contrat.pdf - Copie')).toBe('contrat');
    expect(normalizeTitle('Budget v2.0')).toBe('budget v2 0');
    expect(normalizeTitle('   ')).toBe('');
  });

  it('titleSimilarity', () => {
    expect(titleSimilarity('Contrat Éclair.pdf', 'Copie de contrat eclair (1).PDF')).toBe(1);
    expect(titleSimilarity('rapport annuel 2023', 'rapport annuel 2024')).toBeCloseTo(2 / 4, 5);
    expect(titleSimilarity('', 'rapport')).toBe(0);
    expect(titleSimilarity('rapport', '.pdf')).toBe(0);
    expect(titleSimilarity('a b', 'a b')).toBe(0);
    expect(titleSimilarity('alpha beta', 'gamma delta')).toBe(0);
  });

  it('cosineSimilarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([0.1, 0.2, 0.3], [0.1, 0.2, 0.3])).toBeLessThanOrEqual(1);
    expect(cosineSimilarity([Number.NaN, 1], [1, 1])).toBe(0);
  });

  it('buildDuplicateGroupKey', () => {
    expect(buildDuplicateGroupKey(42)).toBe('dup:42');
  });

  it('pickOriginalDocumentId', () => {
    expect(
      pickOriginalDocumentId([
        { documentId: 5, createdAt: new Date('2024-03-02T10:00:00Z') },
        { documentId: 9, createdAt: '2024-03-01T10:00:00Z' },
        { documentId: 2, createdAt: '2024-03-03T10:00:00Z' },
      ]),
    ).toBe(9);
    expect(
      pickOriginalDocumentId([
        { documentId: 8, createdAt: '2024-03-01T10:00:00Z' },
        { documentId: 3, createdAt: new Date('2024-03-01T10:00:00Z') },
      ]),
    ).toBe(3);
    expect(pickOriginalDocumentId([{ documentId: 1, createdAt: 'pas une date' }, { documentId: 2, createdAt: '2020-01-01' }])).toBe(2);
    expect(() => pickOriginalDocumentId([])).toThrow(Error);
  });
});
