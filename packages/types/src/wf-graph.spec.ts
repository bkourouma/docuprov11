import { WF_GRAPH_MAX_STEPS, getWorkflowGraphAgentSteps, listWorkflowGraphStepKeys, validateWorkflowGraph } from './wf-graph';
import type { WfGraphIssueCode } from './wf-graph';

type StepIn = Record<string, unknown>;

const step = (key: string, type: string, next: StepIn[] = [], extra: StepIn = {}): StepIn => ({
  key,
  name: `Étape ${key}`,
  type,
  next,
  ...extra,
});
const graph = (start: string, steps: StepIn[]): unknown => ({ schemaVersion: 1, start, steps });
const codes = (input: unknown, options?: { isLowRisk?: boolean }): WfGraphIssueCode[] =>
  validateWorkflowGraph(input, options).issues.map((i) => i.code);

const agentSpec = (autonomy = 'suggere'): StepIn => ({
  objective: 'Classer le courrier',
  tools: ['mail.read', 'document.classify'],
  autonomy,
});

/** agent -> validation -> décision -> (fin | correction vers agent) */
const validGraph = (): unknown =>
  graph('analyse', [
    step('analyse', 'agent', [{ to: 'relecture' }], { agent: agentSpec() }),
    step('relecture', 'validation', [{ to: 'choix' }], { assignee: { kind: 'role', id: 3 }, dueInHours: 48 }),
    step('choix', 'decision', [
      { to: 'analyse', label: 'Corriger', condition: { field: 'approved', op: 'eq', value: false } },
      { to: 'fin', label: 'Accepter', isDefault: true },
    ]),
    step('fin', 'checklist'),
  ]);

describe('validateWorkflowGraph', () => {
  it('accepte un graphe valide avec cycle de correction et applique les défauts', () => {
    const r = validateWorkflowGraph(validGraph());
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    const agent = r.graph?.steps[0]?.agent;
    expect(agent?.confidenceThreshold).toBe(0.8);
    expect(agent?.autonomy).toBe('suggere');
    expect(listWorkflowGraphStepKeys(r.graph!)).toEqual(['analyse', 'relecture', 'choix', 'fin']);
    expect(getWorkflowGraphAgentSteps(r.graph!).map((s) => s.key)).toEqual(['analyse']);
  });

  it('SCHEMA_INVALID : forme erronée, une issue par erreur', () => {
    const r = validateWorkflowGraph({ schemaVersion: 1, start: 'a', steps: [{ key: 'A!', name: '', type: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(3);
    expect(r.issues.every((i) => i.code === 'SCHEMA_INVALID')).toBe(true);
  });

  it('SCHEMA_INVALID : schemaVersion 2 refusé', () => {
    expect(codes({ ...(validGraph() as object), schemaVersion: 2 })).toEqual(['SCHEMA_INVALID']);
  });

  it('SCHEMA_INVALID : affectation sans id, outil en doublon, clé d\'outil invalide', () => {
    const base = (extra: StepIn) => graph('a', [step('a', extra.type as string, [], extra)]);
    expect(codes(base({ type: 'validation', assignee: { kind: 'user' } }))).toEqual(['SCHEMA_INVALID']);
    expect(codes(base({ type: 'validation', assignee: { kind: 'initiator', id: 4 } }))).toEqual(['SCHEMA_INVALID']);
    expect(codes(base({ type: 'agent', agent: { objective: 'x', tools: ['a', 'a'] } }))).toEqual(['SCHEMA_INVALID']);
    expect(codes(base({ type: 'agent', agent: { objective: 'x', tools: ['Mauvaise Clé'] } }))).toEqual(['SCHEMA_INVALID']);
  });

  it('200 étapes en chaîne : valide et rapide', () => {
    const steps: StepIn[] = [];
    for (let i = 0; i < WF_GRAPH_MAX_STEPS; i++) {
      steps.push(step(`s${i}`, 'formulaire', i < WF_GRAPH_MAX_STEPS - 1 ? [{ to: `s${i + 1}` }] : []));
    }
    const t0 = Date.now();
    const r = validateWorkflowGraph(graph('s0', steps));
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('201 étapes : SCHEMA_INVALID', () => {
    const steps: StepIn[] = [];
    for (let i = 0; i < WF_GRAPH_MAX_STEPS + 1; i++) steps.push(step(`s${i}`, 'formulaire'));
    expect(codes(graph('s0', steps))).toContain('SCHEMA_INVALID');
  });

  it('DUPLICATE_STEP_KEY', () => {
    expect(codes(graph('a', [step('a', 'formulaire'), step('a', 'formulaire')]))).toContain('DUPLICATE_STEP_KEY');
  });

  it('START_NOT_FOUND', () => {
    expect(codes(graph('absent', [step('a', 'formulaire')]))).toContain('START_NOT_FOUND');
  });

  it('EDGE_TARGET_NOT_FOUND', () => {
    expect(codes(graph('a', [step('a', 'formulaire', [{ to: 'zzz' }])]))).toContain('EDGE_TARGET_NOT_FOUND');
  });

  it('SELF_LOOP', () => {
    const c = codes(graph('a', [step('a', 'formulaire', [{ to: 'a' }, { to: 'b', condition: { field: 'x', op: 'exists' } }]), step('b', 'formulaire')]));
    expect(c).toContain('SELF_LOOP');
  });

  it('UNREACHABLE_STEP', () => {
    expect(codes(graph('a', [step('a', 'formulaire'), step('orpheline', 'formulaire')]))).toEqual(['UNREACHABLE_STEP']);
  });

  it('NO_TERMINAL_STEP', () => {
    const c = codes(graph('a', [step('a', 'formulaire', [{ to: 'b' }]), step('b', 'formulaire', [{ to: 'a' }])]));
    expect(c).toEqual(['NO_TERMINAL_STEP']);
  });

  it('STEP_CANNOT_REACH_TERMINAL', () => {
    const r = validateWorkflowGraph(
      graph('a', [
        step('a', 'formulaire', [{ to: 'fin', condition: { field: 'x', op: 'eq', value: 1 } }, { to: 'b' }]),
        step('b', 'formulaire', [{ to: 'c' }]),
        step('c', 'formulaire', [{ to: 'b' }]),
        step('fin', 'formulaire'),
      ]),
    );
    expect(r.issues.map((i) => [i.code, i.stepKey])).toEqual([
      ['STEP_CANNOT_REACH_TERMINAL', 'b'],
      ['STEP_CANNOT_REACH_TERMINAL', 'c'],
    ]);
  });

  it('AMBIGUOUS_BRANCHING : deux arêtes de repli', () => {
    const c = codes(graph('a', [step('a', 'formulaire', [{ to: 'b' }, { to: 'c', isDefault: true }]), step('b', 'formulaire'), step('c', 'formulaire')]));
    expect(c).toEqual(['AMBIGUOUS_BRANCHING']);
  });

  it('AMBIGUOUS_BRANCHING : une condition + un repli est valide', () => {
    const c = codes(graph('a', [step('a', 'formulaire', [{ to: 'b', condition: { field: 'x', op: 'gt', value: 2 } }, { to: 'c' }]), step('b', 'formulaire'), step('c', 'formulaire')]));
    expect(c).toEqual([]);
  });

  it('AGENT_SPEC_MISSING', () => {
    expect(codes(graph('a', [step('a', 'agent')]))).toEqual(['AGENT_SPEC_MISSING']);
  });

  it('AGENT_SPEC_ON_NON_AGENT', () => {
    expect(codes(graph('a', [step('a', 'formulaire', [], { agent: agentSpec() })]))).toEqual(['AGENT_SPEC_ON_NON_AGENT']);
  });

  it('DUPLICATE_EDGE_TARGET', () => {
    const c = codes(
      graph('a', [
        step('a', 'formulaire', [{ to: 'b', condition: { field: 'x', op: 'eq', value: 1 } }, { to: 'b' }]),
        step('b', 'formulaire'),
      ]),
    );
    expect(c).toEqual(['DUPLICATE_EDGE_TARGET']);
  });

  it('AUTONOMY_REQUIRES_LOW_RISK', () => {
    const g = graph('a', [step('a', 'agent', [], { agent: agentSpec('autonome') })]);
    expect(codes(g)).toEqual(['AUTONOMY_REQUIRES_LOW_RISK']);
    expect(codes(g, { isLowRisk: false })).toEqual(['AUTONOMY_REQUIRES_LOW_RISK']);
    expect(codes(g, { isLowRisk: true })).toEqual([]);
  });

  it('DECISION_NEEDS_BRANCHES', () => {
    const c = codes(graph('a', [step('a', 'decision', [{ to: 'b' }]), step('b', 'formulaire')]));
    expect(c).toEqual(['DECISION_NEEDS_BRANCHES']);
  });
});
