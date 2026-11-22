import { AuthoringOutputError } from './authoring.contracts';
import {
  AUTHORING_OUTPUT_ERRORS,
  AUTHORING_OUTPUT_MAX_BYTES,
  AUTHORING_OUTPUT_NAME_FALLBACK,
  parseAuthoringOutput,
} from './authoring.output';

const GRAPH = { schemaVersion: 1, start: 'a', steps: [{ key: 'a', name: 'A', type: 'formulaire', next: [] }] };

function raw(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'Facture', description: 'Desc', graph: GRAPH, assumptions: ['h1'], trigger: null, ...extra });
}

function errorOf(input: string): AuthoringOutputError {
  try {
    parseAuthoringOutput(input);
  } catch (e) {
    expect(e).toBeInstanceOf(AuthoringOutputError);
    return e as AuthoringOutputError;
  }
  throw new Error("aucune erreur levée");
}

describe('parseAuthoringOutput — sorties valides', () => {
  it('accepte une sortie complète', () => {
    expect(parseAuthoringOutput(raw())).toEqual({
      name: 'Facture',
      description: 'Desc',
      graph: GRAPH,
      assumptions: ['h1'],
      trigger: null,
    });
  });

  it('tolère un habillage ```json … ```', () => {
    const wrapped = '```json\n' + raw() + '\n```';
    expect(parseAuthoringOutput(wrapped).name).toBe('Facture');
  });

  it('tolère une clôture sans langage, des blancs et un BOM', () => {
    expect(parseAuthoringOutput('﻿  ```\n' + raw() + '\n```  \n').name).toBe('Facture');
  });

  it('tolère une clôture ouvrante seule (réponse tronquée après le JSON)', () => {
    expect(parseAuthoringOutput('```json\n' + raw()).name).toBe('Facture');
  });

  it('accepte le déclencheur du modèle sans le valider (revalidé plus loin)', () => {
    const out = parseAuthoringOutput(
      raw({ trigger: { eventType: 'mail.arrived', conditions: { match: [] }, reason: 'Courrier <b>entrant</b>' } }),
    );
    expect(out.trigger).toEqual({ eventType: 'mail.arrived', conditions: { match: [] }, reason: 'Courrier ‹b›entrant‹/b›' });
  });

  it('déclencheur mal formé : ramené à null', () => {
    for (const trigger of ['mail.arrived', 12, [], {}, { eventType: 5 }, { eventType: '' }, { eventType: 'x'.repeat(81) }]) {
      expect(parseAuthoringOutput(raw({ trigger })).trigger).toBeNull();
    }
  });

  it('raison du déclencheur bornée à 300 caractères', () => {
    const out = parseAuthoringOutput(raw({ trigger: { eventType: 'mail.arrived', reason: 'r'.repeat(900) } }));
    expect(Array.from(out.trigger?.reason ?? '').length).toBeLessThanOrEqual(300);
  });
});

describe('parseAuthoringOutput — rejets', () => {
  it.each([
    ['vide', '', AUTHORING_OUTPUT_ERRORS.absent],
    ['blancs', '   \n ', AUTHORING_OUTPUT_ERRORS.absent],
    ['clôture vide', '```json\n```', AUTHORING_OUTPUT_ERRORS.absent],
    ['JSON invalide', '{"name": ', AUTHORING_OUTPUT_ERRORS.not_json],
    ['texte libre', 'Voici votre workflow', AUTHORING_OUTPUT_ERRORS.not_json],
    ['tableau', '[1,2]', AUTHORING_OUTPUT_ERRORS.not_object],
    ['null', 'null', AUTHORING_OUTPUT_ERRORS.not_object],
    ['chaîne', '"texte"', AUTHORING_OUTPUT_ERRORS.not_object],
    ['nombre', '42', AUTHORING_OUTPUT_ERRORS.not_object],
    ['sans graphe', '{"name":"x"}', AUTHORING_OUTPUT_ERRORS.no_graph],
    ['graphe tableau', '{"name":"x","graph":[]}', AUTHORING_OUTPUT_ERRORS.no_graph],
    ['graphe null', '{"name":"x","graph":null}', AUTHORING_OUTPUT_ERRORS.no_graph],
    ['graphe chaîne', '{"name":"x","graph":"abc"}', AUTHORING_OUTPUT_ERRORS.no_graph],
  ])('%s : erreur au message fixe', (_label, input, message) => {
    expect(errorOf(input).message).toBe(message);
  });

  it('refuse une sortie de plus de 128 Kio (octets, pas caractères)', () => {
    expect(errorOf('x'.repeat(AUTHORING_OUTPUT_MAX_BYTES + 1)).message).toBe(AUTHORING_OUTPUT_ERRORS.too_long);
    // 70 000 caractères de 2 octets : 140 000 octets.
    expect(errorOf(JSON.stringify({ graph: {}, name: 'é'.repeat(70000) })).message).toBe(AUTHORING_OUTPUT_ERRORS.too_long);
  });

  it('accepte une sortie juste sous la limite', () => {
    const big = JSON.stringify({ graph: {}, name: 'n', description: 'd'.repeat(AUTHORING_OUTPUT_MAX_BYTES - 200) });
    expect(Buffer.byteLength(big)).toBeLessThan(AUTHORING_OUTPUT_MAX_BYTES);
    expect(parseAuthoringOutput(big).description?.length).toBe(4000);
  });

  it('refuse une imbrication de plus de 12 niveaux', () => {
    const deep = `{"graph":{"a":${'['.repeat(13)}${']'.repeat(13)}}}`;
    expect(errorOf(deep).message).toBe(AUTHORING_OUTPUT_ERRORS.too_deep);
  });

  it('accepte une imbrication de 12 niveaux', () => {
    const ok = `{"graph":{"a":${'['.repeat(10)}${']'.repeat(10)}}}`;
    expect(parseAuthoringOutput(ok).graph).toBeDefined();
  });

  it.each([
    ['__proto__ à la racine', '{"__proto__":{"x":1},"graph":{}}'],
    ['__proto__ dans le graphe', '{"graph":{"steps":[{"__proto__":{"admin":true}}]}}'],
    ['constructor profond', '{"graph":{"a":{"b":{"constructor":{"prototype":{}}}}}}'],
    ['prototype dans le déclencheur', '{"graph":{},"trigger":{"eventType":"x","conditions":{"prototype":1}}}'],
    ['clé dans un tableau', '{"graph":{"l":[{"constructor":1}]}}'],
  ])('refuse une clé dangereuse : %s', (_label, input) => {
    expect(errorOf(input).message).toBe(AUTHORING_OUTPUT_ERRORS.forbidden_key);
  });

  it('les messages ne reprennent jamais le contenu du modèle', () => {
    const secret = 'SECRET-ABC-123';
    for (const input of [
      `{"graph":{},"${secret}":`,
      `["${secret}"]`,
      `{"name":"${secret}"}`,
      `{"graph":{"constructor":"${secret}"}}`,
      `{"graph":{"a":${'['.repeat(20)}"${secret}"${']'.repeat(20)}}}`,
      secret,
    ]) {
      expect(errorOf(input).message).not.toContain(secret);
    }
  });
});

describe('parseAuthoringOutput — champs', () => {
  it('nom : repli, nettoyage et plafond de 200 caractères', () => {
    for (const name of [undefined, '', '   ', 12, null, {}]) {
      expect(parseAuthoringOutput(raw({ name })).name).toBe(AUTHORING_OUTPUT_NAME_FALLBACK);
    }
    expect(parseAuthoringOutput(raw({ name: ' Facture\u0000 ​à   <i>payer</i>\n' })).name).toBe('Facture à ‹i›payer‹/i›');
    expect(Array.from(parseAuthoringOutput(raw({ name: 'n'.repeat(500) })).name).length).toBeLessThanOrEqual(200);
  });

  it('description : null si absente, vide ou non textuelle ; plafonnée à 4000', () => {
    for (const description of [undefined, null, '', '  ', 5, []]) {
      expect(parseAuthoringOutput(raw({ description })).description).toBeNull();
    }
    expect(Array.from(parseAuthoringOutput(raw({ description: 'd'.repeat(9000) })).description ?? '').length).toBe(4000);
  });

  it('hypothèses : seulement des chaînes non vides, nettoyées, au plus 50, de 600 caractères', () => {
    expect(parseAuthoringOutput(raw({ assumptions: 'x' })).assumptions).toEqual([]);
    expect(parseAuthoringOutput(raw({ assumptions: undefined })).assumptions).toEqual([]);
    const out = parseAuthoringOutput(raw({ assumptions: ['  a\u0000b ', '', 3, null, { x: 1 }, '<x>', 'z'.repeat(2000)] }));
    expect(out.assumptions[0]).toBe('ab');
    expect(out.assumptions[1]).toBe('‹x›');
    expect(Array.from(out.assumptions[2] ?? '').length).toBeLessThanOrEqual(600);
    expect(out.assumptions).toHaveLength(3);
    const many = parseAuthoringOutput(raw({ assumptions: Array.from({ length: 80 }, (_v, i) => `h${i}`) }));
    expect(many.assumptions).toHaveLength(50);
  });

  it('le graphe est renvoyé tel quel, sans validation', () => {
    const weird = { n: 'importe quoi', steps: 'non' };
    expect(parseAuthoringOutput(raw({ graph: weird })).graph).toEqual(weird);
  });
});
