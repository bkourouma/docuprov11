// Aide de test : renvoie le VRAI jeu d'évaluation `eval/<nom>.eval` s'il existe, sinon le double local.
// Utilisée dans `jest.mock(chemin, () => loadEvalOrFake(nom), { virtual: true })`.

export function loadEvalOrFake(name: 'aiguilleur' | 'redacteur' | 'controleur' | 'relanceur'): unknown {
  try {
    return jest.requireActual(`../../eval/${name}.eval`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'MODULE_NOT_FOUND' || !String((err as Error).message).includes(`${name}.eval`)) throw err;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./eval-fakes');
  }
}
