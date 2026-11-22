import { createEvalCaseSchema } from '../../workflow-agents/eval/eval.dto';
import { EVAL_CASE_MAX_BYTES, evalCaseByteSize } from '../../workflow-agents/eval/eval-expected';
import { MIN_STARTER_EVAL_CASES, type EvalSeedSet } from '../catalog.contracts';
import { controleurEvalSet } from './controleur.eval';
import { relanceurEvalSet } from './relanceur.eval';

describe.each<[string, EvalSeedSet]>([
  ['contrôleur', controleurEvalSet],
  ['relanceur', relanceurEvalSet],
])('jeu d\'évaluation de départ : %s', (_nom, jeu) => {
  it(`compte au moins ${MIN_STARTER_EVAL_CASES} cas`, () => {
    expect(jeu.cases.length).toBeGreaterThanOrEqual(MIN_STARTER_EVAL_CASES);
  });

  it('exige une précision minimale d\'au moins 0,8 et porte un nom et une description', () => {
    expect(jeu.minAccuracy).toBeGreaterThanOrEqual(0.8);
    expect(jeu.name.trim().length).toBeGreaterThan(0);
    expect(jeu.description.trim().length).toBeGreaterThan(0);
  });

  it('a des étiquettes uniques', () => {
    const etiquettes = jeu.cases.map((c) => c.label);
    expect(new Set(etiquettes).size).toBe(etiquettes.length);
  });

  it('a des cas valides pour createEvalCaseSchema et dans la limite de taille', () => {
    for (const cas of jeu.cases) {
      const res = createEvalCaseSchema.safeParse(cas);
      if (!res.success) throw new Error(`Cas invalide « ${cas.label} » : ${res.error.message}`);
      expect(evalCaseByteSize(cas.input, cas.expected)).toBeLessThanOrEqual(EVAL_CASE_MAX_BYTES);
      for (const bloc of cas.input.untrusted ?? []) expect(bloc.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('comporte au moins 2 cas d\'injection (suspicionInjection) et 2 cas de renvoi à l\'humain', () => {
    expect(jeu.cases.filter((c) => c.expected.suspicionInjection === true).length).toBeGreaterThanOrEqual(2);
    expect(jeu.cases.filter((c) => c.expected.returnsToHuman === true).length).toBeGreaterThanOrEqual(2);
  });

  it('ne contient aucune adresse électronique hors du domaine .example', () => {
    const adresses = JSON.stringify(jeu.cases).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    for (const a of adresses) expect(a.endsWith('.example')).toBe(true);
  });
});

describe('verdicts attendus', () => {
  it('le contrôleur ne produit jamais de verdict bloquant', () => {
    for (const cas of controleurEvalSet.cases) {
      expect(['conforme', 'a_verifier']).toContain(cas.expected.result?.verdict);
    }
  });

  it('le relanceur n\'attend que des verdicts prévus', () => {
    for (const cas of relanceurEvalSet.cases) {
      const v = cas.expected.result?.verdict;
      if (v !== undefined) expect(['relance_proposee', 'redirection_proposee', 'aucune_action']).toContain(v);
    }
  });
});
