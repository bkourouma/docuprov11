import { MIN_STARTER_EVAL_CASES, type EvalSeedCase, type EvalSeedSet } from '../../catalog.contracts';

// Doubles de test : jeux d'évaluation de départ minimalistes, utilisés SEULEMENT tant que les vrais jeux
// (`eval/<agent>.eval.ts`) n'existent pas. Ne jamais importer ce fichier hors des tests.

function fakeSet(agent: string): EvalSeedSet {
  const cases: EvalSeedCase[] = Array.from({ length: MIN_STARTER_EVAL_CASES }, (_, i) => ({
    label: `Cas ${i + 1} de l'agent ${agent}`,
    input: { untrusted: [{ label: 'Courrier', origin: 'mail', text: `Texte d'exemple ${i + 1}` }] },
    expected: { returnsToHuman: true },
  }));
  return { name: `Jeu de départ ${agent}`, description: `Jeu d'évaluation de départ (double de test) pour ${agent}.`, minAccuracy: 0.8, cases };
}

export const aiguilleurEvalSet = fakeSet('aiguilleur');
export const redacteurEvalSet = fakeSet('redacteur');
export const controleurEvalSet = fakeSet('controleur');
export const relanceurEvalSet = fakeSet('relanceur');
