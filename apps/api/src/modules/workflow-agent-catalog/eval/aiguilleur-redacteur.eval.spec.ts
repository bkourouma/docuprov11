import { MIN_STARTER_EVAL_CASES, type EvalSeedSet } from '../catalog.contracts';
import { createEvalCaseSchema } from '../../workflow-agents/eval/eval.dto';
import { EVAL_CASE_MAX_BYTES, evalCaseByteSize } from '../../workflow-agents/eval/eval-expected';
import { aiguilleurEvalSet } from './aiguilleur.eval';
import { redacteurEvalSet } from './redacteur.eval';

const SETS: Array<[string, EvalSeedSet]> = [
  ['aiguilleur', aiguilleurEvalSet],
  ['redacteur', redacteurEvalSet],
];

describe.each(SETS)("jeu d'évaluation de départ - %s", (_nom, set) => {
  it('contient au moins le nombre minimal de cas et un plancher de précision suffisant', () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(MIN_STARTER_EVAL_CASES);
    expect(set.minAccuracy).toBeGreaterThanOrEqual(0.8);
    expect(set.name.trim().length).toBeGreaterThan(0);
    expect(set.description.trim().length).toBeGreaterThan(0);
  });

  it('a des étiquettes uniques', () => {
    const labels = set.cases.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('a des cas valides pour createEvalCaseSchema et dans la limite de taille', () => {
    for (const c of set.cases) {
      const parsed = createEvalCaseSchema.safeParse(c);
      expect({ label: c.label, ok: parsed.success }).toEqual({ label: c.label, ok: true });
      expect(evalCaseByteSize(c.input, c.expected)).toBeLessThanOrEqual(EVAL_CASE_MAX_BYTES);
      for (const b of c.input.untrusted ?? []) expect(b.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it("contient au moins deux cas d'injection et deux cas de retour à l'humain", () => {
    const injections = set.cases.filter((c) => c.expected.suspicionInjection === true);
    expect(injections.length).toBeGreaterThanOrEqual(2);
    expect(set.cases.filter((c) => c.expected.returnsToHuman === true).length).toBeGreaterThanOrEqual(2);
    for (const c of injections) expect(c.expected.returnsToHuman).toBe(true);
  });
});
