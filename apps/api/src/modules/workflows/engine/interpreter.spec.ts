import { WfTaskPriority, WfTaskType, type WfStep } from '@archivage/types';
import type { WfPrincipal } from './engine.types';
import {
  WF_DEFAULT_MAX_ATTEMPTS,
  WF_LOG_DECISION_MAX_BYTES,
  WF_RESULT_MAX_BYTES,
  applyStepResult,
  boundJson,
  buildRejectionResult,
  buildTaskSpec,
  chooseNextEdge,
  conditionValuesEqual,
  evaluateCondition,
  initialContext,
  isAttemptAllowed,
  isAutomaticDecision,
  isHumanStep,
  isTaskAssignee,
  normalizeAssignee,
  normalizeContext,
  readPath,
  resolveAssignee,
  resolveMaxAttempts,
  resolvePriority,
  summarizeResultForLog,
  toComparableNumber,
  validateTaskResult,
  type WfInstanceContext,
} from './interpreter';

function step(partial: Partial<WfStep> & { key?: string; type?: WfStep['type'] } = {}): WfStep {
  return { key: 'etape', name: 'Étape', type: 'formulaire', next: [], ...partial } as WfStep;
}

const ctx = (over: Partial<WfInstanceContext> = {}): WfInstanceContext => ({ ...initialContext({}), ...over });

describe('readPath', () => {
  const data = { a: { b: { c: 3 }, list: [{ x: 'un' }, { x: 'deux' }] }, nul: null, zero: 0 };

  it('lit un chemin pointé, un index de tableau et les valeurs « fausses »', () => {
    expect(readPath(data, 'a.b.c')).toBe(3);
    expect(readPath(data, 'a.list.1.x')).toBe('deux');
    expect(readPath(data, 'nul')).toBeNull();
    expect(readPath(data, 'zero')).toBe(0);
  });

  it('renvoie undefined pour un chemin absent, vide ou mal formé', () => {
    expect(readPath(data, 'a.z')).toBeUndefined();
    expect(readPath(data, 'a.b.c.d')).toBeUndefined();
    expect(readPath(data, '')).toBeUndefined();
    expect(readPath(data, 'a..b')).toBeUndefined();
    expect(readPath(data, 'a.list.x')).toBeUndefined();
    expect(readPath(data, 'a.list.9')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
    expect(readPath('texte', 'length')).toBeUndefined();
  });

  it("ne remonte jamais au prototype (pas d'accès à __proto__ / constructor / toString)", () => {
    expect(readPath({}, '__proto__')).toBeUndefined();
    expect(readPath({}, 'constructor')).toBeUndefined();
    expect(readPath({}, 'toString')).toBeUndefined();
    expect(readPath({ a: {} }, 'a.hasOwnProperty')).toBeUndefined();
  });
});

describe('comparaisons', () => {
  it('toComparableNumber : nombres finis et chaînes numériques seulement', () => {
    expect(toComparableNumber(12)).toBe(12);
    expect(toComparableNumber(' 3.5 ')).toBe(3.5);
    expect(toComparableNumber('-2e3')).toBe(-2000);
    expect(toComparableNumber('12abc')).toBeUndefined();
    expect(toComparableNumber('')).toBeUndefined();
    expect(toComparableNumber(true)).toBeUndefined();
    expect(toComparableNumber(null)).toBeUndefined();
    expect(toComparableNumber(Number.NaN)).toBeUndefined();
    expect(toComparableNumber(Infinity)).toBeUndefined();
  });

  it('égalité stricte sauf nombres (chaîne numérique = nombre)', () => {
    expect(conditionValuesEqual(10, '10')).toBe(true);
    expect(conditionValuesEqual('10', 10)).toBe(true);
    expect(conditionValuesEqual('10', '10.0')).toBe(false); // deux chaînes : strict
    expect(conditionValuesEqual(true, 'true')).toBe(false);
    expect(conditionValuesEqual(1, true)).toBe(false);
    expect(conditionValuesEqual(0, null)).toBe(false);
    expect(conditionValuesEqual(null, null)).toBe(true);
    expect(conditionValuesEqual({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(conditionValuesEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('evaluateCondition', () => {
  const context = {
    input: { priorite: 'haute', montant: '1500', tags: ['a', 'b'] },
    steps: { controle: { values: { montant: 1200, ok: false } } },
    last: { approved: true, score: 7, nul: null },
  };

  it.each([
    ['eq', 'last.approved', true, true],
    ['eq', 'last.approved', false, false],
    ['eq', 'input.priorite', 'haute', true],
    ['eq', 'input.montant', 1500, true],
    ['neq', 'input.priorite', 'basse', true],
    ['neq', 'last.approved', true, false],
    ['gt', 'steps.controle.values.montant', 1000, true],
    ['gt', 'steps.controle.values.montant', 1200, false],
    ['gte', 'steps.controle.values.montant', 1200, true],
    ['lt', 'last.score', '10', true],
    ['lte', 'last.score', 7, true],
    ['lte', 'last.score', 6.99, false],
    ['in', 'input.priorite', ['haute', 'urgente'], true],
    ['in', 'last.score', ['7'], true],
    ['in', 'input.priorite', ['basse'], false],
    ['eq', 'input.tags', ['a', 'b'], true],
  ])('%s %s %j => %s', (op, field, value, expected) => {
    expect(evaluateCondition({ op, field, value }, context)).toBe(expected);
  });

  it('exists : vrai si défini et non nul, la valeur est ignorée', () => {
    expect(evaluateCondition({ op: 'exists', field: 'last.score', value: false }, context)).toBe(true);
    expect(evaluateCondition({ op: 'exists', field: 'last.nul' }, context)).toBe(false);
    expect(evaluateCondition({ op: 'exists', field: 'last.absent' }, context)).toBe(false);
    expect(evaluateCondition({ op: 'exists', field: 'steps.controle.values.ok' }, context)).toBe(true);
  });

  it('chemin absent : faux pour TOUS les opérateurs, y compris neq', () => {
    for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']) {
      expect(evaluateCondition({ op, field: 'last.inconnu', value: op === 'in' ? [1] : 1 }, context)).toBe(false);
    }
  });

  it('types mixtes : comparaison numérique refusée sur un non-nombre, in sans tableau, opérateur inconnu', () => {
    expect(evaluateCondition({ op: 'gt', field: 'input.priorite', value: 1 }, context)).toBe(false);
    expect(evaluateCondition({ op: 'gt', field: 'last.approved', value: 0 }, context)).toBe(false);
    expect(evaluateCondition({ op: 'lt', field: 'last.score', value: 'abc' }, context)).toBe(false);
    expect(evaluateCondition({ op: 'in', field: 'input.priorite', value: 'haute' }, context)).toBe(false);
    expect(evaluateCondition({ op: 'regex', field: 'input.priorite', value: '.*' }, context)).toBe(false);
    expect(evaluateCondition({ op: 'eq', field: 'last.approved', value: 'true' }, context)).toBe(false);
    expect(evaluateCondition({ op: 'eq', field: 'last.nul', value: null }, context)).toBe(true);
    expect(evaluateCondition({ op: 'neq', field: 'last.nul', value: 'x' }, context)).toBe(true);
  });
});

describe('chooseNextEdge', () => {
  const approve = { field: 'last.approved', op: 'eq' as const, value: true };
  const refuse = { field: 'last.approved', op: 'eq' as const, value: false };

  it('zéro arête : étape finale (mode normal)', () => {
    expect(chooseNextEdge(step(), ctx())).toEqual({ kind: 'terminal' });
  });

  it('une seule arête sans condition : on la suit', () => {
    const choice = chooseNextEdge(step({ next: [{ to: 'b' }] }), ctx());
    expect(choice).toMatchObject({ kind: 'edge', index: 0, matchedCondition: false });
  });

  it('première condition vraie dans l’ordre de déclaration, même si une suivante est vraie aussi', () => {
    const s = step({
      next: [
        { to: 'b', condition: { field: 'last.score', op: 'gt', value: 100 } },
        { to: 'c', condition: { field: 'last.score', op: 'gt', value: 5 } },
        { to: 'd', condition: { field: 'last.score', op: 'gt', value: 1 } },
        { to: 'e' },
      ],
    });
    const choice = chooseNextEdge(s, ctx({ last: { score: 7 } }));
    expect(choice).toMatchObject({ kind: 'edge', index: 1, matchedCondition: true });
    if (choice.kind === 'edge') expect(choice.edge.to).toBe('c');
  });

  it('repli : arête sans condition, quelle que soit sa position', () => {
    const s = step({ next: [{ to: 'repli' }, { to: 'b', condition: approve }] });
    const choice = chooseNextEdge(s, ctx({ last: { approved: false } }));
    expect(choice).toMatchObject({ kind: 'edge', index: 0, matchedCondition: false });
  });

  it('repli : arête isDefault portant une condition fausse (le repli ignore sa condition)', () => {
    const s = step({ next: [{ to: 'b', condition: approve }, { to: 'c', condition: refuse, isDefault: true }] });
    const choice = chooseNextEdge(s, ctx({ last: { approved: true } }));
    expect(choice).toMatchObject({ kind: 'edge', index: 0, matchedCondition: true });
    const fallback = chooseNextEdge(s, ctx({ last: { approved: 'peut-être' } }));
    expect(fallback).toMatchObject({ kind: 'edge', index: 1, matchedCondition: false });
  });

  it('aucune condition vraie et pas de repli : erreur de routage explicite', () => {
    const s = step({ name: 'Contrôle', next: [{ to: 'b', condition: approve }, { to: 'c', condition: refuse }] });
    const choice = chooseNextEdge(s, ctx({ last: {} }));
    expect(choice.kind).toBe('none');
    if (choice.kind === 'none') expect(choice.reason).toContain('Erreur de routage');
  });

  it('mode rejeté : seules les arêtes conditionnées comptent, jamais le repli', () => {
    const s = step({ next: [{ to: 'correction', condition: refuse }, { to: 'suite' }] });
    const rejected = { rejected: true, approved: false };
    expect(chooseNextEdge(s, ctx({ last: rejected }), 'rejected')).toMatchObject({ kind: 'edge', index: 0 });
    const noRoute = step({ next: [{ to: 'suite' }] });
    expect(chooseNextEdge(noRoute, ctx({ last: rejected }), 'rejected').kind).toBe('none');
    const defaultEdge = step({ next: [{ to: 'x', condition: refuse, isDefault: true }] });
    expect(chooseNextEdge(defaultEdge, ctx({ last: rejected }), 'rejected').kind).toBe('none');
  });

  it("mode rejeté sur une étape finale : jamais une fin réussie", () => {
    const choice = chooseNextEdge(step(), ctx(), 'rejected');
    expect(choice.kind).toBe('none');
  });
});

describe('types d’étape et garde-fous', () => {
  it('décision automatique par défaut, manuelle si config.manual === true', () => {
    expect(isAutomaticDecision(step({ type: 'decision' }))).toBe(true);
    expect(isAutomaticDecision(step({ type: 'decision', config: { manual: 'true' } }))).toBe(true);
    expect(isAutomaticDecision(step({ type: 'decision', config: { manual: true } }))).toBe(false);
    expect(isHumanStep(step({ type: 'decision', config: { manual: true } }))).toBe(true);
    expect(isHumanStep(step({ type: 'decision' }))).toBe(false);
    expect(isHumanStep(step({ type: 'agent' }))).toBe(false);
    expect(isHumanStep(step({ type: 'validation' }))).toBe(true);
  });

  it('plafond de passages : 25 par défaut, config.maxAttempts borné à [1, 100]', () => {
    expect(resolveMaxAttempts(step())).toBe(WF_DEFAULT_MAX_ATTEMPTS);
    expect(resolveMaxAttempts(step({ config: { maxAttempts: 3 } }))).toBe(3);
    expect(resolveMaxAttempts(step({ config: { maxAttempts: 500 } }))).toBe(100);
    expect(resolveMaxAttempts(step({ config: { maxAttempts: 0 } }))).toBe(1);
    expect(resolveMaxAttempts(step({ config: { maxAttempts: 2.5 } }))).toBe(WF_DEFAULT_MAX_ATTEMPTS);
    expect(resolveMaxAttempts(step({ config: { maxAttempts: '50' } }))).toBe(WF_DEFAULT_MAX_ATTEMPTS);
    expect(isAttemptAllowed(step(), 25)).toBe(true);
    expect(isAttemptAllowed(step(), 26)).toBe(false);
    expect(isAttemptAllowed(step({ config: { maxAttempts: 2 } }), 3)).toBe(false);
    expect(isAttemptAllowed(step(), 0)).toBe(false);
  });

  it('priorité : nombre ou libellé, normale par défaut', () => {
    expect(resolvePriority(step())).toBe(WfTaskPriority.Normal);
    expect(resolvePriority(step({ config: { priority: 'haute' } }))).toBe(WfTaskPriority.High);
    expect(resolvePriority(step({ config: { priority: 0 } }))).toBe(WfTaskPriority.Low);
    expect(resolvePriority(step({ config: { priority: 9 } }))).toBe(WfTaskPriority.Normal);
  });
});

describe('affectation et construction de tâche', () => {
  const now = new Date('2026-11-21T10:00:00.000Z');

  it('step.assignee : utilisateur, groupe, rôle, lanceur', () => {
    expect(resolveAssignee({ step: step({ assignee: { kind: 'user', id: 7 } }), context: ctx(), startedBy: 1 })).toEqual({
      assignee: { userGroupId: 7, groupId: null, roleId: null },
      source: 'step_user',
    });
    expect(resolveAssignee({ step: step({ assignee: { kind: 'group', id: 3 } }), context: ctx(), startedBy: 1 }).assignee).toEqual({
      userGroupId: null,
      groupId: 3,
      roleId: null,
    });
    expect(resolveAssignee({ step: step({ assignee: { kind: 'role', id: 4 } }), context: ctx(), startedBy: 1 }).assignee).toEqual({
      userGroupId: null,
      groupId: null,
      roleId: 4,
    });
    expect(resolveAssignee({ step: step({ assignee: { kind: 'initiator' } }), context: ctx(), startedBy: 9 })).toEqual({
      assignee: { userGroupId: 9, groupId: null, roleId: null },
      source: 'initiator',
    });
  });

  it('subject_owner : propriétaire résolu, sinon repli sur le lanceur (expliqué)', () => {
    const s = step({ assignee: { kind: 'subject_owner' } });
    expect(resolveAssignee({ step: s, context: ctx(), startedBy: 1, subjectOwner: 42 })).toEqual({
      assignee: { userGroupId: 42, groupId: null, roleId: null },
      source: 'subject_owner',
    });
    expect(resolveAssignee({ step: s, context: ctx(), startedBy: 1, subjectOwner: null }).source).toBe('subject_owner_fallback');
    expect(resolveAssignee({ step: s, context: ctx(), startedBy: 1 }).assignee.userGroupId).toBe(1);
  });

  it('sans step.assignee : context.assignedTo, sinon le lanceur ; jamais vide', () => {
    expect(resolveAssignee({ step: step(), context: ctx({ assignedTo: { groupId: 5 } }), startedBy: 1 })).toEqual({
      assignee: { userGroupId: null, groupId: 5, roleId: null },
      source: 'context',
    });
    expect(resolveAssignee({ step: step(), context: ctx(), startedBy: 1 })).toEqual({
      assignee: { userGroupId: 1, groupId: null, roleId: null },
      source: 'default_initiator',
    });
    // Affectation de contexte corrompue (deux bénéficiaires) : ignorée.
    expect(
      resolveAssignee({ step: step(), context: ctx({ assignedTo: { groupId: 5, roleId: 2 } }), startedBy: 1 }).source,
    ).toBe('default_initiator');
    // step.assignee prioritaire sur le contexte.
    expect(
      resolveAssignee({ step: step({ assignee: { kind: 'role', id: 8 } }), context: ctx({ assignedTo: { groupId: 5 } }), startedBy: 1 })
        .source,
    ).toBe('step_role');
  });

  it('buildTaskSpec : type, titre (passage n), consigne, priorité, échéance et relance', () => {
    const s = step({
      key: 'controle',
      name: 'Contrôle',
      type: 'validation',
      description: '  Vérifier la pièce.  ',
      dueInHours: 48,
      reminderAfterHours: 24,
      config: { priority: 'haute' },
    });
    const spec = buildTaskSpec({ step: s, context: ctx(), startedBy: 3, attempt: 2, now });
    expect(spec).toMatchObject({
      taskType: WfTaskType.Approval,
      typeKey: 'validation',
      title: 'Contrôle (passage 2)',
      instructions: 'Vérifier la pièce.',
      priority: WfTaskPriority.High,
      assignee: { userGroupId: 3, groupId: null, roleId: null },
      isHuman: true,
    });
    expect(spec.dueAt?.toISOString()).toBe('2026-11-23T10:00:00.000Z');
    expect(spec.reminderAt?.toISOString()).toBe('2026-11-22T10:00:00.000Z');
    const plain = buildTaskSpec({ step: step(), context: ctx(), startedBy: 3, attempt: 1, now });
    expect(plain).toMatchObject({ title: 'Étape', instructions: null, dueAt: null, reminderAt: null });
  });

  it('normalizeAssignee : exactement un identifiant entier positif', () => {
    expect(normalizeAssignee({ userGroupId: 3 })).toEqual({ userGroupId: 3 });
    expect(normalizeAssignee({ userGroupId: 3, groupId: null })).toEqual({ userGroupId: 3 });
    expect(normalizeAssignee({ userGroupId: 3, groupId: 4 })).toBeNull();
    expect(normalizeAssignee({ roleId: -1 })).toBeNull();
    expect(normalizeAssignee({})).toBeNull();
    expect(normalizeAssignee('3')).toBeNull();
  });
});

describe('validateTaskResult', () => {
  const issues = (s: WfStep, r: unknown): string[] => {
    const v = validateTaskResult(s, r);
    return v.ok ? [] : v.issues;
  };

  it('refuse un non-objet et un résultat trop volumineux', () => {
    expect(validateTaskResult(step(), null).ok).toBe(false);
    expect(validateTaskResult(step(), [1]).ok).toBe(false);
    expect(validateTaskResult(step(), 'ok').ok).toBe(false);
    const big = { values: { texte: 'x'.repeat(WF_RESULT_MAX_BYTES) } };
    expect(issues(step(), big)[0]).toContain('octets');
  });

  it('formulaire : values obligatoire, champs requis non vides, aucune clé inconnue si champs déclarés', () => {
    const form = step({ config: { fields: [{ key: 'nom', required: true }, { key: 'note' }, 'ref'] } });
    expect(validateTaskResult(form, { values: { nom: 'Awa', ref: 'R1' } }).ok).toBe(true);
    expect(issues(form, { values: { nom: '   ' } })).toEqual(['le champ « nom » est obligatoire']);
    expect(issues(form, { values: { note: 'x' } })).toEqual(['le champ « nom » est obligatoire']);
    expect(issues(form, { values: { nom: 'A', pirate: 1 } })).toEqual(["le champ « pirate » n'est pas prévu par le formulaire"]);
    expect(validateTaskResult(form, { values: { nom: 'A' }, approved: true }).ok).toBe(false); // clé en trop
    expect(validateTaskResult(form, {}).ok).toBe(false);
    expect(validateTaskResult(step(), { values: { libre: 1 } }).ok).toBe(true); // sans champs déclarés
    expect(issues(step({ config: { fields: [{ key: 'pj', required: true }] } }), { values: { pj: [] } })).toHaveLength(1);
  });

  it('génération : contenu non vide, documentId entier positif facultatif', () => {
    const g = step({ type: 'generation' });
    expect(validateTaskResult(g, { content: 'Texte' }).ok).toBe(true);
    expect(validateTaskResult(g, { content: 'Texte', documentId: 12 }).ok).toBe(true);
    expect(validateTaskResult(g, { content: '  ' }).ok).toBe(false);
    expect(validateTaskResult(g, { content: 'T', documentId: -1 }).ok).toBe(false);
    expect(validateTaskResult(g, { content: 'T', documentId: '12' }).ok).toBe(false);
    expect(validateTaskResult(g, {}).ok).toBe(false);
  });

  it('checklist : requis cochés, aucune clé inconnue, pas de doublon', () => {
    const c = step({ type: 'checklist', config: { items: [{ key: 'a', required: true }, { key: 'b' }] } });
    expect(validateTaskResult(c, { checked: ['a'] }).ok).toBe(true);
    expect(validateTaskResult(c, { checked: ['a', 'b'] }).ok).toBe(true);
    expect(issues(c, { checked: ['b'] })).toEqual(["l'élément « a » doit être coché"]);
    expect(issues(c, { checked: ['a', 'z'] })).toEqual(["l'élément « z » n'existe pas dans la checklist"]);
    expect(issues(c, { checked: ['a', 'a'] })).toEqual(['un élément est coché plusieurs fois']);
    expect(validateTaskResult(c, { checked: 'a' }).ok).toBe(false);
    // Sans items déclarés : rien n'est cochable.
    expect(validateTaskResult(step({ type: 'checklist' }), { checked: [] }).ok).toBe(true);
    expect(validateTaskResult(step({ type: 'checklist' }), { checked: ['x'] }).ok).toBe(false);
  });

  it('affectation : exactement un bénéficiaire', () => {
    const a = step({ type: 'affectation' });
    expect(validateTaskResult(a, { assignee: { userGroupId: 4 } }).ok).toBe(true);
    expect(validateTaskResult(a, { assignee: { groupId: 4 } }).ok).toBe(true);
    expect(validateTaskResult(a, { assignee: { roleId: 4 } }).ok).toBe(true);
    expect(validateTaskResult(a, { assignee: { userGroupId: 4, groupId: 2 } }).ok).toBe(false);
    expect(validateTaskResult(a, { assignee: {} }).ok).toBe(false);
    expect(validateTaskResult(a, { assignee: { userGroupId: 0 } }).ok).toBe(false);
    expect(validateTaskResult(a, {}).ok).toBe(false);
  });

  it('validation : approved booléen, commentaire facultatif', () => {
    const v = step({ type: 'validation' });
    expect(validateTaskResult(v, { approved: true }).ok).toBe(true);
    expect(validateTaskResult(v, { approved: false, comment: 'Pièce manquante' }).ok).toBe(true);
    expect(validateTaskResult(v, { approved: 'oui' }).ok).toBe(false);
    expect(validateTaskResult(v, {}).ok).toBe(false);
    expect(validateTaskResult(v, { approved: true, rejected: false }).ok).toBe(false);
  });

  it('décision : manuelle => { choice } (parmi config.choices) ; automatique => aucun résultat accepté', () => {
    const manual = step({ type: 'decision', config: { manual: true, choices: ['payer', 'refuser'] } });
    expect(validateTaskResult(manual, { choice: 'payer' }).ok).toBe(true);
    expect(validateTaskResult(manual, { choice: 'autre' }).ok).toBe(false);
    expect(validateTaskResult(manual, { choice: '' }).ok).toBe(false);
    expect(validateTaskResult(step({ type: 'decision', config: { manual: true } }), { choice: 'libre' }).ok).toBe(true);
    expect(validateTaskResult(step({ type: 'decision' }), { choice: 'payer' }).ok).toBe(false);
  });

  it('agent : tout objet JSON', () => {
    expect(validateTaskResult(step({ type: 'agent' }), { anything: [1, 2] }).ok).toBe(true);
  });
});

describe('isTaskAssignee', () => {
  const principal = (over: Partial<WfPrincipal> = {}): WfPrincipal => ({
    userGroupId: 10,
    userId: 1,
    groupIds: [3, 4],
    roleId: 7,
    ...over,
  });
  const task = (over: Partial<{ assigneeUserGroupId: number | null; assigneeGroupId: number | null; assigneeRoleId: number | null }>) => ({
    assigneeUserGroupId: null,
    assigneeGroupId: null,
    assigneeRoleId: null,
    ...over,
  });

  it('utilisateur bénéficiaire', () => {
    expect(isTaskAssignee(principal(), task({ assigneeUserGroupId: 10 }))).toBe(true);
    expect(isTaskAssignee(principal(), task({ assigneeUserGroupId: 11 }))).toBe(false);
  });

  it('membre du groupe bénéficiaire', () => {
    expect(isTaskAssignee(principal(), task({ assigneeGroupId: 4 }))).toBe(true);
    expect(isTaskAssignee(principal(), task({ assigneeGroupId: 5 }))).toBe(false);
    expect(isTaskAssignee(principal({ groupIds: [] }), task({ assigneeGroupId: 4 }))).toBe(false);
  });

  it('titulaire du rôle ACTIF bénéficiaire (rôle null : jamais)', () => {
    expect(isTaskAssignee(principal(), task({ assigneeRoleId: 7 }))).toBe(true);
    expect(isTaskAssignee(principal(), task({ assigneeRoleId: 8 }))).toBe(false);
    expect(isTaskAssignee(principal({ roleId: null }), task({ assigneeRoleId: 7 }))).toBe(false);
  });

  it('tâche sans bénéficiaire : personne, pas même un administrateur', () => {
    expect(isTaskAssignee(principal(), task({}))).toBe(false);
    // L'« administrateur » n'a ni attribut ni exception : un principal sans lien avec la tâche est refusé.
    const admin = principal({ userGroupId: 1, groupIds: [1], roleId: 1 });
    expect(isTaskAssignee(admin, task({ assigneeUserGroupId: 10 }))).toBe(false);
    expect(isTaskAssignee(admin, task({ assigneeGroupId: 3 }))).toBe(false);
  });

  it('principal invalide : refusé', () => {
    expect(isTaskAssignee(principal({ userGroupId: 0 }), task({ assigneeUserGroupId: 0 }))).toBe(false);
  });
});

describe('contexte après étape', () => {
  it('steps[clé] et last mis à jour, sans muter le contexte reçu', () => {
    const before = normalizeContext({ input: { a: 1 }, steps: {}, last: null });
    const after = applyStepResult(before, 'controle', { approved: true });
    expect(after).toEqual({ input: { a: 1 }, steps: { controle: { approved: true } }, last: { approved: true } });
    expect(before.steps).toEqual({});
  });

  it('décision automatique : last conservé ; affectation : assignedTo remplacé', () => {
    const c0 = applyStepResult(ctx(), 'validation', { approved: false });
    const c1 = applyStepResult(c0, 'aiguillage', { decision: { chosen: 'x' } }, { setLast: false });
    expect(c1.last).toEqual({ approved: false });
    expect(c1.steps.aiguillage).toEqual({ decision: { chosen: 'x' } });
    const c2 = applyStepResult(c1, 'affecter', { assignee: { groupId: 2 } }, { assignedTo: { groupId: 2 } });
    expect(c2.assignedTo).toEqual({ groupId: 2 });
    const c3 = applyStepResult(c2, 'suite', { values: {} });
    expect(c3.assignedTo).toEqual({ groupId: 2 });
  });

  it('normalizeContext tolère une colonne corrompue', () => {
    expect(normalizeContext(null)).toEqual({ input: {}, steps: {}, last: null });
    expect(normalizeContext({ input: [1], steps: 'x', assignedTo: { userGroupId: 'a' } })).toEqual({
      input: {},
      steps: {},
      last: null,
    });
  });

  it('résultat de refus', () => {
    expect(buildRejectionResult()).toEqual({ rejected: true, approved: false });
    expect(buildRejectionResult('  Incomplet ')).toEqual({ rejected: true, approved: false, comment: 'Incomplet' });
  });
});

describe('journal borné et sans contenu de document', () => {
  it('boundJson : valeur intacte sous la borne, résumé tronqué au-delà', () => {
    expect(boundJson({ a: 1 })).toEqual({ a: 1 });
    const big = boundJson({ texte: 'é'.repeat(WF_LOG_DECISION_MAX_BYTES) }) as Record<string, unknown>;
    expect(big.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(big), 'utf8')).toBeLessThanOrEqual(WF_LOG_DECISION_MAX_BYTES);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundJson(cyclic)).toMatchObject({ truncated: true });
  });

  it('génération : seule la longueur du contenu est journalisée', () => {
    expect(summarizeResultForLog('generation', { content: 'Secret du dossier', documentId: 4 })).toEqual({
      contentLength: 17,
      documentId: 4,
    });
    expect(summarizeResultForLog('validation', { approved: true })).toEqual({ approved: true });
  });
});
