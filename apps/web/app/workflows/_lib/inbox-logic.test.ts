// Tests de la logique pure de la boîte de tâches Docu-Flow.
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/inbox-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WfInboxEntry } from '../../lib/workflows-api';
import {
  COMMENT_MAX,
  DEFAULT_FILTERS,
  allowedActions,
  buildAgentResult,
  buildApprovalResult,
  buildAssignmentResult,
  buildChecklistResult,
  buildDecisionResult,
  buildFormResult,
  buildFreeFormResult,
  buildGenerationResult,
  countSummary,
  describeSources,
  entryAriaLabel,
  filterEntries,
  filtersAreDefault,
  initialGenerationContent,
  isOverdue,
  mergeEntries,
  noActionReason,
  normalizeText,
  parseDelegateInput,
  parseJsonObject,
  proposalAsResult,
  readChecklistItems,
  readChoices,
  readFields,
  sortEntries,
  statusesForGroup,
} from './inbox-logic';

const NOW = new Date('2026-11-22T12:00:00Z');
const H = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * H).toISOString();

let seq = 0;
function entry(over: {
  id?: string;
  title?: string;
  def?: string;
  step?: string;
  kind?: 0 | 1;
  status?: 0 | 1 | 2 | 3 | 4 | 5;
  priority?: 0 | 1 | 2;
  dueAt?: string | null;
  instanceStatus?: 0 | 1 | 2 | 3 | 4 | 5;
  createdAt?: string;
  proposal?: unknown;
}): WfInboxEntry {
  seq += 1;
  const id = over.id ?? `i${seq}`;
  return {
    item: {
      wfInboxItemId: id,
      taskId: `t${id}`,
      instanceId: `inst${id}`,
      kind: over.kind ?? 0,
      status: over.status ?? 0,
      priority: over.priority ?? 1,
      title: over.title ?? `Élément ${id}`,
      summary: null,
      proposal: over.proposal ?? null,
      explanation: null,
      sources: null,
      confidence: null,
      agentEventId: null,
      assigneeUserGroupId: 1,
      assigneeGroupId: null,
      assigneeRoleId: null,
      dueAt: over.dueAt ?? null,
      claimedBy: null,
      claimedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      resolution: null,
      resolutionComment: null,
      createdAt: over.createdAt ?? `2026-11-${String(10 + (seq % 10)).padStart(2, '0')}T08:00:00Z`,
      updatedAt: '2026-11-22T08:00:00Z',
    },
    task: {
      wfTaskId: `t${id}`,
      stepKey: over.step ?? 'controle',
      taskType: 0,
      status: 0,
      attempt: 1,
      dueAt: null,
      instructions: null,
    },
    definitionName: over.def ?? 'Traitement des factures',
    instanceStatus: over.instanceStatus ?? 1,
  };
}

const ids = (list: WfInboxEntry[]) => list.map((e) => e.item.wfInboxItemId);

// --- Groupes de statuts -----------------------------------------------------

test('groupes de statuts : paramètre envoyé à l’API', () => {
  assert.deepEqual(statusesForGroup('open'), [0, 1]);
  assert.deepEqual(statusesForGroup('done'), [2]);
  assert.deepEqual(statusesForGroup('closed'), [3, 4, 5]);
  assert.deepEqual(statusesForGroup('all'), [0, 1, 2, 3, 4, 5]);
  // copie : modifier le résultat ne doit pas altérer la constante
  statusesForGroup('open').push(9);
  assert.deepEqual(statusesForGroup('open'), [0, 1]);
});

// --- Texte ------------------------------------------------------------------

test('normalizeText : casse, accents et espaces', () => {
  assert.equal(normalizeText('  Échéance   À Vérifier '), 'echeance a verifier');
});

// --- isOverdue --------------------------------------------------------------

test('isOverdue : échéance dépassée ET statut ouvert ou pris', () => {
  assert.equal(isOverdue(entry({ dueAt: at(-2), status: 0 }), NOW), true);
  assert.equal(isOverdue(entry({ dueAt: at(-2), status: 1 }), NOW), true);
  assert.equal(isOverdue(entry({ dueAt: at(-2), status: 2 }), NOW), false);
  assert.equal(isOverdue(entry({ dueAt: at(-2), status: 4 }), NOW), false);
  assert.equal(isOverdue(entry({ dueAt: at(2), status: 0 }), NOW), false);
  assert.equal(isOverdue(entry({ dueAt: null, status: 0 }), NOW), false);
  assert.equal(isOverdue(entry({ dueAt: 'pas une date', status: 0 }), NOW), false);
});

test('isOverdue : l’échéance de la tâche sert de repli', () => {
  const e = entry({ dueAt: null });
  e.task.dueAt = at(-1);
  assert.equal(isOverdue(e, NOW), true);
});

// --- Filtres ----------------------------------------------------------------

test('filtre de nature', () => {
  const list = [entry({ id: 'h', kind: 0 }), entry({ id: 'a', kind: 1 })];
  assert.deepEqual(ids(filterEntries(list, { ...DEFAULT_FILTERS, nature: 'human' }, NOW)), ['h']);
  assert.deepEqual(ids(filterEntries(list, { ...DEFAULT_FILTERS, nature: 'agent' }, NOW)), ['a']);
  assert.deepEqual(ids(filterEntries(list, DEFAULT_FILTERS, NOW)), ['h', 'a']);
});

test('filtre d’échéance : retard, 24 h, semaine, sans échéance', () => {
  const list = [
    entry({ id: 'late', dueAt: at(-3) }),
    entry({ id: 'soon', dueAt: at(5) }),
    entry({ id: 'week', dueAt: at(72) }),
    entry({ id: 'far', dueAt: at(24 * 20) }),
    entry({ id: 'none', dueAt: null }),
    entry({ id: 'doneLate', dueAt: at(-3), status: 2 }),
  ];
  const f = (due: 'all' | 'overdue' | 'day' | 'week' | 'none') =>
    ids(filterEntries(list, { ...DEFAULT_FILTERS, due }, NOW));
  assert.deepEqual(f('overdue'), ['late']);
  assert.deepEqual(f('day'), ['soon']);
  assert.deepEqual(f('week'), ['soon', 'week']);
  assert.deepEqual(f('none'), ['none']);
  assert.equal(f('all').length, 6);
});

test('filtre texte : titre, workflow, étape, sans tenir compte de la casse ni des accents', () => {
  const list = [
    entry({ id: 'a', title: 'Valider l’échéance du bail', def: 'Gestion locative', step: 'validation' }),
    entry({ id: 'b', title: 'Relire', def: 'Courriers entrants', step: 'relecture' }),
  ];
  const f = (text: string) => ids(filterEntries(list, { ...DEFAULT_FILTERS, text }, NOW));
  assert.deepEqual(f('ECHEANCE'), ['a']);
  assert.deepEqual(f('locative'), ['a']);
  assert.deepEqual(f('courriers'), ['b']);
  assert.deepEqual(f('RELECTURE'), ['b']);
  assert.deepEqual(f('bail locative'), ['a'], 'tous les mots doivent correspondre');
  assert.deepEqual(f('bail courriers'), []);
  assert.deepEqual(f('   '), ['a', 'b']);
});

test('filtersAreDefault', () => {
  assert.equal(filtersAreDefault(DEFAULT_FILTERS), true);
  assert.equal(filtersAreDefault({ ...DEFAULT_FILTERS, text: '  ' }), true);
  assert.equal(filtersAreDefault({ ...DEFAULT_FILTERS, nature: 'agent' }), false);
});

// --- Tri --------------------------------------------------------------------

test('tri par échéance : retards d’abord, sans échéance en dernier', () => {
  const list = [
    entry({ id: 'none', dueAt: null }),
    entry({ id: 'later', dueAt: at(30) }),
    entry({ id: 'late2', dueAt: at(-1) }),
    entry({ id: 'soon', dueAt: at(2) }),
    entry({ id: 'late1', dueAt: at(-10) }),
  ];
  const sorted = sortEntries(list, 'due', NOW);
  assert.deepEqual(ids(sorted), ['late1', 'late2', 'soon', 'later', 'none']);
  assert.deepEqual(ids(list), ['none', 'later', 'late2', 'soon', 'late1'], 'le tableau reçu n’est pas modifié');
});

test('tri par échéance : égalité départagée par la priorité', () => {
  const list = [
    entry({ id: 'low', dueAt: at(5), priority: 0 }),
    entry({ id: 'high', dueAt: at(5), priority: 2 }),
  ];
  assert.deepEqual(ids(sortEntries(list, 'due', NOW)), ['high', 'low']);
});

test('tri par priorité décroissante puis échéance', () => {
  const list = [
    entry({ id: 'n', priority: 1, dueAt: at(1) }),
    entry({ id: 'h-late', priority: 2, dueAt: null }),
    entry({ id: 'h-soon', priority: 2, dueAt: at(3) }),
    entry({ id: 'l', priority: 0, dueAt: at(-5) }),
  ];
  assert.deepEqual(ids(sortEntries(list, 'priority', NOW)), ['h-soon', 'h-late', 'n', 'l']);
});

test('tri « plus récentes d’abord »', () => {
  const list = [
    entry({ id: 'old', createdAt: '2026-11-01T00:00:00Z' }),
    entry({ id: 'new', createdAt: '2026-11-20T00:00:00Z' }),
    entry({ id: 'mid', createdAt: '2026-11-10T00:00:00Z' }),
  ];
  assert.deepEqual(ids(sortEntries(list, 'recent', NOW)), ['new', 'mid', 'old']);
});

// --- Compteur, fusion, libellé accessible -----------------------------------

test('countSummary : pluriel et retards', () => {
  assert.equal(countSummary([], NOW).text, 'Aucun élément');
  assert.equal(countSummary([entry({})], NOW).text, '1 élément');
  const list = [entry({ dueAt: at(-1) }), entry({ dueAt: at(-2) }), entry({ dueAt: at(-3) }), entry({})];
  const s = countSummary(list, NOW);
  assert.equal(s.text, '4 éléments, dont 3 en retard');
  assert.equal(s.overdue, 3);
});

test('mergeEntries : pas de doublon', () => {
  const a = entry({ id: 'a' });
  const b = entry({ id: 'b' });
  assert.deepEqual(ids(mergeEntries([a], [a, b, b])), ['a', 'b']);
});

test('entryAriaLabel : nom complet, retard dit en toutes lettres', () => {
  const label = entryAriaLabel(entry({ title: 'Contrôle', dueAt: at(-2), kind: 1, priority: 2 }), NOW);
  assert.match(label, /Contrôle/);
  assert.match(label, /Validation d’agent/);
  assert.match(label, /En retard de 2 h/);
  assert.match(label, /haute/);
});

// --- Droits d'action --------------------------------------------------------

test('allowedActions selon le statut de l’élément', () => {
  assert.deepEqual(allowedActions(entry({ status: 0 })), { claim: true, complete: true, reject: true, delegate: true });
  assert.deepEqual(allowedActions(entry({ status: 1 })), { claim: false, complete: true, reject: true, delegate: true });
  for (const status of [2, 3, 4, 5] as const) {
    assert.deepEqual(allowedActions(entry({ status })), { claim: false, complete: false, reject: false, delegate: false });
  }
});

test('allowedActions : instance suspendue ou terminale => aucune action', () => {
  for (const instanceStatus of [2, 3, 4, 5] as const) {
    const e = entry({ status: 0, instanceStatus });
    assert.deepEqual(allowedActions(e), { claim: false, complete: false, reject: false, delegate: false });
    assert.ok(noActionReason(e));
  }
  assert.equal(noActionReason(entry({ status: 0, instanceStatus: 0 })), null);
  assert.match(noActionReason(entry({ status: 0, instanceStatus: 5 })) ?? '', /suspendu/);
  assert.match(noActionReason(entry({ status: 2 })) ?? '', /clos/);
});

// --- Lecture de la configuration --------------------------------------------

test('readFields / readChecklistItems : chaînes et objets, doublons et valeurs invalides ignorés', () => {
  const config = {
    fields: ['montant', { key: 'motif', label: 'Motif du refus', required: true }, { key: 'montant' }, 42, null, { label: 'sans clé' }, ' '],
    items: [{ key: 'a', required: true }, 'b'],
  };
  assert.deepEqual(readFields(config), [
    { key: 'montant', label: 'montant', required: false },
    { key: 'motif', label: 'Motif du refus', required: true },
  ]);
  assert.deepEqual(readChecklistItems(config), [
    { key: 'a', label: 'a', required: true },
    { key: 'b', label: 'b', required: false },
  ]);
  assert.deepEqual(readFields(null), []);
  assert.deepEqual(readFields({ fields: 'x' }), []);
});

test('readChoices : chaînes et objets', () => {
  assert.deepEqual(readChoices({ choices: ['oui', { value: 'non', label: 'Non merci' }, { key: 'peut', label: 'Peut-être' }, 'oui', 3] }), [
    { value: 'oui', label: 'oui' },
    { value: 'non', label: 'Non merci' },
    { value: 'peut', label: 'Peut-être' },
  ]);
  assert.deepEqual(readChoices({}), []);
});

// --- Formulaire -------------------------------------------------------------

test('buildFormResult : valide, champs facultatifs vides omis', () => {
  const fields = readFields({ fields: [{ key: 'montant', required: true }, 'note'] });
  const r = buildFormResult(fields, { montant: ' 120 ', note: '   ' });
  assert.deepEqual(r, { ok: true, result: { values: { montant: '120' } } });
});

test('buildFormResult : champ obligatoire manquant', () => {
  const fields = readFields({ fields: [{ key: 'montant', label: 'Montant', required: true }] });
  const r = buildFormResult(fields, { montant: '  ' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.errors, ['Le champ « Montant » est obligatoire.']);
});

test('buildFreeFormResult : lignes libres, clé vide ou en double refusée', () => {
  assert.deepEqual(buildFreeFormResult([{ key: 'a', value: '1' }, { key: '', value: '' }]), { ok: true, result: { values: { a: '1' } } });
  const noKey = buildFreeFormResult([{ key: '', value: 'x' }]);
  assert.equal(noKey.ok, false);
  const dup = buildFreeFormResult([{ key: 'a', value: '1' }, { key: ' a ', value: '2' }]);
  assert.equal(dup.ok, false);
  const proto = buildFreeFormResult([{ key: '__proto__', value: 'x' }]);
  assert.equal(proto.ok, false);
});

// --- Génération -------------------------------------------------------------

test('buildGenerationResult : valide avec et sans documentId', () => {
  assert.deepEqual(buildGenerationResult('Bonjour', ''), { ok: true, result: { content: 'Bonjour' } });
  assert.deepEqual(buildGenerationResult('Bonjour', ' 42 '), { ok: true, result: { content: 'Bonjour', documentId: 42 } });
});

test('buildGenerationResult : contenu vide, documentId invalide', () => {
  assert.equal(buildGenerationResult('   ', '').ok, false);
  for (const bad of ['0', '-3', '1.5', 'abc', '99999999999999999999']) {
    assert.equal(buildGenerationResult('x', bad).ok, false, bad);
  }
});

test('résultat trop volumineux refusé (64 Kio)', () => {
  assert.equal(buildGenerationResult('é'.repeat(40_000), '').ok, false);
});

// --- Checklist --------------------------------------------------------------

test('buildChecklistResult : valide, éléments déclarés', () => {
  const items = readChecklistItems({ items: [{ key: 'a', required: true }, 'b'] });
  assert.deepEqual(buildChecklistResult(items, ['a']), { ok: true, result: { checked: ['a'] } });
  assert.deepEqual(buildChecklistResult(items, ['a', 'b']), { ok: true, result: { checked: ['a', 'b'] } });
});

test('buildChecklistResult : requis non coché, clé inconnue, doublon', () => {
  const items = readChecklistItems({ items: [{ key: 'a', label: 'Pièce A', required: true }, 'b'] });
  const missing = buildChecklistResult(items, ['b']);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.errors[0]!, /Pièce A/);
  assert.equal(buildChecklistResult(items, ['a', 'zzz']).ok, false);
  const dup = buildChecklistResult(items, ['a', 'a']);
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.match(dup.errors[0]!, /plusieurs fois/);
});

test('buildChecklistResult : saisie libre (aucun élément déclaré)', () => {
  assert.deepEqual(buildChecklistResult([], [' x ', 'y', '']), { ok: true, result: { checked: ['x', 'y'] } });
  assert.equal(buildChecklistResult([], ['x', 'x']).ok, false);
});

// --- Affectation ------------------------------------------------------------

test('buildAssignmentResult : exactement un identifiant', () => {
  assert.deepEqual(buildAssignmentResult({ userGroupId: '7' }), { ok: true, result: { assignee: { userGroupId: 7 } } });
  assert.deepEqual(buildAssignmentResult({ groupId: 3 }), { ok: true, result: { assignee: { groupId: 3 } } });
  assert.deepEqual(buildAssignmentResult({ roleId: ' 2 ', userGroupId: '', groupId: null }), { ok: true, result: { assignee: { roleId: 2 } } });
});

test('buildAssignmentResult : aucun, deux identifiants, valeur invalide', () => {
  assert.equal(buildAssignmentResult({}).ok, false);
  const two = buildAssignmentResult({ userGroupId: 1, groupId: 2 });
  assert.equal(two.ok, false);
  if (!two.ok) assert.match(two.errors[0]!, /seul bénéficiaire/);
  for (const bad of ['0', '-1', '2.5', 'x']) assert.equal(buildAssignmentResult({ roleId: bad }).ok, false, bad);
});

// --- Validation -------------------------------------------------------------

test('buildApprovalResult : approuvé ou non, commentaire facultatif', () => {
  assert.deepEqual(buildApprovalResult(true, ''), { ok: true, result: { approved: true } });
  assert.deepEqual(buildApprovalResult(false, '  Pièce illisible '), { ok: true, result: { approved: false, comment: 'Pièce illisible' } });
});

test('buildApprovalResult : choix manquant, commentaire trop long', () => {
  assert.equal(buildApprovalResult(null, '').ok, false);
  assert.equal(buildApprovalResult(undefined, '').ok, false);
  const long = buildApprovalResult(true, 'a'.repeat(COMMENT_MAX + 1));
  assert.equal(long.ok, false);
  assert.equal(buildApprovalResult(true, 'a'.repeat(COMMENT_MAX)).ok, true);
  // les deux erreurs sont cumulées
  const both = buildApprovalResult(null, 'a'.repeat(COMMENT_MAX + 1));
  if (!both.ok) assert.equal(both.errors.length, 2);
});

// --- Décision ---------------------------------------------------------------

test('buildDecisionResult : choix déclarés ou texte libre', () => {
  const choices = readChoices({ choices: ['accepter', 'refuser'] });
  assert.deepEqual(buildDecisionResult(choices, 'accepter'), { ok: true, result: { choice: 'accepter' } });
  assert.equal(buildDecisionResult(choices, 'autre').ok, false);
  assert.equal(buildDecisionResult(choices, '').ok, false);
  assert.deepEqual(buildDecisionResult([], '  libre '), { ok: true, result: { choice: 'libre' } });
  assert.equal(buildDecisionResult([], '   ').ok, false);
  assert.equal(buildDecisionResult([], null).ok, false);
});

// --- JSON -------------------------------------------------------------------

test('parseJsonObject : objet accepté, le reste refusé avec un message', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { ok: true, value: { a: 1 } });
  for (const bad of ['', '   ', '{', '[1,2]', '42', '"texte"', 'null', 'true']) {
    const r = parseJsonObject(bad);
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.ok(r.error.length > 0);
  }
});

test('buildAgentResult : l’objet JSON est le résultat', () => {
  assert.deepEqual(buildAgentResult('{"ok": true}'), { ok: true, result: { ok: true } });
  assert.equal(buildAgentResult('[1]').ok, false);
});

// --- Délégation -------------------------------------------------------------

test('parseDelegateInput', () => {
  assert.deepEqual(parseDelegateInput(' 12 ', ' merci ', 3), { ok: true, toUserGroupId: 12, comment: 'merci' });
  assert.deepEqual(parseDelegateInput('12', '', null), { ok: true, toUserGroupId: 12, comment: undefined });
  for (const bad of ['', '0', '-2', '1.5', 'abc']) assert.equal(parseDelegateInput(bad, '', 3).ok, false, bad);
  const self = parseDelegateInput('3', '', 3);
  assert.equal(self.ok, false);
  if (!self.ok) assert.match(self.errors[0]!, /vous-même/);
  assert.equal(parseDelegateInput('5', 'a'.repeat(COMMENT_MAX + 1), 3).ok, false);
});

// --- Proposition d'agent ----------------------------------------------------

test('proposalAsResult : objet seulement, et seulement pour une validation d’agent', () => {
  const p = { content: 'Texte', documentId: 4 };
  assert.deepEqual(proposalAsResult(entry({ kind: 1, proposal: p })), p);
  assert.equal(proposalAsResult(entry({ kind: 1, proposal: 'texte' })), null);
  assert.equal(proposalAsResult(entry({ kind: 1, proposal: [1] })), null);
  assert.equal(proposalAsResult(entry({ kind: 1, proposal: null })), null);
  assert.equal(proposalAsResult(entry({ kind: 0, proposal: p })), null);
});

test('initialGenerationContent : proposition, sinon suggestion de la tâche', () => {
  assert.equal(initialGenerationContent(entry({ kind: 1, proposal: { content: 'De l’agent' } }), { suggestion: 'Autre' }), 'De l’agent');
  assert.equal(initialGenerationContent(entry({ kind: 0 }), { suggestion: 'Suggestion' }), 'Suggestion');
  assert.equal(initialGenerationContent(entry({ kind: 0 }), { suggestion: { content: 'Objet' } }), 'Objet');
  assert.equal(initialGenerationContent(entry({ kind: 0 }), null), '');
});

test('describeSources : chaînes, objets, valeurs étranges', () => {
  assert.deepEqual(describeSources(['Contrat 2024', '  ', { label: 'Annexe 3' }, { title: 'Note' }, { name: 'Courrier' }]), [
    'Contrat 2024',
    'Annexe 3',
    'Note',
    'Courrier',
  ]);
  assert.deepEqual(describeSources([{ documentId: 17 }, { documentId: '18' }, { documentId: 'abc' }, { label: '', documentId: 5 }]), [
    'Document n° 17',
    'Document n° 18',
    'Document n° 5',
  ]);
  assert.deepEqual(describeSources([null, undefined, 42, true, [], {}, { label: 7 }, () => 1]), []);
  assert.deepEqual(describeSources(null), []);
  assert.deepEqual(describeSources({ label: 'pas un tableau' }), []);
  assert.deepEqual(describeSources('Source unique'), ['Source unique']);
  assert.equal(describeSources(Array.from({ length: 80 }, (_, i) => `s${i}`)).length, 50);
  assert.equal(describeSources(['x'.repeat(1000)])[0]!.length, 300);
  // un lien reste du texte : aucun traitement particulier, mais jamais de balise
  assert.deepEqual(describeSources([{ label: 'https://exemple.test', url: 'https://x' }]), ['https://exemple.test']);
});
