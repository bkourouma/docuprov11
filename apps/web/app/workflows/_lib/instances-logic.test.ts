// Tests de la logique pure des écrans d'instances.
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/instances-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WF_EVENT_TYPES, type WfInboxItemDto, type WfTaskDto } from '@archivage/types';
import { computeWorkflowAccess, instanceActionRights } from './access';
import {
  EVENT_FAMILIES,
  KNOWN_EVENT_TYPES,
  actorLabel,
  assigneeLabel,
  definitionName,
  deriveSteps,
  describeEvent,
  filterEvents,
  orderEvents,
  parseLaunchContext,
  readDecisionSummary,
  subjectText,
  validateLaunchForm,
} from './instances-logic';

const ENGINE_TYPES = [
  'instance.started', 'instance.completed', 'instance.failed', 'instance.cancelled', 'instance.suspended', 'instance.resumed',
  'task.created', 'task.assigned', 'task.claimed', 'task.completed', 'task.rejected', 'task.delegated', 'task.failed',
  'task.cancelled', 'task.expired', 'task.escalated',
  'validation.accepted', 'validation.rejected', 'validation.modified', 'validation.requested',
  'agent.proposed', 'agent.acted', 'agent.escalated', 'executor.error',
  'timer.scheduled', 'timer.fired', 'timer.cancelled', 'timer.failed',
  'budget.threshold_reached', 'budget.exceeded', 'emergency_stop.activated', 'emergency_stop.released',
];

const ev = (eventType: string, actorKind = 0, actorUserGroupId: number | null = null) => ({
  eventType,
  actorKind: actorKind as 0 | 1 | 2,
  actorUserGroupId,
});

// --- Acteurs ---------------------------------------------------------------

test('actorLabel : système, utilisateur, agent, inconnu', () => {
  assert.equal(actorLabel(0, null), 'Système');
  assert.equal(actorLabel(1, 12), 'Utilisateur n° 12');
  assert.equal(actorLabel(1, null), 'Utilisateur');
  assert.equal(actorLabel(2, null), 'Agent');
  assert.equal(actorLabel(9, null), 'Acteur inconnu');
});

// --- describeEvent ---------------------------------------------------------

for (const type of [...new Set([...WF_EVENT_TYPES, ...ENGINE_TYPES])]) {
  test(`describeEvent couvre « ${type} » avec une phrase française non vide`, () => {
    const d = describeEvent(ev(type, 1, 7));
    assert.ok(KNOWN_EVENT_TYPES.includes(type), 'type absent du catalogue');
    assert.notEqual(d.family, 'autre');
    assert.ok(d.what.length > 8);
    assert.match(d.what, /^(a|ont) /, 'phrase à la forme « a … »');
    assert.equal(d.who, 'Utilisateur n° 7');
  });
}

test('describeEvent : type inconnu => repli lisible, famille « autre »', () => {
  const d = describeEvent(ev('custom.thing_happened', 2));
  assert.equal(d.family, 'autre');
  assert.equal(d.tone, 'agent');
  assert.match(d.what, /custom thing happened/);
  assert.equal(describeEvent(ev('')).what, 'a enregistré un événement');
});

test('describeEvent : teintes d’échec et de succès', () => {
  assert.equal(describeEvent(ev('instance.failed')).tone, 'error');
  assert.equal(describeEvent(ev('instance.completed')).tone, 'success');
  assert.equal(describeEvent(ev('agent.proposed', 2)).tone, 'agent');
});

// --- Familles --------------------------------------------------------------

test('filterEvents : par famille, « Tout » garde les inconnus', () => {
  const list = [ev('instance.started'), ev('task.created'), ev('agent.proposed', 2), ev('timer.fired'), ev('budget.exceeded'), ev('validation.accepted', 1, 3), ev('zzz.inconnu')];
  assert.equal(filterEvents(list, 'all').length, 7);
  assert.deepEqual(filterEvents(list, 'instance').map((e) => e.eventType), ['instance.started']);
  assert.deepEqual(filterEvents(list, 'tasks').map((e) => e.eventType), ['task.created']);
  assert.deepEqual(filterEvents(list, 'agents').map((e) => e.eventType), ['agent.proposed']);
  assert.deepEqual(filterEvents(list, 'timers').map((e) => e.eventType), ['timer.fired']);
  assert.deepEqual(filterEvents(list, 'budget').map((e) => e.eventType), ['budget.exceeded']);
  assert.deepEqual(filterEvents(list, 'validations').map((e) => e.eventType), ['validation.accepted']);
  assert.deepEqual(EVENT_FAMILIES.map((f) => f.key), ['all', 'instance', 'tasks', 'validations', 'agents', 'timers', 'budget']);
});

test('orderEvents : plus ancien d’abord, inversion, ex æquo par identifiant numérique', () => {
  const e = (id: string, at: string) => ({ wfEventLogId: id, occurredAt: at });
  const list = [e('10', '2026-01-01T10:00:00Z'), e('9', '2026-01-01T10:00:00Z'), e('1', '2026-01-01T09:00:00Z')];
  assert.deepEqual(orderEvents(list, false).map((x) => x.wfEventLogId), ['1', '9', '10']);
  assert.deepEqual(orderEvents(list, true).map((x) => x.wfEventLogId), ['10', '9', '1']);
  assert.equal(list[0]?.wfEventLogId, '10', 'l’entrée n’est pas mutée');
});

// --- decision --------------------------------------------------------------

test('readDecisionSummary : clés connues en texte', () => {
  const lines = readDecisionSummary({
    chosen: 'archiver',
    edgeLabel: 'Accepté',
    matchedCondition: { field: 'last.approved', op: 'eq', value: true },
    source: 'regle',
    escalation: true,
    secret: 'ne doit pas apparaître',
  });
  assert.deepEqual(lines, [
    'Étape choisie : archiver',
    'Branche suivie : Accepté',
    'Condition satisfaite : last.approved est égal à oui',
    'Source : regle',
    'Escalade déclenchée',
  ]);
  assert.ok(!lines.join(' ').includes('secret'));
});

test('readDecisionSummary : robuste aux valeurs étranges', () => {
  for (const v of [null, undefined, 42, 'texte', [], [1, 2], true, () => 1, Symbol('x')]) {
    assert.deepEqual(readDecisionSummary(v), []);
  }
  assert.deepEqual(readDecisionSummary({ chosen: { a: 1 }, edgeLabel: [], matchedCondition: {}, source: null }), []);
  assert.deepEqual(readDecisionSummary({ escalation: false }), []);
  assert.deepEqual(readDecisionSummary({ matchedCondition: 'montant > 10' }), ['Condition satisfaite : montant > 10']);
  const long = readDecisionSummary({ chosen: 'x'.repeat(1000) })[0];
  assert.ok((long ?? "").length < 400);
});

// --- Étapes ----------------------------------------------------------------

const task = (over: Partial<WfTaskDto>): WfTaskDto => ({
  wfTaskId: '1', instanceId: 'i', stepKey: 'a', taskType: 0, status: 2, title: 't', instructions: null, priority: 1,
  assigneeUserGroupId: null, assigneeGroupId: null, assigneeRoleId: null, dueAt: null, attempt: 1, input: null, result: null,
  startedAt: null, completedAt: null, completedBy: null, createdAt: '2026-01-01T08:00:00Z', updatedAt: '2026-01-01T08:00:00Z', ...over,
});

test('deriveSteps : ordre par création, boucle (passages), étape en cours', () => {
  const tasks = [
    task({ wfTaskId: '30', stepKey: 'valider', attempt: 2, status: 1, createdAt: '2026-01-01T12:00:00Z' }),
    task({ wfTaskId: '10', stepKey: 'saisir', createdAt: '2026-01-01T08:00:00Z' }),
    task({ wfTaskId: '20', stepKey: 'valider', attempt: 1, createdAt: '2026-01-01T10:00:00Z' }),
  ];
  const steps = deriveSteps(tasks, []);
  assert.deepEqual(steps.map((s) => s.task.wfTaskId), ['10', '20', '30']);
  assert.deepEqual(steps.map((s) => s.current), [false, false, true]);
  assert.equal(steps[2]?.task.attempt, 2);
});

test('deriveSteps : validation d’agent en attente signalée sur l’étape ouverte seulement', () => {
  const inbox = [
    { taskId: '5', kind: 1, status: 0 },
    { taskId: '6', kind: 1, status: 2 },
    { taskId: '7', kind: 0, status: 0 },
  ] as Pick<WfInboxItemDto, 'taskId' | 'kind' | 'status'>[];
  const steps = deriveSteps(
    [task({ wfTaskId: '5', status: 0 }), task({ wfTaskId: '6', status: 0, createdAt: '2026-01-02T00:00:00Z' }), task({ wfTaskId: '7', status: 1, createdAt: '2026-01-03T00:00:00Z' })],
    inbox,
  );
  assert.deepEqual(steps.map((s) => s.awaitingAgentValidation), [true, false, false]);
});

test('assigneeLabel', () => {
  const base = { assigneeUserGroupId: null, assigneeGroupId: null, assigneeRoleId: null };
  assert.equal(assigneeLabel({ ...base, assigneeUserGroupId: 3 }), 'Utilisateur n° 3');
  assert.equal(assigneeLabel({ ...base, assigneeGroupId: 2 }), 'Groupe n° 2');
  assert.equal(assigneeLabel({ ...base, assigneeRoleId: 5 }), 'Rôle n° 5');
  assert.equal(assigneeLabel(base), 'Non assignée');
});

// --- Lancement -------------------------------------------------------------

test('parseLaunchContext : vide, objet valide', () => {
  assert.deepEqual(parseLaunchContext('   '), { ok: true, value: undefined });
  assert.deepEqual(parseLaunchContext('{"a":1}'), { ok: true, value: { a: 1 } });
});

test('parseLaunchContext : tableau, chaîne, nombre, null refusés', () => {
  for (const t of ['[1]', '"x"', '3', 'null']) {
    const r = parseLaunchContext(t);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /objet JSON/);
  }
});

test('parseLaunchContext : JSON invalide et trop gros (octets UTF-8)', () => {
  const bad = parseLaunchContext('{a:');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /Syntaxe JSON invalide/);
  const big = parseLaunchContext(JSON.stringify({ x: 'a'.repeat(262_144) }));
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.error, /256 Kio/);
  // 'é' = 2 octets : 131 073 caractères dépassent la limite alors que le nombre de caractères est inférieur.
  const utf = parseLaunchContext(`{"x":"${'é'.repeat(131_073)}"}`);
  assert.equal(utf.ok, false);
});

const okForm = { contextText: '', subjectType: undefined, subjectId: undefined, idempotencyKey: 'manuel-abc' };

test('validateLaunchForm : formulaire minimal valide', () => {
  const v = validateLaunchForm(okForm);
  assert.equal(v.valid, true);
  assert.deepEqual(v.payload, { idempotencyKey: 'manuel-abc' });
});

test('validateLaunchForm : type et identifiant vont ensemble', () => {
  assert.match(validateLaunchForm({ ...okForm, subjectType: 'document' }).errors.subject ?? '', /type ET l’identifiant/);
  assert.match(validateLaunchForm({ ...okForm, subjectId: '12' }).errors.subject ?? '', /type ET l’identifiant/);
  assert.match(validateLaunchForm({ ...okForm, subjectType: 'Document!', subjectId: '12' }).errors.subject ?? '', /invalide/);
  assert.match(validateLaunchForm({ ...okForm, subjectType: 'document', subjectId: 'abc' }).errors.subject ?? '', /nombre entier/);
  const ok = validateLaunchForm({ ...okForm, contextText: '{"a":1}', subjectType: 'document', subjectId: ' 12 ' });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.payload, { context: { a: 1 }, subjectType: 'document', subjectId: '12', idempotencyKey: 'manuel-abc' });
});

test('validateLaunchForm : clé vide ou trop longue, JSON invalide', () => {
  assert.match(validateLaunchForm({ ...okForm, idempotencyKey: '  ' }).errors.idempotencyKey ?? '', /obligatoire/);
  assert.match(validateLaunchForm({ ...okForm, idempotencyKey: 'k'.repeat(201) }).errors.idempotencyKey ?? '', /trop longue/);
  assert.equal(validateLaunchForm({ ...okForm, idempotencyKey: 'k'.repeat(200) }).valid, true);
  const v = validateLaunchForm({ ...okForm, contextText: '[]' });
  assert.equal(v.valid, false);
  assert.ok(v.errors.context);
  assert.equal(v.payload, undefined);
});

// --- Divers ----------------------------------------------------------------

test('subjectText et definitionName', () => {
  assert.equal(subjectText('document', '12'), 'Document n° 12');
  assert.equal(subjectText('x_y', '1'), 'x_y n° 1');
  assert.equal(subjectText(null, null), null);
  assert.equal(definitionName(new Map([[3, 'Facture']]), 3), 'Facture');
  assert.equal(definitionName(new Map(), 9), 'Workflow n° 9');
});

test('instanceActionRights côté écran : lanceur, administrateur, état terminal', () => {
  const launcher = computeWorkflowAccess({ menuKeys: ['/workflows/lancer'], userGroupId: 5 });
  const admin = computeWorkflowAccess({ menuKeys: ['/workflows/administration'], userGroupId: 9 });
  assert.deepEqual(instanceActionRights(launcher, { startedBy: 5, status: 1 }), { cancel: true, suspend: true, resume: false });
  assert.deepEqual(instanceActionRights(launcher, { startedBy: 6, status: 1 }), { cancel: false, suspend: false, resume: false });
  assert.deepEqual(instanceActionRights(admin, { startedBy: 5, status: 5 }), { cancel: true, suspend: false, resume: true });
  assert.deepEqual(instanceActionRights(admin, { startedBy: 5, status: 2 }), { cancel: false, suspend: false, resume: false });
});
