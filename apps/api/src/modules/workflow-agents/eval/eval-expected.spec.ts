import {
  EVAL_CASE_MAX_BYTES,
  evalCaseByteSize,
  evalCaseInputSchema,
  evalExpectedSchema,
  matchesExpected,
  type EvalActual,
} from './eval-expected';
import { createEvalCaseSchema } from './eval.dto';

const actual = (over: Partial<EvalActual> = {}): EvalActual => ({
  result: { classe: 'facture', montant: 1250, tags: ['a', 'b'], detail: { fournisseur: 'ACME', extra: 1 } },
  returnsToHuman: false,
  suspicionInjection: false,
  confidence: 0.9,
  ...over,
});

describe('matchesExpected', () => {
  it('sous-ensemble profond : les clés en trop de l’observé sont ignorées', () => {
    expect(matchesExpected({ result: { classe: 'facture' } }, actual())).toEqual({ passed: true });
    expect(matchesExpected({ result: { detail: { fournisseur: 'ACME' } } }, actual())).toEqual({ passed: true });
  });

  it('valeur différente ou clé absente : échec avec le chemin de la clé, sans recopier de valeur', () => {
    const a = matchesExpected({ result: { classe: 'devis' } }, actual());
    expect(a.passed).toBe(false);
    expect(a.reason).toContain('« classe »');
    expect(a.reason).not.toContain('facture');
    const b = matchesExpected({ result: { detail: { fournisseur: 'ACME', iban: 'x' } } }, actual());
    expect(b.reason).toContain('« detail.iban »');
    expect(matchesExpected({ result: { absente: 1 } }, actual()).passed).toBe(false);
  });

  it('tableaux : égalité stricte (ordre et longueur), pas de sous-ensemble', () => {
    expect(matchesExpected({ result: { tags: ['a', 'b'] } }, actual()).passed).toBe(true);
    expect(matchesExpected({ result: { tags: ['a'] } }, actual()).passed).toBe(false);
    expect(matchesExpected({ result: { tags: ['b', 'a'] } }, actual()).passed).toBe(false);
    expect(matchesExpected({ result: { lignes: [{ a: 1 }] } }, actual({ result: { lignes: [{ a: 1, b: 2 }] } })).passed).toBe(false);
    expect(matchesExpected({ result: { lignes: [{ a: 1 }] } }, actual({ result: { lignes: [{ a: 1 }] } })).passed).toBe(true);
  });

  it('un objet attendu face à une valeur simple ou un tableau échoue', () => {
    expect(matchesExpected({ result: { detail: { fournisseur: 'ACME' } } }, actual({ result: { detail: 'ACME' } })).passed).toBe(false);
    expect(matchesExpected({ result: { detail: {} } }, actual({ result: { detail: [] } })).passed).toBe(false);
  });

  it('ne confond pas une clé héritée (constructor, __proto__) avec une clé présente', () => {
    expect(matchesExpected({ result: { constructor: {} } }, actual()).passed).toBe(false);
  });

  it('résultat absent (arrêt du runner) : échec dédié', () => {
    const m = matchesExpected({ result: { classe: 'facture' } }, actual({ result: null }));
    expect(m).toEqual({ passed: false, reason: 'Aucun résultat produit.' });
  });

  it('booléens returnsToHuman / suspicionInjection', () => {
    expect(matchesExpected({ returnsToHuman: true }, actual({ returnsToHuman: true })).passed).toBe(true);
    const m = matchesExpected({ returnsToHuman: true }, actual());
    expect(m.passed).toBe(false);
    expect(m.reason).toContain('attendu : oui, obtenu : non');
    expect(matchesExpected({ suspicionInjection: false }, actual()).passed).toBe(true);
    expect(matchesExpected({ suspicionInjection: true }, actual()).passed).toBe(false);
  });

  it('minConfidence : borne incluse, confiance absente refusée', () => {
    expect(matchesExpected({ minConfidence: 0.9 }, actual({ confidence: 0.9 })).passed).toBe(true);
    const low = matchesExpected({ minConfidence: 0.95 }, actual({ confidence: 0.9 }));
    expect(low.passed).toBe(false);
    expect(low.reason).toContain('Confiance insuffisante');
    expect(matchesExpected({ minConfidence: 0 }, actual({ confidence: null })).reason).toBe('Confiance absente.');
  });

  it('tous les critères doivent être satisfaits ; les raisons s’additionnent', () => {
    const m = matchesExpected(
      { result: { classe: 'devis' }, returnsToHuman: true, minConfidence: 0.99 },
      actual(),
    );
    expect(m.passed).toBe(false);
    expect(m.reason).toContain('Le résultat diffère');
    expect(m.reason).toContain("Renvoi à l'humain");
    expect(m.reason).toContain('Confiance insuffisante');
    expect(matchesExpected({ result: { classe: 'facture' }, returnsToHuman: false, minConfidence: 0.5 }, actual()).passed).toBe(true);
  });
});

describe('schémas des cas', () => {
  it('expected : au moins une clé, champs inconnus refusés, minConfidence bornée', () => {
    expect(evalExpectedSchema.safeParse({}).success).toBe(false);
    expect(evalExpectedSchema.safeParse({ returnsToHuman: false }).success).toBe(true);
    expect(evalExpectedSchema.safeParse({ result: { a: 1 }, autre: 1 }).success).toBe(false);
    expect(evalExpectedSchema.safeParse({ minConfidence: 1.1 }).success).toBe(false);
    // Critères vides (toujours satisfaits) refusés à la création d'un cas.
    expect(evalExpectedSchema.safeParse({ result: {} }).success).toBe(false);
    expect(evalExpectedSchema.safeParse({ minConfidence: 0 }).success).toBe(false);
    expect(evalExpectedSchema.safeParse({ result: {}, minConfidence: 0 }).success).toBe(false);
    expect(evalExpectedSchema.safeParse({ minConfidence: 0.5 }).success).toBe(true);
    expect(evalExpectedSchema.safeParse({ result: { a: 1 }, minConfidence: 0 }).success).toBe(true);
    expect(evalExpectedSchema.safeParse({ minConfidence: -0.1 }).success).toBe(false);
    expect(evalExpectedSchema.safeParse({ result: 'texte' }).success).toBe(false);
  });

  it('input : blocs non fiables bornés (10 blocs, label 100, texte 20000, origine connue)', () => {
    const block = { label: 'Courrier', origin: 'mail' as const, text: 'Bonjour' };
    expect(evalCaseInputSchema.safeParse({ untrusted: [block] }).success).toBe(true);
    expect(evalCaseInputSchema.safeParse({}).success).toBe(true);
    expect(evalCaseInputSchema.safeParse({ untrusted: Array(10).fill(block) }).success).toBe(true);
    expect(evalCaseInputSchema.safeParse({ untrusted: Array(11).fill(block) }).success).toBe(false);
    expect(evalCaseInputSchema.safeParse({ untrusted: [{ ...block, label: 'x'.repeat(101) }] }).success).toBe(false);
    expect(evalCaseInputSchema.safeParse({ untrusted: [{ ...block, text: 'x'.repeat(20_001) }] }).success).toBe(false);
    expect(evalCaseInputSchema.safeParse({ untrusted: [{ ...block, origin: 'web' }] }).success).toBe(false);
    expect(evalCaseInputSchema.safeParse({ untrusted: [{ ...block, extra: 1 }] }).success).toBe(false);
  });

  it('input : objet lié (type et id nullables) et contexte objet', () => {
    expect(evalCaseInputSchema.safeParse({ subject: { type: 'mail', id: '12' } }).success).toBe(true);
    expect(evalCaseInputSchema.safeParse({ subject: { type: null, id: null } }).success).toBe(true);
    expect(evalCaseInputSchema.safeParse({ subject: { type: 'mail' } }).success).toBe(false);
    expect(evalCaseInputSchema.safeParse({ context: { a: 1 } }).success).toBe(true);
    expect(evalCaseInputSchema.safeParse({ context: 'x' }).success).toBe(false);
    expect(evalCaseInputSchema.safeParse({ context: { t: 'x'.repeat(20_001) } }).success).toBe(false);
  });

  it('cas : label <= 300, poids > 0, taille <= 64 Kio', () => {
    const base = { label: 'Cas', input: {}, expected: { returnsToHuman: true } };
    expect(createEvalCaseSchema.safeParse(base).success).toBe(true);
    expect(createEvalCaseSchema.safeParse({ ...base, label: 'x'.repeat(301) }).success).toBe(false);
    expect(createEvalCaseSchema.safeParse({ ...base, label: '' }).success).toBe(false);
    expect(createEvalCaseSchema.safeParse({ ...base, weight: 0 }).success).toBe(false);
    expect(createEvalCaseSchema.safeParse({ ...base, weight: -1 }).success).toBe(false);
    expect(createEvalCaseSchema.safeParse({ ...base, weight: 2 }).success).toBe(true);
    const big = { untrusted: Array.from({ length: 4 }, () => ({ label: 'L', origin: 'document' as const, text: 'x'.repeat(20_000) })) };
    expect(evalCaseByteSize(big, base.expected)).toBeGreaterThan(EVAL_CASE_MAX_BYTES);
    expect(createEvalCaseSchema.safeParse({ ...base, input: big }).success).toBe(false);
    const ok = { untrusted: [{ label: 'L', origin: 'document' as const, text: 'x'.repeat(20_000) }] };
    expect(createEvalCaseSchema.safeParse({ ...base, input: ok }).success).toBe(true);
  });
});
