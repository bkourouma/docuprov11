import { validateWorkflowGraph, type WfGraph } from '@archivage/types';
import { AUTHORING_EVAL_CASES } from './authoring.eval.cases';
import { describeCondition, explainGraph, EXPLAIN_MAX_STEPS } from './authoring.explain';

const META = { definitionId: 7, versionNumber: 3, name: 'Traitement des factures' };

function graphOf(raw: unknown): WfGraph {
  const result = validateWorkflowGraph(raw);
  if (!result.ok || !result.graph) throw new Error(`graphe de test invalide : ${JSON.stringify(result.issues)}`);
  return result.graph;
}

function caseGraph(id: string): WfGraph {
  const found = AUTHORING_EVAL_CASES.find((c) => c.id === id);
  if (!found) throw new Error(`cas inconnu ${id}`);
  return graphOf(found.modelOutput.graph);
}

describe('explainGraph — récit principal', () => {
  const explanation = explainGraph(caseGraph('facture-fournisseur'), META);

  it('reprend les identifiants et un titre', () => {
    expect(explanation.definitionId).toBe(7);
    expect(explanation.versionNumber).toBe(3);
    expect(explanation.summary.split('\n')[0]).toBe('Workflow « Traitement des factures » (version 3).');
  });

  it('phrase d’ouverture « Ce workflow démarre par … »', () => {
    expect(explanation.summary).toContain(
      'Ce workflow démarre par « Extraire le montant et le fournisseur », puis « Vérifier le bon de commande ».',
    );
  });

  it('une entrée par étape, dans l’ordre du récit, départ en premier', () => {
    expect(explanation.steps.map((s) => s.key)).toEqual([
      'extraction',
      'verification_bc',
      'seuil_montant',
      'validation_daf',
      'validation_chef',
      'transmission_paiement',
      'rejet',
    ]);
    expect(explanation.steps).toHaveLength(7);
    expect(new Set(explanation.steps.map((s) => s.key)).size).toBe(7);
  });

  it('étape agent : suggère seulement, un humain valide', () => {
    const text = explanation.steps.find((s) => s.key === 'extraction')?.text ?? '';
    expect(text).toContain("l'agent IA a pour objectif");
    expect(text).toContain("avec l'outil lecture d'un document");
    expect(text).toContain('il ne fait que SUGGÉRER, un humain valide.');
    const verif = explanation.steps.find((s) => s.key === 'verification_bc')?.text ?? '';
    expect(verif).toContain('avec les outils recherche de documents, lecture d\'un document');
  });

  it('décision automatique : conditions en langage clair', () => {
    const text = explanation.steps.find((s) => s.key === 'seuil_montant')?.text ?? '';
    expect(text).toContain('Décision automatique');
    expect(text).toContain('Si le montant est supérieur à 5 000 000, on passe à « Validation du DAF ».');
    expect(text).toContain('Sinon, on passe à « Validation du chef de service ».');
  });

  it('validation : accepté / refusé et délai', () => {
    const text = explanation.steps.find((s) => s.key === 'validation_daf')?.text ?? '';
    expect(text).toContain('la demande est acceptée ou refusée');
    expect(text).toContain('Délai prévu : 2 jours (48 heures).');
    expect(text).toContain('Si la validation est acceptée, on passe à « Transmettre à la comptabilité pour paiement ».');
    expect(text).toContain('Sinon, on passe à « Notifier le rejet au fournisseur ».');
  });

  it('étape finale', () => {
    expect(explanation.steps.find((s) => s.key === 'rejet')?.text).toContain('Le workflow se termine ici.');
  });

  it('chiffres de synthèse', () => {
    expect(explanation.summary).toContain('Il comporte 7 étapes (dont 2 confiées à un agent IA, 3 points de branchement)');
  });
});

describe('explainGraph — branches, boucle de correction, refus', () => {
  it('boucle de correction détectée', () => {
    const e = explainGraph(caseGraph('nouvel-agent'), META);
    const confirmation = e.steps.find((s) => s.key === 'confirmation_rh')?.text ?? '';
    expect(confirmation).toContain("Sinon, retour à « Checklist d'arrivée » (boucle de correction).");
    expect(e.summary).toContain('une boucle de correction');
  });

  it('refus formulé en clair', () => {
    const graph = graphOf({
      schemaVersion: 1,
      start: 'v',
      steps: [
        {
          key: 'v',
          name: 'Valider',
          type: 'validation',
          next: [
            { to: 'ok', condition: { field: 'last.approved', op: 'eq', value: true } },
            { to: 'ko', condition: { field: 'last.approved', op: 'eq', value: false } },
          ],
        },
        { key: 'ok', name: 'Archiver', type: 'checklist', next: [] },
        { key: 'ko', name: 'Rejeter', type: 'formulaire', next: [] },
      ],
    });
    const text = explainGraph(graph, META).steps[0]?.text ?? '';
    expect(text).toContain('Si la validation est acceptée, on passe à « Archiver ».');
    expect(text).toContain('Si la validation est refusée, on passe à « Rejeter ».');
  });

  it('décision manuelle : choix possibles', () => {
    const e = explainGraph(caseGraph('dossier-agrement'), META);
    const text = e.steps.find((s) => s.key === 'decision_directeur')?.text ?? '';
    expect(text).toContain('Décision manuelle');
    expect(text).toContain('Choix possibles : « Agrément accordé », « Agrément refusé ».');
    expect(text).toContain('Si le choix est « Agrément accordé », on passe à « Notifier l\'accord d\'agrément ».');
  });

  it('étapes formulaire et checklist citent leurs champs', () => {
    const e = explainGraph(caseGraph('demande-conge'), META);
    expect(e.steps[0]?.text).toContain("l'agent saisit les informations demandées (date debut, date fin, motif)");
    expect(e.steps.find((s) => s.key === 'mise_a_jour_solde')?.text).toContain('liste de contrôle (solde mis a jour)');
  });

  it('un cycle sans issue n’entraîne ni boucle infinie ni oubli', () => {
    const graph = {
      schemaVersion: 1,
      start: 'a',
      steps: [
        { key: 'a', name: 'A', type: 'formulaire', next: [{ to: 'b' }] },
        { key: 'b', name: 'B', type: 'formulaire', next: [{ to: 'a' }] },
        { key: 'orpheline', name: 'Orpheline', type: 'formulaire', next: [] },
      ],
    } as unknown as WfGraph; // volontairement non valide : l'explication ne doit pas planter
    const e = explainGraph(graph, META);
    expect(e.steps.map((s) => s.key)).toEqual(['a', 'b', 'orpheline']);
    expect(e.steps[1]?.text).toContain('retour à « A » (boucle de correction)');
  });

  it('cible inexistante et départ inconnu tolérés', () => {
    const graph = {
      schemaVersion: 1,
      start: 'zzz',
      steps: [{ key: 'a', name: 'A', type: 'formulaire', next: [{ to: 'fantome' }] }],
    } as unknown as WfGraph;
    const e = explainGraph(graph, META);
    expect(e.steps).toHaveLength(1);
    expect(e.summary).toContain('Ce workflow démarre par « A »');
  });

  it('chaîne de 200 étapes : bornée et rapide', () => {
    const steps = Array.from({ length: 200 }, (_v, i) => ({
      key: `s${i}`,
      name: `Étape ${i}`,
      type: 'formulaire',
      next: i < 199 ? [{ to: `s${i + 1}` }] : [],
    }));
    const started = Date.now();
    const e = explainGraph({ schemaVersion: 1, start: 's0', steps } as unknown as WfGraph, META);
    expect(e.steps).toHaveLength(200);
    expect(Date.now() - started).toBeLessThan(2000);
    const tooMany = explainGraph(
      { schemaVersion: 1, start: 's0', steps: [...steps, ...steps.map((s) => ({ ...s, key: `x${s.key}`, next: [] }))] } as unknown as WfGraph,
      META,
    );
    expect(tooMany.steps.length).toBeLessThanOrEqual(EXPLAIN_MAX_STEPS);
  });
});

describe('explainGraph — niveaux d’autonomie des agents', () => {
  const withAutonomy = (autonomy: string): WfGraph =>
    ({
      schemaVersion: 1,
      start: 'a',
      steps: [
        {
          key: 'a',
          name: 'Agent',
          type: 'agent',
          agent: { objective: 'Résumer le courrier.', tools: [], confidenceThreshold: 0.8, autonomy },
          next: [],
        },
      ],
    }) as unknown as WfGraph;

  it('suggère', () => {
    const t = explainGraph(withAutonomy('suggere'), META).steps[0]?.text ?? '';
    expect(t).toContain('il ne fait que SUGGÉRER, un humain valide.');
    expect(t).toContain('sans outil');
    expect(t).toContain('« Résumer le courrier »');
  });

  it('agit avec validation', () => {
    expect(explainGraph(withAutonomy('agit_avec_validation'), META).steps[0]?.text).toContain(
      "il prépare l'action, mais un humain la valide avant son application.",
    );
  });

  it('autonome', () => {
    expect(explainGraph(withAutonomy('autonome'), META).steps[0]?.text).toContain('il agit seul');
  });
});

describe('explainGraph — délais et escalade', () => {
  const graph = {
    schemaVersion: 1,
    start: 'a',
    steps: [
      {
        key: 'a',
        name: 'Valider',
        type: 'validation',
        dueInHours: 36,
        reminderAfterHours: 24,
        config: { escalation: { assignee: { kind: 'role', id: 3 }, dueInHours: 48 } },
        next: [],
      },
      { key: 'b', name: 'Autre', type: 'validation', dueInHours: 1, config: { escalation: { assignee: { kind: 'role', id: 3 } } }, next: [] },
    ],
  } as unknown as WfGraph;

  it('délai, rappel, escalade', () => {
    const t = explainGraph(graph, META).steps[0]?.text ?? '';
    expect(t).toContain('Délai prévu : 36 heures.');
    expect(t).toContain('Un rappel est envoyé après 1 jour (24 heures).');
    expect(t).toContain('escaladée vers un autre responsable avec un nouveau délai de 2 jours (48 heures).');
  });

  it('une heure au singulier, escalade sans délai', () => {
    const e = explainGraph({ ...graph, start: 'b' }, META);
    const t = e.steps.find((s) => s.key === 'b')?.text ?? '';
    expect(t).toContain('Délai prévu : 1 heure.');
    expect(t).toContain('la tâche est escaladée vers un autre responsable.');
  });
});

describe('explainGraph — éléments à compléter', () => {
  const graph = graphOf({
    schemaVersion: 1,
    start: 'v',
    steps: [
      {
        key: 'v',
        name: 'Validation du DAF',
        type: 'validation',
        config: { authoring: { toComplete: ['assignee'], assigneeHint: 'DAF' } },
        next: [{ to: 'c' }],
      },
      {
        key: 'c',
        name: 'Contrôle',
        type: 'checklist',
        config: { authoring: { toComplete: [{ what: 'assignee', hint: 'Chef de service' }] } },
        next: [{ to: 'f' }],
      },
      {
        key: 'f',
        name: 'Fin',
        type: 'formulaire',
        config: { authoring: { toComplete: ['assignee'] } },
        next: [],
      },
      // Étape sans marqueur : ignorée.
    ],
  });

  const e = explainGraph(graph, META);

  it('liste les éléments avec leur libellé, jamais un identifiant', () => {
    expect(e.toComplete).toEqual([
      { stepKey: 'v', stepName: 'Validation du DAF', what: 'assignee', hint: 'DAF' },
      { stepKey: 'c', stepName: 'Contrôle', what: 'assignee', hint: 'Chef de service' },
      { stepKey: 'f', stepName: 'Fin', what: 'assignee', hint: null },
    ]);
  });

  it('ajoute une phrase d’alerte et la désignation dans les étapes', () => {
    expect(e.summary).toContain('Attention : 3 éléments restent à compléter avant la publication');
    expect(e.summary).toContain('affectation de « Validation du DAF » (« DAF »)');
    expect(e.steps[0]?.text).toContain('par « DAF » (à désigner)');
  });

  it('un seul élément : accord au singulier ; aucun élément : pas d’alerte', () => {
    const one = explainGraph(
      graphOf({
        schemaVersion: 1,
        start: 'v',
        steps: [{ key: 'v', name: 'V', type: 'validation', config: { authoring: { toComplete: ['assignee'], assigneeHint: 'RH' } }, next: [] }],
      }),
      META,
    );
    expect(one.summary).toContain('Attention : 1 élément reste à compléter');
    const none = explainGraph(caseGraph('demande-conge'), META);
    expect(none.toComplete).toEqual([]);
    expect(none.summary).not.toContain('Attention');
  });

  it('marqueur sans éléments reconnus : ignoré', () => {
    const g = graphOf({
      schemaVersion: 1,
      start: 'v',
      steps: [{ key: 'v', name: 'V', type: 'validation', config: { authoring: { toComplete: ['autre'] } }, next: [] }],
    });
    expect(explainGraph(g, META).toComplete).toEqual([]);
  });
});

describe('explainGraph — texte brut', () => {
  it('aucune balise : chevrons remplacés, caractères de contrôle retirés', () => {
    const graph = graphOf({
      schemaVersion: 1,
      start: 'a',
      steps: [
        {
          key: 'a',
          name: '<script>alert(1)</script>Étape\u0000',
          type: 'agent',
          agent: { objective: 'Lire <b>le</b> document', tools: ['lire_document'], confidenceThreshold: 0.8 },
          next: [],
        },
      ],
    });
    const e = explainGraph(graph, { ...META, name: '<b>Titre</b>' });
    const all = [e.summary, ...e.steps.map((s) => s.text)].join('\n');
    expect(all).not.toMatch(/[<>]/);
    expect(all).not.toContain('\u0000');
    expect(all).toContain('‹script›');
  });

  it('graphe vide', () => {
    const e = explainGraph({ schemaVersion: 1, start: 'a', steps: [] } as unknown as WfGraph, META);
    expect(e.steps).toEqual([]);
    expect(e.summary).toContain('aucune étape');
  });

  it('chacun des 8 cas d’évaluation s’explique sans doublon ni oubli', () => {
    for (const c of AUTHORING_EVAL_CASES) {
      const g = graphOf(c.modelOutput.graph);
      const e = explainGraph(g, { definitionId: 1, versionNumber: 1, name: c.modelOutput.name });
      expect(e.steps.map((s) => s.key).sort()).toEqual(g.steps.map((s) => s.key).sort());
      expect(e.summary).toContain('Ce workflow démarre par');
    }
  });
});

describe('describeCondition', () => {
  it.each([
    [{ field: 'steps.extraction.montant', op: 'gt', value: 5000000 }, 'le montant est supérieur à 5 000 000'],
    [{ field: 'steps.demande.values.montant', op: 'lte', value: 1000 }, 'le montant est inférieur ou égal à 1 000'],
        [{ field: 'input.priorite', op: 'eq', value: 'haute' }, 'la priorite vaut « haute »'],
    [{ field: 'input.statut', op: 'in', value: ['a', 'b'] }, 'le statut fait partie de « a », « b »'],
        [{ field: 'input.piece_jointe', op: 'exists' }, 'la piece jointe est renseignée'],
    [{ field: 'input.duree', op: 'gt', value: 3 }, 'la duree est supérieure à 3'],
    [{ field: 'last.approved', op: 'eq', value: false }, 'la validation est refusée'],
    [{ field: 'last.approved', op: 'neq', value: true }, 'la validation est refusée'],
    [{ field: 'last.rejected', op: 'eq', value: true }, 'la validation est refusée'],
    [{ field: 'last.choice', op: 'neq', value: 'X' }, "le choix n'est pas « X »"],
    [{ field: 'input.urgent', op: 'eq', value: true }, "l'urgent vaut oui"],
    [{ field: 'input.taux', op: 'gte', value: 2.5 }, 'le taux est supérieur ou égal à 2,5'],
  ])('%j', (condition, expected) => {
    expect(describeCondition(condition as Parameters<typeof describeCondition>[0])).toBe(expected);
  });
});
