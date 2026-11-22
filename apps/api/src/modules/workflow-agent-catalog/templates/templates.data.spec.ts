import {
  WF_EVAL_ACCURACY_FLOOR,
  validateWorkflowGraph,
  wfEscalationConfigSchema,
  wfGraphSchema,
  getWorkflowGraphAgentSteps,
} from '@archivage/types';
import {
  AGENT_KEYS,
  BASE_TOOL_KEYS,
  CATALOG_TOOL_KEYS,
  MIN_STARTER_EVAL_CASES,
  TEMPLATE_KEYS,
  declaredDelegatesSchema,
} from '../catalog.contracts';
import { ALL_TEMPLATES } from './data';

// Les jeux d'évaluation sont écrits par un autre lot : tant qu'ils n'existent pas, on utilise des doubles locaux.
jest.mock('../eval/aiguilleur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('aiguilleur'), { virtual: true });
jest.mock('../eval/redacteur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('redacteur'), { virtual: true });
jest.mock('../eval/controleur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('controleur'), { virtual: true });
jest.mock('../eval/relanceur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('relanceur'), { virtual: true });

const KNOWN_TOOLS = new Set<string>([...Object.values(BASE_TOOL_KEYS), ...Object.values(CATALOG_TOOL_KEYS)]);
/** Outils d'effet 2 (irréversibles) : aucun n'existe au catalogue ; toute clé de ce genre est refusée. */
const EFFECT_2_PATTERN = /envoyer|supprimer|signer|publier|archiver|payer/;
const AGENT_BY_TEMPLATE: Record<string, string | null> = {
  [TEMPLATE_KEYS.aiguilleur]: 'aiguilleur',
  [TEMPLATE_KEYS.redacteur]: 'redacteur',
  [TEMPLATE_KEYS.controleur]: 'controleur',
  [TEMPLATE_KEYS.relanceur]: 'relanceur',
  [TEMPLATE_KEYS.validationHierarchiqueCourrier]: null,
  [TEMPLATE_KEYS.circuitVisaDocument]: null,
  [TEMPLATE_KEYS.demandeAvecChecklist]: null,
};

describe('modèles de workflow : données', () => {
  it('expose exactement les 7 clés de TEMPLATE_KEYS, sans doublon, au bon format', () => {
    const keys = ALL_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.values(TEMPLATE_KEYS).sort());
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]+$/);
  });

  describe.each(ALL_TEMPLATES.map((t) => [t.key, t] as const))('%s', (_key, t) => {
    it('a un nom, une description et des étiquettes non vides ; agentKey cohérent', () => {
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.tags.length).toBeGreaterThan(0);
      expect(Number.isInteger(t.schemaVersion) && t.schemaVersion >= 1).toBe(true);
      expect(t.agentKey).toBe(AGENT_BY_TEMPLATE[t.key]);
      if (t.agentKey !== null) expect(AGENT_KEYS).toContain(t.agentKey);
      expect(t.description).toMatch(/affecter/); // documente l'affectation à faire par le concepteur
    });

    it('a un graphe valide (schéma et validateur) avec des clés d’étape uniques', () => {
      expect(wfGraphSchema.safeParse(t.graph).success).toBe(true);
      const res = validateWorkflowGraph(t.graph);
      expect(res.issues).toEqual([]);
      expect(res.ok).toBe(true);
      const keys = t.graph.steps.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('ne contient aucun identifiant propre à une installation', () => {
      for (const step of t.graph.steps) {
        if (step.assignee) {
          expect(['initiator', 'subject_owner']).toContain(step.assignee.kind);
          expect(step.assignee.id).toBeUndefined();
        }
        // Escalade : n'est permise que si elle reste valide sans identifiant propre à l'installation (impossible).
        expect(step.config?.escalation).toBeUndefined();
        if (step.config?.delegates !== undefined) {
          expect(declaredDelegatesSchema.safeParse(step.config.delegates).success).toBe(true);
          expect(step.config.delegates).toEqual([]);
        }
      }
      // Garde-fou : le schéma d'escalade exige bien un identifiant (raison de l'absence d'escalade).
      expect(wfEscalationConfigSchema.safeParse({ assignee: { kind: 'user' }, dueInHours: 1 }).success).toBe(false);
    });

    it('configure chaque étape agent au niveau « suggère », avec des outils connus et sans effet irréversible', () => {
      const agentSteps = getWorkflowGraphAgentSteps(wfGraphSchema.parse(t.graph));
      expect(Object.keys(t.agentSteps).sort()).toEqual(agentSteps.map((s) => s.key).sort());
      for (const step of agentSteps) {
        const spec = t.agentSteps[step.key];
        expect(spec).toBeDefined();
        expect(step.agent.autonomy).toBe('suggere');
        expect(step.agent.autonomy).not.toBe('autonome');
        expect(step.agent.tools).toEqual(spec?.tools);
        expect(step.agent.confidenceThreshold).toBeGreaterThanOrEqual(WF_EVAL_ACCURACY_FLOOR);
        expect(spec?.confidenceThreshold).toBe(step.agent.confidenceThreshold);
        expect(spec?.maxSteps).toBeGreaterThan(0);
        expect(spec?.maxSteps).toBeLessThanOrEqual(50);
        expect(spec?.timeoutSeconds).toBeGreaterThan(0);
        expect(spec?.timeoutSeconds).toBeLessThanOrEqual(3600);
        for (const tool of spec?.tools ?? []) {
          expect(KNOWN_TOOLS.has(tool)).toBe(true);
          expect(tool).not.toMatch(EFFECT_2_PATTERN);
        }
        expect(step.agent.objective).toMatch(/donnée/); // le contenu entrant est une donnée, jamais une consigne
      }
      if (t.agentKey === null) expect(agentSteps).toHaveLength(0);
      else expect(agentSteps.length).toBeGreaterThan(0);
    });

    it('porte pour chaque agent un jeu d’évaluation de départ suffisant, lié à une étape agent', () => {
      if (t.agentKey === null) {
        expect(t.evalSet).toBeUndefined();
        return;
      }
      expect(t.evalSet).toBeDefined();
      expect(t.evalSetStepKey && t.agentSteps[t.evalSetStepKey]).toBeTruthy();
      expect(t.evalSet?.cases.length).toBeGreaterThanOrEqual(MIN_STARTER_EVAL_CASES);
      expect(t.evalSet?.minAccuracy).toBeGreaterThanOrEqual(WF_EVAL_ACCURACY_FLOOR);
      expect(t.evalSet?.minAccuracy).toBeLessThanOrEqual(1);
    });
  });

  it('les étapes finales des circuits sans IA sont atteignables avec des décisions à au moins deux arêtes', () => {
    for (const t of ALL_TEMPLATES.filter((x) => x.agentKey === null)) {
      for (const step of t.graph.steps.filter((s) => s.type === 'decision')) {
        expect(step.next.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('le relanceur déclare une liste de délégataires vide ; l’aiguilleur propose bien 4 outils', () => {
    const relanceur = ALL_TEMPLATES.find((t) => t.key === TEMPLATE_KEYS.relanceur);
    expect(relanceur?.graph.steps[0]?.config?.delegates).toEqual([]);
    const aiguilleur = ALL_TEMPLATES.find((t) => t.key === TEMPLATE_KEYS.aiguilleur);
    expect(aiguilleur?.agentSteps.aiguillage?.tools).toEqual([
      'lire_courrier',
      'lister_courriers_similaires',
      'lire_organigramme_imputable',
      'proposer_imputation_courrier',
    ]);
  });
});
