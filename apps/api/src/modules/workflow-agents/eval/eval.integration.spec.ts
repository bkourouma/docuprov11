import { PrismaClient } from '@prisma/client';
import type { AuthUser } from '../../auth/auth.types';
import type { AgentIdentity, AgentRunInput, AgentRunOutput } from '../agent.contracts';
import { AgentConfigLoader } from '../agent-config.loader';
import { AutonomyEligibilityService } from './autonomy-eligibility.service';
import { EvalService } from './eval.service';

// Test d'intégration de l'évaluation des agents sur une VRAIE base PostgreSQL JETABLE : un run créé PAR LE
// SERVICE doit passer les CHECK de `wf_eval_run` et le déclencheur d'autonomie de `wf_agent_config`
// (faible risque + run réussi de CETTE version pour CE jeu), et le SQL doit refuser le reste (run terminé
// figé, précision incohérente, autonomie sans run). Ne s'exécute que si WF_TEST_DATABASE_URL est définie ; la
// base doit contenir la migration 20261121120000_add_workflow_foundations. JAMAIS la base de développement :
// le test refuse de tourner si l'URL est celle de DATABASE_URL.
//
// Aucune donnée n'est supprimée (un run terminé est figé par le SQL, les clés étrangères sont RESTRICT) :
// chaque test crée ses propres définitions, au nom unique.

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'Évaluation des agents — intégration PostgreSQL'
  : 'Évaluation des agents — intégration PostgreSQL (IGNORÉ : définir WF_TEST_DATABASE_URL vers une base jetable pour l’exécuter)';

const ACTOR: AuthUser = { userId: 1, username: 'concepteur', isAdmin: false, userGroupId: 1, fullName: 'Concepteur' };
const IDENTITY: AgentIdentity = {
  principal: { userGroupId: 1, userId: 1, groupIds: [], roleId: null },
  user: { userId: 1, username: 'concepteur', isAdmin: false, userGroupId: 1 },
};

const graphOf = (objective: string): object => ({
  schemaVersion: 1,
  start: 'tri',
  steps: [
    {
      key: 'tri',
      name: 'Tri du courrier',
      type: 'agent',
      agent: { objective, tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' },
      next: [{ to: 'fin' }],
    },
    { key: 'fin', name: 'Fin', type: 'checklist', config: { items: [{ key: 'ok' }] }, next: [] },
  ],
});

function output(over: Partial<AgentRunOutput> = {}): AgentRunOutput {
  return {
    outcome: 'final',
    result: { classe: 'facture' },
    explanation: 'ok',
    confidence: 0.95,
    sources: [],
    preparedActions: [],
    suspicionInjection: false,
    suspicionReasons: [],
    audit: {
      instruction: 'x',
      model: 'modele-test',
      aiDecisionIds: [],
      promptTokens: 1,
      completionTokens: 1,
      costAmount: 0.002,
      steps: 1,
      toolCalls: [],
    },
    ...over,
  };
}

const passingCase = { label: 'Facture', input: {}, expected: { result: { classe: 'facture' } } } as const;
const failingCase = { label: 'Devis', input: {}, expected: { result: { classe: 'devis' } } } as const;

suite(title, () => {
  jest.setTimeout(120_000);

  let prisma: PrismaClient;
  let service: EvalService;
  let eligibility: AutonomyEligibilityService;
  let seq = 0;
  /** Réponse du faux runner (le test la change avant de lancer un run). */
  let respond: (input: AgentRunInput) => AgentRunOutput = () => output();

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const loader = new AgentConfigLoader(prisma as never);
    const runner = { run: (input: AgentRunInput) => Promise.resolve(respond(input)) };
    const identity = { resolve: () => Promise.resolve(IDENTITY) };
    const audit = { dataChange: () => Promise.resolve() };
    eligibility = new AutonomyEligibilityService(prisma as never, loader);
    service = new EvalService(prisma as never, runner, identity, loader, audit as never, eligibility);
  });

  afterAll(async () => {
    await service?.whenIdle();
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    respond = () => output();
  });

  /** Workflow marqué faible risque + version BROUILLON (la configuration agent ne se crée qu'avant publication). */
  async function workflow(objective = 'Classer le courrier', lowRisk = true) {
    seq += 1;
    const def = await prisma.wfDefinition.create({
      data: { name: `eval-test-${Date.now()}-${seq}`, status: 0, isLowRisk: lowRisk, ...(lowRisk ? { lowRiskMarkedAt: new Date() } : {}) },
    });
    const version = await prisma.wfDefinitionVersion.create({
      data: { definitionId: def.wfDefinitionId, versionNumber: 1, status: 0, graph: graphOf(objective) },
    });
    return { definitionId: def.wfDefinitionId, versionId: version.wfDefinitionVersionId };
  }

  /** Jeu + cas, run lancé PAR LE SERVICE et attendu jusqu'à sa fin. */
  async function setWithRun(definitionId: number, cases: Array<typeof passingCase | typeof failingCase>) {
    const set = await service.createSet({ definitionId, stepKey: 'tri', name: 'Jeu de test', minAccuracy: 0.8 }, ACTOR);
    for (const c of cases) await service.addCase(set.wfEvalSetId, { ...c, input: { ...c.input } }, ACTOR);
    const created = await service.runSet(set.wfEvalSetId, {}, ACTOR);
    await service.whenIdle();
    const row = await prisma.wfEvalRun.findUniqueOrThrow({ where: { wfEvalRunId: BigInt(created.wfEvalRunId) } });
    return { set, created, row };
  }

  const autonomousConfig = (versionId: number, evalSetId: number) =>
    prisma.wfAgentConfig.create({
      data: { definitionVersionId: versionId, stepKey: 'tri', objective: 'Classer le courrier', autonomyLevel: 2, evalSetId },
    });

  it('un run créé par le service passe les CHECK : lignes cohérentes (statut 1, total, passés, précision, seuil figé)', async () => {
    const { definitionId, versionId } = await workflow();
    const { created, row } = await setWithRun(definitionId, [passingCase, passingCase, passingCase, passingCase, failingCase]);
    expect(created.status).toBe(0);
    expect(row).toMatchObject({ status: 1, totalCases: 5, passedCases: 4, passed: true, definitionVersionId: versionId, runBy: 1 });
    expect(Number(row.accuracy)).toBeCloseTo(0.8, 3);
    expect(Number(row.requiredAccuracy)).toBeCloseTo(0.8, 3);
    expect(row.finishedAt).not.toBeNull();
    expect(row.results).toMatchObject({ agentSpecHash: expect.any(String), stepKey: 'tri' });
  });

  it('run sous le seuil : terminé mais passed = false, l’autonomie reste refusée par le SQL', async () => {
    const { definitionId, versionId } = await workflow();
    const { set, row } = await setWithRun(definitionId, [passingCase, failingCase, failingCase]);
    expect(row).toMatchObject({ status: 1, totalCases: 3, passedCases: 1, passed: false });
    await expect(autonomousConfig(versionId, set.wfEvalSetId)).rejects.toThrow(/aucun run d.évaluation réussi/);
  });

  it('autonomie 2 : acceptée avec un run réussi de CETTE version pour CE jeu (faible risque)', async () => {
    const { definitionId, versionId } = await workflow();
    const { set, row } = await setWithRun(definitionId, [passingCase, passingCase]);
    expect(row.passed).toBe(true);
    const config = await autonomousConfig(versionId, set.wfEvalSetId);
    expect(config).toMatchObject({ autonomyLevel: 2, evalSetId: set.wfEvalSetId, definitionVersionId: versionId });
  });

  it('autonomie 2 : refusée sans aucun run (jeu lié, mais jamais exécuté)', async () => {
    const { definitionId, versionId } = await workflow();
    const set = await service.createSet({ definitionId, stepKey: 'tri', name: 'Jamais lancé', minAccuracy: 0.8 }, ACTOR);
    await service.addCase(set.wfEvalSetId, { ...passingCase, input: {} }, ACTOR);
    await expect(autonomousConfig(versionId, set.wfEvalSetId)).rejects.toThrow(/aucun run d.évaluation réussi/);
  });

  it('autonomie 2 : refusée si le workflow n’est pas marqué faible risque, même avec un run réussi', async () => {
    const { definitionId, versionId } = await workflow('Classer le courrier', false);
    const { set, row } = await setWithRun(definitionId, [passingCase]);
    expect(row.passed).toBe(true);
    await expect(autonomousConfig(versionId, set.wfEvalSetId)).rejects.toThrow(/faible risque/);
  });

  it('autonomie 2 : un run réussi d’une AUTRE version ne couvre pas la version configurée', async () => {
    const { definitionId } = await workflow();
    const other = await prisma.wfDefinitionVersion.create({
      data: { definitionId, versionNumber: 2, status: 0, graph: graphOf('Classer le courrier') },
    });
    const set = await service.createSet({ definitionId, stepKey: 'tri', name: 'Jeu v1', minAccuracy: 0.8 }, ACTOR);
    await service.addCase(set.wfEvalSetId, { ...passingCase, input: {} }, ACTOR);
    // Run sur la version 1 (explicite) : la version 2 n'est pas couverte.
    const v1 = await prisma.wfDefinitionVersion.findFirstOrThrow({ where: { definitionId, versionNumber: 1 } });
    await service.runSet(set.wfEvalSetId, { definitionVersionId: v1.wfDefinitionVersionId }, ACTOR);
    await service.whenIdle();
    await expect(autonomousConfig(other.wfDefinitionVersionId, set.wfEvalSetId)).rejects.toThrow(/aucun run d.évaluation réussi/);
  });

  it('seuil relevé après le run : le SQL refuse l’autonomie (required_accuracy < min_accuracy du jeu)', async () => {
    const { definitionId, versionId } = await workflow();
    const { set, row } = await setWithRun(definitionId, [passingCase]);
    expect(row.passed).toBe(true);
    await service.updateSet(set.wfEvalSetId, { minAccuracy: 0.95 }, ACTOR);
    await expect(autonomousConfig(versionId, set.wfEvalSetId)).rejects.toThrow(/aucun run d.évaluation réussi/);
  });

  it('éligibilité applicative : éligible après un run réussi, plus éligible dès que le comportement de l’agent change', async () => {
    const { definitionId, versionId } = await workflow('Classer le courrier');
    const { set } = await setWithRun(definitionId, [passingCase, passingCase]);
    // Configuration d'étape liée au jeu (niveau 0 : la liaison seule ne demande pas l'autonomie).
    await prisma.wfAgentConfig.create({
      data: { definitionVersionId: versionId, stepKey: 'tri', objective: 'Classer le courrier', autonomyLevel: 0, evalSetId: set.wfEvalSetId },
    });
    await expect(eligibility.check(versionId, 'tri')).resolves.toEqual({ eligible: true });

    // L'objectif change sur le brouillon : l'empreinte ne correspond plus à celle du run.
    await prisma.wfDefinitionVersion.update({
      where: { wfDefinitionVersionId: versionId },
      data: { graph: graphOf('Classer le courrier ET extraire les montants') },
    });
    const res = await eligibility.check(versionId, 'tri');
    expect(res.eligible).toBe(false);
    expect(res.reason).toMatch(/a changé/);
  });

  it('éligibilité applicative : un workflow non marqué faible risque n’est jamais éligible', async () => {
    const { definitionId, versionId } = await workflow('Classer le courrier', false);
    const { set } = await setWithRun(definitionId, [passingCase]);
    await prisma.wfAgentConfig.create({
      data: { definitionVersionId: versionId, stepKey: 'tri', objective: 'Classer le courrier', autonomyLevel: 0, evalSetId: set.wfEvalSetId },
    });
    await expect(eligibility.check(versionId, 'tri')).resolves.toMatchObject({ eligible: false });
  });

  it('GET eval-status : étape éligible après un run réussi, non éligible avec raison après changement de comportement', async () => {
    const { definitionId, versionId } = await workflow('Classer le courrier');
    const { set } = await setWithRun(definitionId, [passingCase, passingCase]);
    await prisma.wfAgentConfig.create({
      data: { definitionVersionId: versionId, stepKey: 'tri', objective: 'Classer le courrier', autonomyLevel: 0, evalSetId: set.wfEvalSetId },
    });
    await expect(service.getEligibilityStatus(definitionId)).resolves.toEqual({
      definitionId,
      definitionVersionId: versionId,
      versionNumber: 1,
      steps: [{ stepKey: 'tri', evalSetId: set.wfEvalSetId, eligible: true, reason: null }],
    });

    await prisma.wfDefinitionVersion.update({
      where: { wfDefinitionVersionId: versionId },
      data: { graph: graphOf('Classer le courrier ET extraire les montants') },
    });
    const after = await service.getEligibilityStatus(definitionId);
    expect(after.steps[0]).toMatchObject({ stepKey: 'tri', eligible: false });
    expect(after.steps[0]!.reason).toMatch(/a changé/);

    await expect(service.getEligibilityStatus(2_000_000_000)).rejects.toThrow('Workflow introuvable.');
  });

  it('un run terminé n’est plus modifiable ni supprimable (déclencheur), et le service ne le réécrit pas', async () => {
    const { definitionId } = await workflow();
    const { created, row } = await setWithRun(definitionId, [passingCase]);
    const id = BigInt(created.wfEvalRunId);
    await expect(prisma.wfEvalRun.update({ where: { wfEvalRunId: id }, data: { passed: false } })).rejects.toThrow(
      /run d.évaluation terminé/,
    );
    await expect(prisma.wfEvalRun.update({ where: { wfEvalRunId: id }, data: { passedCases: 0 } })).rejects.toThrow(
      /run d.évaluation terminé/,
    );
    await expect(prisma.wfEvalRun.delete({ where: { wfEvalRunId: id } })).rejects.toThrow(/run d.évaluation terminé/);
    // UPDATE conditionnel (WHERE status = 0) : aucune ligne touchée, aucune erreur.
    const res = await prisma.wfEvalRun.updateMany({ where: { wfEvalRunId: id, status: 0 }, data: { passed: false } });
    expect(res.count).toBe(0);
    const after = await prisma.wfEvalRun.findUniqueOrThrow({ where: { wfEvalRunId: id } });
    expect(after.passed).toBe(row.passed);
    expect(after.passedCases).toBe(row.passedCases);
  });

  it('précision incohérente refusée par le SQL (accuracy sans rapport avec passed/total, passed sous le seuil, total nul)', async () => {
    const { definitionId, versionId } = await workflow();
    const set = await service.createSet({ definitionId, stepKey: 'tri', name: 'Contrôle SQL', minAccuracy: 0.8 }, ACTOR);
    const base = {
      evalSetId: set.wfEvalSetId,
      definitionVersionId: versionId,
      status: 1,
      finishedAt: new Date(),
      requiredAccuracy: '0.800',
    };
    // 5/10 déclarés à 0,9 : incohérent.
    await expect(
      prisma.wfEvalRun.create({ data: { ...base, totalCases: 10, passedCases: 5, accuracy: '0.900', passed: false } }),
    ).rejects.toThrow(/ck_wf_eval_run_accuracy_consistent|check constraint/i);
    // « réussi » avec une précision sous le seuil figé.
    await expect(
      prisma.wfEvalRun.create({ data: { ...base, totalCases: 10, passedCases: 5, accuracy: '0.500', passed: true } }),
    ).rejects.toThrow(/ck_wf_eval_run_passed|check constraint/i);
    // Terminé sans aucun cas.
    await expect(
      prisma.wfEvalRun.create({ data: { ...base, totalCases: 0, passedCases: 0, accuracy: '1.000', passed: false } }),
    ).rejects.toThrow(/ck_wf_eval_run_accuracy_consistent|check constraint/i);
    // Plus de cas réussis que de cas.
    await expect(
      prisma.wfEvalRun.create({ data: { ...base, totalCases: 2, passedCases: 3, accuracy: '1.000', passed: false } }),
    ).rejects.toThrow(/ck_wf_eval_run_counts|check constraint/i);
    // Contrôle positif : la même ligne, cohérente, est acceptée.
    await expect(
      prisma.wfEvalRun.create({ data: { ...base, totalCases: 10, passedCases: 9, accuracy: '0.900', passed: true } }),
    ).resolves.toMatchObject({ status: 1, passed: true });
  });

  it('arrêt budgétaire : le run passe en statut 2 (terminé en erreur, jamais réussi) et respecte le CHECK de fin', async () => {
    const { definitionId, versionId } = await workflow();
    respond = () => output({ outcome: 'stopped', stopReason: 'budget_exceeded_workflow', result: null, confidence: null });
    const { set, row } = await setWithRun(definitionId, [passingCase, passingCase]);
    expect(row).toMatchObject({ status: 2, passed: false, accuracy: null });
    expect(row.errorMessage).toMatch(/run interrompu/);
    expect(row.finishedAt).not.toBeNull();
    await expect(autonomousConfig(versionId, set.wfEvalSetId)).rejects.toThrow(/aucun run d.évaluation réussi/);
  });

  it('run en cours depuis plus d’une heure : failStaleRuns le passe en statut 2 (et jamais un run récent)', async () => {
    const { definitionId, versionId } = await workflow();
    const set = await service.createSet({ definitionId, stepKey: 'tri', name: 'Périmé', minAccuracy: 0.8 }, ACTOR);
    const stale = await prisma.wfEvalRun.create({
      data: {
        evalSetId: set.wfEvalSetId,
        definitionVersionId: versionId,
        status: 0,
        totalCases: 1,
        requiredAccuracy: '0.800',
        startedAt: new Date(Date.now() - 2 * 3_600_000),
      },
    });
    const fresh = await prisma.wfEvalRun.create({
      data: { evalSetId: set.wfEvalSetId, definitionVersionId: versionId, status: 0, totalCases: 1, requiredAccuracy: '0.800' },
    });
    expect(await service.failStaleRuns()).toBeGreaterThanOrEqual(1);
    const a = await prisma.wfEvalRun.findUniqueOrThrow({ where: { wfEvalRunId: stale.wfEvalRunId } });
    const b = await prisma.wfEvalRun.findUniqueOrThrow({ where: { wfEvalRunId: fresh.wfEvalRunId } });
    expect(a).toMatchObject({ status: 2, passed: false });
    expect(a.finishedAt).not.toBeNull();
    expect(b.status).toBe(0);
  });

  it('une version d’un autre workflow est refusée (422), aucune ligne de run créée', async () => {
    const one = await workflow();
    const two = await workflow();
    const set = await service.createSet({ definitionId: one.definitionId, stepKey: 'tri', name: 'Jeu', minAccuracy: 0.8 }, ACTOR);
    await service.addCase(set.wfEvalSetId, { ...passingCase, input: {} }, ACTOR);
    await expect(service.runSet(set.wfEvalSetId, { definitionVersionId: two.versionId }, ACTOR)).rejects.toThrow(
      /ne change pas de workflow/,
    );
    expect(await prisma.wfEvalRun.count({ where: { evalSetId: set.wfEvalSetId } })).toBe(0);
  });

  it('plafond de 500 cas actifs et suppression = désactivation (ligne conservée)', async () => {
    const { definitionId } = await workflow();
    const set = await service.createSet({ definitionId, name: 'Gros jeu', minAccuracy: 0.8 }, ACTOR);
    await prisma.wfEvalCase.createMany({
      data: Array.from({ length: 500 }, (_v, i) => ({
        evalSetId: set.wfEvalSetId,
        label: `Cas ${i}`,
        input: {},
        expected: { returnsToHuman: true },
        sortOrder: i,
      })),
    });
    await expect(service.addCase(set.wfEvalSetId, { ...passingCase, input: {} }, ACTOR)).rejects.toThrow(/plus de 500 cas actifs/);
    const first = await prisma.wfEvalCase.findFirstOrThrow({ where: { evalSetId: set.wfEvalSetId }, orderBy: { wfEvalCaseId: 'asc' } });
    await service.removeCase(set.wfEvalSetId, first.wfEvalCaseId, ACTOR);
    expect(await prisma.wfEvalCase.count({ where: { evalSetId: set.wfEvalSetId } })).toBe(500);
    expect(await prisma.wfEvalCase.count({ where: { evalSetId: set.wfEvalSetId, isActive: true } })).toBe(499);
    await expect(service.addCase(set.wfEvalSetId, { ...passingCase, input: {} }, ACTOR)).resolves.toBeDefined();
  });
});
