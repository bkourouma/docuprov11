import { MALICIOUS_MODEL_OUTPUTS } from './injection.corpus';
import {
  MODEL_TURN_MAX_DEPTH,
  ModelTurnError,
  WF_AGENT_TURN_JSON_SCHEMA,
  exceedsNesting,
  normalizeConfidence,
  parseModelTurn,
} from './output-schema';

describe('parseModelTurn — sorties valides', () => {
  it('accepte un appel d’outil', () => {
    expect(parseModelTurn('{"type":"tool_call","tool":"rechercher_documents","arguments":{"query":"facture"}}')).toEqual({
      type: 'tool_call',
      tool: 'rechercher_documents',
      arguments: { query: 'facture' },
    });
  });

  it('accepte une conclusion complète (BOM et blancs tolérés)', () => {
    const raw = `\uFEFF  ${JSON.stringify({
      type: 'final',
      result: { decision: 'conforme', montant: 1250 },
      explanation: 'Facture conforme.',
      confidence: 0.85,
      sources: [{ kind: 'document', id: 12, label: 'Facture 12' }],
      suspicion: false,
    })}  `;
    expect(parseModelTurn(raw)).toEqual({
      type: 'final',
      result: { decision: 'conforme', montant: 1250 },
      explanation: 'Facture conforme.',
      confidence: 0.85,
      sources: [{ kind: 'document', id: 12, label: 'Facture 12' }],
      suspicion: false,
    });
  });

  it('confiance hors [0,1], absente ou nulle : ramenée à null (jamais rejetée ni bornée vers 1)', () => {
    const base = { type: 'final', result: {}, explanation: 'x' };
    for (const confidence of [1.5, -0.1, null, undefined]) {
      const turn = parseModelTurn(JSON.stringify({ ...base, confidence }));
      expect(turn.type === 'final' && turn.confidence).toBeNull();
    }
    const raw = '{"type":"final","result":{},"explanation":"x","confidence":1e400}';
    const turn = parseModelTurn(raw);
    expect(turn.type === 'final' && turn.confidence).toBeNull();
  });

  it('sources et suspicion facultatives : valeurs par défaut sûres', () => {
    const turn = parseModelTurn('{"type":"final","result":{},"explanation":"x","confidence":0.5}');
    expect(turn).toMatchObject({ sources: [], suspicion: false });
  });
});

describe('parseModelTurn — sorties malveillantes', () => {
  it.each(Object.entries(MALICIOUS_MODEL_OUTPUTS))('%s : refusée par une erreur typée', (_id, raw) => {
    let caught: unknown;
    try {
      parseModelTurn(raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ModelTurnError);
    const err = caught as ModelTurnError;
    expect(err.name).toBe('ModelTurnError');
    // Le message ne reprend jamais le contenu du modèle.
    for (const fragment of ['admin', 'isAdmin', 'envoyer_courrier', 'attaquant', 'execute_now', 'Nouvelles']) {
      expect(err.message).not.toContain(fragment);
    }
  });

  it('codes attendus', () => {
    const code = (raw: string): string => {
      try {
        parseModelTurn(raw);
        return 'ok';
      } catch (e) {
        return (e as ModelTurnError).code;
      }
    };
    expect(code(MALICIOUS_MODEL_OUTPUTS.cle_en_trop_final!)).toBe('schema');
    expect(code(MALICIOUS_MODEL_OUTPUTS.proto!)).toBe('forbidden_key');
    expect(code(MALICIOUS_MODEL_OUTPUTS.proto_racine!)).toBe('forbidden_key');
    expect(code(MALICIOUS_MODEL_OUTPUTS.cle_constructor!)).toBe('forbidden_key');
    expect(code(MALICIOUS_MODEL_OUTPUTS.imbrication!)).toBe('too_deep');
    expect(code(MALICIOUS_MODEL_OUTPUTS.taille!)).toBe('too_long');
    expect(code(MALICIOUS_MODEL_OUTPUTS.non_json!)).toBe('not_json');
    expect(code(MALICIOUS_MODEL_OUTPUTS.tableau!)).toBe('schema');
    expect(code(MALICIOUS_MODEL_OUTPUTS.vide!)).toBe('absent');
    expect(code(undefined as unknown as string)).toBe('absent');
  });

  it('taille mesurée en octets UTF-8 avant toute analyse', () => {
    const big = `{"type":"final","result":{"t":"${'é'.repeat(33 * 1024)}"},"explanation":"x","confidence":0.5}`;
    expect(big.length).toBeLessThan(64 * 1024);
    expect(() => parseModelTurn(big)).toThrow(ModelTurnError);
  });

  it('n’altère pas le prototype global', () => {
    try {
      parseModelTurn(MALICIOUS_MODEL_OUTPUTS.proto!);
    } catch {
      /* attendu */
    }
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });
});

describe('exceedsNesting / normalizeConfidence', () => {
  it('compte l’imbrication hors chaînes', () => {
    expect(exceedsNesting('{"a":"[[[[[[[[[[[[[[[[[[[[[[["}', 2)).toBe(false);
    expect(exceedsNesting('[[[]]]', 2)).toBe(true);
    expect(exceedsNesting('{"a":"\\"[[["}', 1)).toBe(false);
    expect(exceedsNesting('{'.repeat(MODEL_TURN_MAX_DEPTH), MODEL_TURN_MAX_DEPTH)).toBe(false);
  });

  it('normalizeConfidence', () => {
    expect(normalizeConfidence(0)).toBe(0);
    expect(normalizeConfidence(1)).toBe(1);
    expect(normalizeConfidence(0.4)).toBe(0.4);
    expect(normalizeConfidence(1.0001)).toBeNull();
    expect(normalizeConfidence(Number.NaN)).toBeNull();
    expect(normalizeConfidence('0.5')).toBeNull();
  });
});

describe('WF_AGENT_TURN_JSON_SCHEMA', () => {
  it('décrit les deux formes, sans clé supplémentaire admise', () => {
    expect(WF_AGENT_TURN_JSON_SCHEMA.name).toBe('wf_agent_turn');
    const variants = (WF_AGENT_TURN_JSON_SCHEMA.schema.anyOf as Array<Record<string, unknown>>) ?? [];
    expect(variants).toHaveLength(2);
    for (const v of variants) expect(v.additionalProperties).toBe(false);
  });
});
