/* eslint-disable @typescript-eslint/no-explicit-any -- graphes bruts altérés volontairement */
import { validateWorkflowGraph } from '@archivage/types';
import { AUTHORING_MAX_STEPS } from './authoring.contracts';
import { extractFigures } from './authoring.assumptions';
import { parseAuthoringOutput } from './authoring.output';
import { suggestTrigger } from './authoring.trigger';
import {
  AUTHORING_EVAL_CASES,
  checkAssumptions,
  checkStructure,
  type AuthoringEvalCase,
} from './authoring.eval.cases';

const CATALOG_TOOLS = ['rechercher_documents', 'lire_document', 'lire_courrier', 'proposer_imputation', 'proposer_reponse'];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function steps(c: AuthoringEvalCase): Array<Record<string, unknown>> {
  return (c.modelOutput.graph as { steps: Array<Record<string, unknown>> }).steps;
}

describe('jeu d’évaluation de la génération', () => {
  it('contient 8 cas distincts en français', () => {
    expect(AUTHORING_EVAL_CASES).toHaveLength(8);
    expect(new Set(AUTHORING_EVAL_CASES.map((c) => c.id)).size).toBe(8);
    for (const c of AUTHORING_EVAL_CASES) {
      expect(c.description.length).toBeGreaterThan(40);
      expect(c.titre.length).toBeGreaterThan(5);
    }
  });

  it.each(AUTHORING_EVAL_CASES.map((c) => [c.id, c] as const))('%s : graphe valide pour validateWorkflowGraph', (_id, c) => {
    const result = validateWorkflowGraph(c.modelOutput.graph);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(steps(c).length).toBeLessThanOrEqual(AUTHORING_MAX_STEPS);
  });

  it.each(AUTHORING_EVAL_CASES.map((c) => [c.id, c] as const))('%s : checkStructure ne signale aucun écart', (_id, c) => {
    expect(checkStructure(c.modelOutput.graph, c.attendu)).toEqual([]);
    expect(checkAssumptions(c.modelOutput.assumptions, c.attendu)).toEqual([]);
  });

  it.each(AUTHORING_EVAL_CASES.map((c) => [c.id, c] as const))(
    '%s : autonomie « suggere » seule, aucun identifiant, outils du catalogue',
    (_id, c) => {
      for (const step of steps(c)) {
        const agent = step.agent as { autonomy?: string; tools: string[] } | undefined;
        if (agent) {
          expect(agent.autonomy ?? 'suggere').toBe('suggere');
          for (const tool of agent.tools) expect(CATALOG_TOOLS).toContain(tool);
          expect(c.attendu.agentToolsAllowed.length).toBeGreaterThan(0);
        }
        expect(step.assignee).toBeUndefined();
      }
      const text = JSON.stringify(c.modelOutput.graph);
      expect(text).not.toMatch(/"autonome"|"agit_avec_validation"/);
      expect(text).not.toMatch(/"(?:userId|userGroupId|groupId|roleId|id)"\s*:/);
    },
  );

  it.each(AUTHORING_EVAL_CASES.map((c) => [c.id, c] as const))('%s : la sortie simulée traverse parseAuthoringOutput', (_id, c) => {
    const json = JSON.stringify(c.modelOutput);
    expect(parseAuthoringOutput(json).graph).toEqual(c.modelOutput.graph);
    expect(parseAuthoringOutput('```json\n' + json + '\n```').name).toBe(c.modelOutput.name);
  });

  it.each(AUTHORING_EVAL_CASES.map((c) => [c.id, c] as const))('%s : déclencheur suggéré conforme à l’attendu', (_id, c) => {
    const s = suggestTrigger({
      description: c.description,
      triggerHint: c.triggerHint,
      modelTrigger: c.modelOutput.trigger,
    });
    expect(s?.eventType ?? null).toBe(c.attendu.triggerEvent);
    // Sans l'aide du modèle ni de l'indice, la détection par mots-clés donne le même résultat.
    const bare = suggestTrigger({ description: c.description, modelTrigger: null });
    expect(bare?.eventType ?? null).toBe(c.attendu.triggerEvent);
  });

  it('les chiffres attendus se retrouvent aussi par extraction déterministe', () => {
    for (const c of AUTHORING_EVAL_CASES) {
      const lines = extractFigures(c.description).join('\n');
      for (const mention of c.attendu.assumptionsMention) expect(lines).toContain(mention);
      if (c.attendu.assumptionsMention.length === 0) expect(lines).toBe('');
    }
  });

  it('les cas à seuil conservent la valeur lue et laissent la métadonnée à choisir', () => {
    const c = AUTHORING_EVAL_CASES.find((x) => x.id === 'facture-fournisseur');
    expect(c).toBeDefined();
    const s = suggestTrigger({
      description: 'Quand le montant d’un document dépasse 5 M FCFA.',
      modelTrigger: { eventType: 'threshold.crossed', conditions: { threshold: { metaDataId: 9, op: 'gt', value: 5000000 } } },
    });
    expect(s?.conditions).toEqual({ threshold: { op: 'gt', value: 5000000 } });
    expect(s?.incomplete).toContain('threshold.metaDataId : à choisir');
  });

  it('couvre les quatre types d’événement attendus ou l’absence de déclencheur', () => {
    const events = new Set(AUTHORING_EVAL_CASES.map((c) => c.attendu.triggerEvent));
    expect(events.has('mail.arrived')).toBe(true);
    expect(events.has('document.deposited')).toBe(true);
    expect(events.has('deadline.reached')).toBe(true);
    expect(events.has(null)).toBe(true);
  });
});

describe('checkStructure — écarts détectés sur un graphe altéré', () => {
  const facture = AUTHORING_EVAL_CASES[0] as AuthoringEvalCase;

  function alter(mutate: (graph: { steps: Array<Record<string, any>> }) => void): unknown {
    const graph = clone(facture.modelOutput.graph) as { steps: Array<Record<string, any>> };
    mutate(graph);
    return graph;
  }

  it('graphe absent ou illisible', () => {
    expect(checkStructure(null, facture.attendu)).toEqual(['Le graphe est absent ou illisible.']);
    expect(checkStructure({ steps: 'non' }, facture.attendu)).toEqual(['Le graphe est absent ou illisible.']);
    expect(checkStructure('texte', facture.attendu)).toHaveLength(1);
  });

  it('trop peu d’étapes', () => {
    const gaps = checkStructure({ schemaVersion: 1, start: 'a', steps: [{ key: 'a', name: 'A', type: 'formulaire', next: [] }] }, facture.attendu);
    expect(gaps.join('\n')).toContain("Trop peu d'étapes : 1 (au moins 6 attendues)");
    expect(gaps.join('\n')).toContain('Aucune étape de type « agent »');
  });

  it('trop d’étapes', () => {
    const gaps = checkStructure(
      alter((g) => {
        for (let i = 0; i < 5; i++) g.steps.push({ key: `extra_${i}`, name: 'E', type: 'formulaire', next: [] });
      }),
      facture.attendu,
    );
    expect(gaps.some((g) => g.startsWith("Trop d'étapes"))).toBe(true);
  });

  it('décision manquante (types et branches)', () => {
    const gaps = checkStructure(
      alter((g) => {
        const d = g.steps.find((s) => s.type === 'decision');
        d!.type = 'formulaire';
        d!.next = [d!.next[0]];
      }),
      facture.attendu,
    );
    expect(gaps.join('\n')).toContain('Aucune décision à deux branches au moins.');
    expect(gaps.join('\n')).toContain('Aucune étape de type « decision »');
  });

  it('validation manquante', () => {
    const gaps = checkStructure(
      alter((g) => {
        for (const s of g.steps) if (s.type === 'validation') s.type = 'formulaire';
      }),
      facture.attendu,
    );
    expect(gaps).toContain('Aucune étape de validation.');
  });

  it('outil hors liste et autonomie élevée', () => {
    const gaps = checkStructure(
      alter((g) => {
        const agent = g.steps.find((s) => s.type === 'agent')!;
        agent.agent.tools = ['envoyer_mail'];
        agent.agent.autonomy = 'autonome';
      }),
      facture.attendu,
    );
    expect(gaps.join('\n')).toContain('utilise un outil hors liste attendue');
    expect(gaps.join('\n')).toContain('autonomie autre que « suggere »');
  });

  it('identifiant d’utilisateur inventé', () => {
    const gaps = checkStructure(
      alter((g) => {
        const v = g.steps.find((s) => s.type === 'validation')!;
        v.assignee = { kind: 'user', id: 42 };
      }),
      facture.attendu,
    );
    expect(gaps.join('\n')).toContain("porte un identifiant d'affectation");
  });

  it('libellé d’affectation attendu absent', () => {
    const gaps = checkStructure(
      alter((g) => {
        for (const s of g.steps) delete s.assigneeHint;
      }),
      facture.attendu,
    );
    expect(gaps).toEqual(expect.arrayContaining(['Aucune affectation « DAF » trouvée.', 'Aucune affectation « Chef de service » trouvée.']));
  });

  it('le libellé peut aussi venir du marqueur « à compléter » posé par les garde-fous', () => {
    const graph = alter((g) => {
      for (const s of g.steps) {
        const hint = s.assigneeHint as string | undefined;
        delete s.assigneeHint;
        if (hint) s.config = { authoring: { toComplete: ['assignee'], assigneeHint: hint } };
      }
    });
    expect(checkStructure(graph, facture.attendu)).toEqual([]);
  });

  it('graphe invalide pour le validateur', () => {
    const gaps = checkStructure(
      alter((g) => {
        g.steps[0]!.next = [{ to: 'inconnue' }];
      }),
      facture.attendu,
    );
    expect(gaps.some((g) => g.startsWith('Graphe invalide'))).toBe(true);
  });

  it('étape agent non attendue', () => {
    const conge = AUTHORING_EVAL_CASES.find((c) => c.id === 'demande-conge') as AuthoringEvalCase;
    const graph = clone(conge.modelOutput.graph) as { steps: Array<Record<string, any>> };
    graph.steps[0]!.type = 'agent';
    graph.steps[0]!.agent = { objective: 'x', tools: [], autonomy: 'suggere', confidenceThreshold: 0.8 };
    expect(checkStructure(graph, conge.attendu).join('\n')).toContain("Une étape agent est présente alors qu'aucune n'est attendue.");
  });

  it('hypothèse attendue absente', () => {
    expect(checkAssumptions(['Rien de chiffré.'], facture.attendu)).toEqual(['Les hypothèses ne mentionnent pas « 5 000 000 ».']);
  });
});
