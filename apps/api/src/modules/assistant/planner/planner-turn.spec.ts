import {
  PLANNER_CHOICES_MAX,
  PLANNER_CHOICE_LABEL_MAX_CHARS,
  PLANNER_QUESTION_MAX_CHARS,
  PLANNER_REPLY_MAX_CHARS,
} from './planner.types';
import { ASST_TURN_JSON_SCHEMA, AsstTurnError, parseAsstTurn, type AsstTurnErrorCode } from './planner-turn';

function codeOf(raw: string): AsstTurnErrorCode {
  try {
    parseAsstTurn(raw);
  } catch (e) {
    if (e instanceof AsstTurnError) return e.code;
    throw e;
  }
  throw new Error('aucune erreur levée');
}

const choices = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Choix ${i + 1}` }));
const action = { tool: 'proposer_relance', args: { mailId: 1, mailInputationId: 2 } };

describe('parseAsstTurn : formes valides', () => {
  it('tool_call', () => {
    expect(parseAsstTurn('{"type":"tool_call","tool":"lire_courrier","arguments":{"mailId":3}}')).toEqual({
      type: 'tool_call',
      tool: 'lire_courrier',
      arguments: { mailId: 3 },
    });
  });

  it('clarify (2 choix) renvoie des libellés simples', () => {
    expect(parseAsstTurn(JSON.stringify({ type: 'clarify', question: 'Quel DAF ?', choices: choices(2) }))).toEqual({
      type: 'clarify',
      question: 'Quel DAF ?',
      choices: ['Choix 1', 'Choix 2'],
    });
  });

  it('clarify accepte 6 choix', () => {
    const t = parseAsstTurn(JSON.stringify({ type: 'clarify', question: 'Q', choices: choices(PLANNER_CHOICES_MAX) }));
    expect(t.type === 'clarify' && t.choices).toHaveLength(6);
  });

  it('answer', () => {
    expect(parseAsstTurn('{"type":"answer","text":"Bonjour"}')).toEqual({ type: 'answer', text: 'Bonjour' });
  });

  it('propose en camelCase', () => {
    expect(
      parseAsstTurn(JSON.stringify({ type: 'propose', actions: [action], intent_source: 'message_utilisateur', suspicion: false })),
    ).toEqual({ type: 'propose', actions: [action], intentSource: 'message_utilisateur', suspicion: false });
  });

  it('propose accepte 5 actions et la source externe avec suspicion', () => {
    const t = parseAsstTurn(
      JSON.stringify({ type: 'propose', actions: Array(5).fill(action), intent_source: 'donnee_externe', suspicion: true }),
    );
    expect(t.type === 'propose' && t.actions).toHaveLength(5);
    expect(t.type === 'propose' && t.intentSource).toBe('donnee_externe');
    expect(t.type === 'propose' && t.suspicion).toBe(true);
  });

  it('tolère un BOM et des espaces autour du JSON', () => {
    expect(parseAsstTurn('﻿  {"type":"answer","text":"ok"}  \n')).toEqual({ type: 'answer', text: 'ok' });
  });
});

describe('parseAsstTurn : rejets', () => {
  it.each([
    ['chaîne vide', ''],
    ['blancs seuls', '   \n'],
  ])('absent : %s', (_n, raw) => {
    expect(codeOf(raw)).toBe('absent');
  });

  it('non-chaîne = absent', () => {
    expect(codeOf(undefined as unknown as string)).toBe('absent');
  });

  it('trop long', () => {
    expect(codeOf(JSON.stringify({ type: 'answer', text: 'a'.repeat(70_000) }))).toBe('too_long');
  });

  it('trop long en octets (caractères multi-octets)', () => {
    expect(codeOf(`"${'é'.repeat(40_000)}"`)).toBe('too_long');
  });

  it('trop profond', () => {
    const deep = '['.repeat(20) + ']'.repeat(20);
    expect(codeOf(`{"type":"tool_call","tool":"x","arguments":{"a":${deep}}}`)).toBe('too_deep');
  });

  it('non JSON', () => {
    expect(codeOf('Voici ma réponse')).toBe('not_json');
  });

  it('JSON non objet = schema', () => {
    expect(codeOf('[1,2]')).toBe('schema');
    expect(codeOf('"texte"')).toBe('schema');
    expect(codeOf('null')).toBe('schema');
  });

  it.each(['__proto__', 'constructor', 'prototype'])('clé interdite %s (imbriquée)', (key) => {
    expect(codeOf(`{"type":"tool_call","tool":"x","arguments":{"a":{"${key}":1}}}`)).toBe('forbidden_key');
  });

  it('clé inconnue', () => {
    expect(codeOf('{"type":"answer","text":"ok","extra":1}')).toBe('schema');
  });

  it('type inconnu ou absent', () => {
    expect(codeOf('{"type":"final","text":"ok"}')).toBe('schema');
    expect(codeOf('{"text":"ok"}')).toBe('schema');
  });

  it('propose avec 0 action', () => {
    expect(codeOf(JSON.stringify({ type: 'propose', actions: [], intent_source: 'message_utilisateur', suspicion: false }))).toBe('schema');
  });

  it('propose avec 6 actions', () => {
    expect(
      codeOf(JSON.stringify({ type: 'propose', actions: Array(6).fill(action), intent_source: 'message_utilisateur', suspicion: false })),
    ).toBe('schema');
  });

  it('intent_source invalide', () => {
    expect(codeOf(JSON.stringify({ type: 'propose', actions: [action], intent_source: 'modele', suspicion: false }))).toBe('schema');
  });

  it('suspicion manquante ou non booléenne', () => {
    expect(codeOf(JSON.stringify({ type: 'propose', actions: [action], intent_source: 'message_utilisateur' }))).toBe('schema');
    expect(codeOf(JSON.stringify({ type: 'propose', actions: [action], intent_source: 'message_utilisateur', suspicion: 'non' }))).toBe('schema');
  });

  it('action avec clé inconnue', () => {
    const bad = { tool: 'proposer_relance', args: {}, motif: 'x' };
    expect(codeOf(JSON.stringify({ type: 'propose', actions: [bad], intent_source: 'message_utilisateur', suspicion: false }))).toBe('schema');
  });

  it('moins de 2 choix', () => {
    expect(codeOf(JSON.stringify({ type: 'clarify', question: 'Q', choices: choices(1) }))).toBe('schema');
  });

  it('plus de 6 choix', () => {
    expect(codeOf(JSON.stringify({ type: 'clarify', question: 'Q', choices: choices(7) }))).toBe('schema');
  });

  it('libellé de choix trop long ou question trop longue ou réponse trop longue', () => {
    expect(
      codeOf(JSON.stringify({ type: 'clarify', question: 'Q', choices: [{ label: 'a'.repeat(PLANNER_CHOICE_LABEL_MAX_CHARS + 1) }, { label: 'b' }] })),
    ).toBe('schema');
    expect(codeOf(JSON.stringify({ type: 'clarify', question: 'a'.repeat(PLANNER_QUESTION_MAX_CHARS + 1), choices: choices(2) }))).toBe('schema');
    expect(codeOf(JSON.stringify({ type: 'answer', text: 'a'.repeat(PLANNER_REPLY_MAX_CHARS + 1) }))).toBe('schema');
  });

  it('tool_call : outil vide ou arguments non objet', () => {
    expect(codeOf('{"type":"tool_call","tool":"","arguments":{}}')).toBe('schema');
    expect(codeOf('{"type":"tool_call","tool":"x","arguments":[1]}')).toBe('schema');
    expect(codeOf('{"type":"tool_call","tool":"x","arguments":null}')).toBe('schema');
  });

  it('texte vide après nettoyage (invisibles et blancs seuls)', () => {
    expect(codeOf(JSON.stringify({ type: 'answer', text: '​‍ ⁠' }))).toBe('schema');
    expect(codeOf(JSON.stringify({ type: 'clarify', question: '​', choices: choices(2) }))).toBe('schema');
    expect(codeOf(JSON.stringify({ type: 'clarify', question: 'Q', choices: [{ label: '‮' }, { label: 'ok' }] }))).toBe('schema');
  });
});

describe('parseAsstTurn : nettoyage et messages', () => {
  it('retire les caractères invisibles, de contrôle et les bords', () => {
    const t = parseAsstTurn(JSON.stringify({ type: 'answer', text: '  Bon​jour‮\u0007 monde \n' }));
    expect(t).toEqual({ type: 'answer', text: 'Bonjour monde' });
  });

  it('nettoie question et choix', () => {
    const t = parseAsstTurn(JSON.stringify({ type: 'clarify', question: ' Qu​el ? ', choices: [{ label: 'A‍' }, { label: ' B ' }] }));
    expect(t).toEqual({ type: 'clarify', question: 'Quel ?', choices: ['A', 'B'] });
  });

  it('le message d erreur ne reprend jamais le contenu du modèle', () => {
    const secret = 'SECRET-COURRIER-123';
    const samples = [
      `{"type":"answer","text":"${secret}","extra":1}`,
      `{"type":"tool_call","tool":"x","arguments":{"__proto__":"${secret}"}}`,
      `${secret} pas du json`,
      JSON.stringify({ type: 'propose', actions: [], intent_source: secret, suspicion: false }),
    ];
    for (const raw of samples) {
      try {
        parseAsstTurn(raw);
        throw new Error('devait échouer');
      } catch (e) {
        expect(e).toBeInstanceOf(AsstTurnError);
        expect((e as Error).message).not.toContain(secret);
        expect((e as Error).message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('ASST_TURN_JSON_SCHEMA', () => {
  it('décrit les quatre formes fermées', () => {
    expect(ASST_TURN_JSON_SCHEMA.name).toBe('asst_planner_turn');
    const any = ASST_TURN_JSON_SCHEMA.schema['anyOf'] as Array<Record<string, unknown>>;
    expect(any).toHaveLength(4);
    for (const form of any) expect(form['additionalProperties']).toBe(false);
    const types = any.map((f) => ((f['properties'] as Record<string, { const: string }>)['type']).const);
    expect(types).toEqual(['tool_call', 'clarify', 'answer', 'propose']);
  });
});
