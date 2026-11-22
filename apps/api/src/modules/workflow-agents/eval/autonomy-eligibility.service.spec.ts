import { evalCasesHash } from '../../workflows/agent-spec-hash';
import type { LoadedAgentConfig } from '../agent-config.loader';
import { AutonomyEligibilityService } from './autonomy-eligibility.service';

const CONFIG = {
  definitionId: 5,
  definitionVersionId: 50,
  stepKey: 'tri',
  evalSetId: 7,
  specHash: 'hash-courant',
} as LoadedAgentConfig;

interface Scenario {
  version?: { definitionId: number; definition: { isLowRisk: boolean } } | null;
  config?: LoadedAgentConfig | null;
  set?: { definitionId: number; isActive: boolean; minAccuracy: string } | null;
  runs?: Array<{ requiredAccuracy: string; results: unknown }>;
  cases?: Array<{ wfEvalCaseId: number; input: unknown; expected: unknown }>;
}

const goodRun = { requiredAccuracy: '0.900', results: { agentSpecHash: 'hash-courant', casesHash: evalCasesHash([]), stepKey: 'tri' } };

function build(s: Scenario = {}) {
  const prisma = {
    wfDefinitionVersion: {
      findUnique: jest.fn(() =>
        Promise.resolve(s.version === undefined ? { definitionId: 5, definition: { isLowRisk: true } } : s.version),
      ),
    },
    wfEvalSet: {
      findUnique: jest.fn(() =>
        Promise.resolve(s.set === undefined ? { definitionId: 5, isActive: true, minAccuracy: '0.900' } : s.set),
      ),
    },
    wfEvalRun: { findMany: jest.fn(() => Promise.resolve(s.runs ?? [goodRun])) },
    wfEvalCase: { findMany: jest.fn(() => Promise.resolve(s.cases ?? [])) },
  };
  const loader = { load: jest.fn(() => Promise.resolve(s.config === undefined ? CONFIG : s.config)) };
  const service = new AutonomyEligibilityService(prisma as never, loader as never);
  return { service, prisma, loader };
}

describe('AutonomyEligibilityService.check', () => {
  it('éligible : faible risque, jeu lié, actif, run réussi de cette version, seuil et empreinte à jour', async () => {
    const { service, prisma } = build();
    await expect(service.check(50, 'tri')).resolves.toEqual({ eligible: true });
    // Seul un run terminé (1), réussi, non vide, de CETTE version et de CE jeu est cherché.
    expect(prisma.wfEvalRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { evalSetId: 7, definitionVersionId: 50, status: 1, passed: true, totalCases: { gt: 0 } },
      }),
    );
  });

  it('cas du jeu modifiés, ajoutés ou supprimés depuis le run réussi : plus éligible (empreinte du jeu de cas)', async () => {
    const base = { wfEvalCaseId: 1, input: { untrusted: [] }, expected: { returnsToHuman: false } };
    const atRun = { requiredAccuracy: '0.900', results: { agentSpecHash: 'hash-courant', casesHash: evalCasesHash([base]), stepKey: 'tri' } };
    // Inchangé : éligible.
    await expect(build({ runs: [atRun], cases: [base] }).service.check(50, 'tri')).resolves.toEqual({ eligible: true });
    // Cas modifié (attendu différent), ajouté, supprimé (désactivé) : refus.
    const modified = [{ ...base, expected: { returnsToHuman: true } }];
    const added = [base, { wfEvalCaseId: 2, input: {}, expected: { returnsToHuman: true } }];
    for (const cases of [modified, added, []]) {
      const res = await build({ runs: [atRun], cases }).service.check(50, 'tri');
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('cas du jeu');
    }
    // Un run ancien sans empreinte de cas n'est jamais accepté.
    const legacy = { requiredAccuracy: '0.900', results: { agentSpecHash: 'hash-courant', stepKey: 'tri' } };
    expect((await build({ runs: [legacy], cases: [base] }).service.check(50, 'tri')).eligible).toBe(false);
  });

  it("run sans étape enregistrée dans ses résultats : refus (échec fermé, jamais toléré)", async () => {
    const noStep = { requiredAccuracy: '0.900', results: { agentSpecHash: 'hash-courant', casesHash: evalCasesHash([]) } };
    expect((await build({ runs: [noStep] }).service.check(50, 'tri')).eligible).toBe(false);
  });

  it('relu en base à chaque appel (aucun cache)', async () => {
    const { service, prisma } = build();
    await service.check(50, 'tri');
    await service.check(50, 'tri');
    expect(prisma.wfEvalRun.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.wfDefinitionVersion.findUnique).toHaveBeenCalledTimes(2);
  });

  const refusals: Array<[string, Scenario, RegExp]> = [
    ['version introuvable', { version: null }, /Version introuvable/],
    ['workflow non marqué faible risque', { version: { definitionId: 5, definition: { isLowRisk: false } } }, /faible risque/],
    ['étape agent introuvable', { config: null }, /introuvable/],
    ['aucun jeu lié', { config: { ...CONFIG, evalSetId: null } }, /Aucun jeu/],
    ['jeu introuvable', { set: null }, /Jeu d’évaluation introuvable/],
    ['jeu d’un autre workflow', { set: { definitionId: 9, isActive: true, minAccuracy: '0.900' } }, /n’appartient pas/],
    ['jeu désactivé', { set: { definitionId: 5, isActive: false, minAccuracy: '0.900' } }, /désactivé/],
    ['seuil du jeu sous le plancher', { set: { definitionId: 5, isActive: true, minAccuracy: '0.700' } }, /plancher/],
    ['aucun run réussi', { runs: [] }, /Aucun run/],
    [
      'run validé avec un seuil inférieur au seuil actuel du jeu',
      { set: { definitionId: 5, isActive: true, minAccuracy: '0.950' }, runs: [goodRun] },
      /seuil inférieur/,
    ],
    [
      'run validé sous le plancher (seuil historique 0,5)',
      { set: { definitionId: 5, isActive: true, minAccuracy: '0.800' }, runs: [{ ...goodRun, requiredAccuracy: '0.500' }] },
      /seuil inférieur/,
    ],
    [
      'empreinte périmée (la configuration a changé depuis le run)',
      { runs: [{ requiredAccuracy: '0.900', results: { agentSpecHash: 'ancienne', casesHash: evalCasesHash([]), stepKey: 'tri' } }] },
      /a changé/,
    ],
    ['run sans empreinte', { runs: [{ requiredAccuracy: '0.900', results: { cases: [] } }] }, /a changé/],
    ['run sans résultat', { runs: [{ requiredAccuracy: '0.900', results: null }] }, /a changé/],
    [
      'run d’une autre étape',
      { runs: [{ requiredAccuracy: '0.900', results: { agentSpecHash: 'hash-courant', casesHash: evalCasesHash([]), stepKey: 'autre' } }] },
      /a changé/,
    ],
  ];

  it.each(refusals)('refuse : %s', async (_name, scenario, reason) => {
    const { service } = build(scenario);
    const res = await service.check(50, 'tri');
    expect(res.eligible).toBe(false);
    expect(res.reason).toMatch(reason);
  });

  it('plusieurs runs : suffit qu’un seul soit réussi, à jour et au bon seuil', async () => {
    const { service } = build({
      runs: [
        { requiredAccuracy: '0.900', results: { agentSpecHash: 'ancienne', casesHash: evalCasesHash([]), stepKey: 'tri' } },
        { requiredAccuracy: '0.800', results: { agentSpecHash: 'hash-courant', casesHash: evalCasesHash([]), stepKey: 'tri' } },
        goodRun,
      ],
    });
    await expect(service.check(50, 'tri')).resolves.toEqual({ eligible: true });
  });

  it('seuil du jeu à 0,8 et run à 0,8 : éligible (borne incluse)', async () => {
    const { service } = build({
      set: { definitionId: 5, isActive: true, minAccuracy: '0.800' },
      runs: [{ requiredAccuracy: '0.800', results: { agentSpecHash: 'hash-courant', casesHash: evalCasesHash([]), stepKey: 'tri' } }],
    });
    await expect(service.check(50, 'tri')).resolves.toEqual({ eligible: true });
  });

  describe('échec fermé : toute erreur de lecture => non éligible', () => {
    it('erreur sur la version', async () => {
      const { service, prisma } = build();
      prisma.wfDefinitionVersion.findUnique.mockRejectedValueOnce(new Error('base indisponible'));
      const res = await service.check(50, 'tri');
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('illisible');
      expect(res.reason).not.toContain('indisponible');
    });

    it('erreur du chargeur de configuration', async () => {
      const { service, loader } = build();
      loader.load.mockRejectedValueOnce(new Error('boom'));
      await expect(service.check(50, 'tri')).resolves.toMatchObject({ eligible: false });
    });

    it('erreur sur le jeu ou sur les runs', async () => {
      const a = build();
      a.prisma.wfEvalSet.findUnique.mockRejectedValueOnce(new Error('boom'));
      await expect(a.service.check(50, 'tri')).resolves.toMatchObject({ eligible: false });
      const b = build();
      b.prisma.wfEvalRun.findMany.mockRejectedValueOnce(new Error('boom'));
      await expect(b.service.check(50, 'tri')).resolves.toMatchObject({ eligible: false });
    });

    it('données illisibles (précision non numérique) : jamais éligible', async () => {
      const { service } = build({ runs: [{ requiredAccuracy: 'abc', results: { agentSpecHash: 'hash-courant', casesHash: evalCasesHash([]), stepKey: 'tri' } }] });
      await expect(service.check(50, 'tri')).resolves.toMatchObject({ eligible: false });
    });
  });
});
