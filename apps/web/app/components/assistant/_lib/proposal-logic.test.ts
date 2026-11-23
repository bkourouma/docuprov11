// Logique pure de la carte de confirmation.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/_lib/proposal-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASST_ERROR_CODE_VALUES, type AsstProposalDto, type AsstProposedAction } from '@archivage/types';
import {
  canConfirm,
  canRefuse,
  cardPhase,
  cardWarnings,
  confirmPayload,
  createSubmitLock,
  describeAction,
  describeEffect,
  effectiveStatus,
  formatCountdown,
  formatExpiryClock,
  htmlToPlainText,
  remainingSeconds,
  resolveProposalError,
} from './proposal-logic';

const EXP = '2026-11-22T09:29:02.000Z';
const expMs = Date.parse(EXP);
const p = (status: 0 | 1 | 2 | 3 | 4 | 5, expiresAt = EXP) => ({ status, expiresAt });

const imputation: AsstProposedAction = {
  tool: 'proposer_imputation_courrier',
  args: {
    mailId: 4321,
    recipients: [
      { userGroupId: 17, mailInputationTypeId: 2, delayDays: 1, instructions: 'À traiter vite' },
      { userGroupId: 18, mailInputationTypeId: 3 },
      { userGroupId: 19, mailInputationTypeId: 4, delayDays: 5 },
    ],
    rationale: 'Motif X',
  },
};
const relance: AsstProposedAction = {
  tool: 'proposer_relance',
  args: { mailId: 10, mailInputationId: 20, recipientUserGroupId: 30, message: 'Merci de répondre', escalateToUserGroupId: 40 },
};
const brouillon: AsstProposedAction = {
  tool: 'preparer_brouillon_reponse',
  args: { templateId: 'tpl-1', label: 'Réponse', draftHtml: '<p>Bonjour</p>', mailId: 5, spaceId: 6 },
};

test('effectiveStatus : 0 expiré à l’échéance, invalide => expirée, autres inchangés', () => {
  assert.equal(effectiveStatus(p(0), expMs - 1), 0);
  assert.equal(effectiveStatus(p(0), expMs), 4);
  assert.equal(effectiveStatus(p(0), expMs + 5000), 4);
  assert.equal(effectiveStatus(p(0, 'pas une date'), 0), 4);
  for (const s of [1, 2, 3, 4, 5] as const) assert.equal(effectiveStatus(p(s), expMs + 1e9), s);
});

test('cardPhase : toutes les phases', () => {
  const now = expMs - 60_000;
  assert.equal(cardPhase(p(0), now, null), 'proposed');
  assert.equal(cardPhase(p(0), now, 'confirm'), 'confirming');
  assert.equal(cardPhase(p(0), now, 'refuse'), 'confirming');
  assert.equal(cardPhase(p(1), now, null), 'confirming');
  assert.equal(cardPhase(p(2), now, null), 'applied');
  assert.equal(cardPhase(p(3), now, null), 'refused');
  assert.equal(cardPhase(p(4), now, null), 'expired');
  assert.equal(cardPhase(p(5), now, null), 'failed');
  assert.equal(cardPhase(p(0), expMs, null), 'expired');
});

test('canConfirm / canRefuse', () => {
  const now = expMs - 1000;
  assert.equal(canConfirm(p(0), now, null), true);
  assert.equal(canRefuse(p(0), now, null), true);
  assert.equal(canConfirm(p(0), now, 'confirm'), false);
  assert.equal(canRefuse(p(0), now, 'refuse'), false);
  assert.equal(canConfirm(p(0), expMs, null), false);
  for (const s of [1, 2, 3, 4, 5] as const) assert.equal(canConfirm(p(s), now, null), false);
});

test('remainingSeconds / formatCountdown aux bornes', () => {
  assert.equal(remainingSeconds(EXP, expMs), 0);
  assert.equal(remainingSeconds(EXP, expMs + 10_000), 0);
  assert.equal(remainingSeconds(EXP, expMs - 1), 1);
  assert.equal(remainingSeconds(EXP, expMs - 59_000), 59);
  assert.equal(remainingSeconds(EXP, expMs - 60_000), 60);
  assert.equal(remainingSeconds(EXP, expMs - 61_000), 61);
  assert.equal(remainingSeconds(EXP, expMs - 899_000), 899);
  assert.equal(remainingSeconds('invalide', expMs), 0);
  assert.equal(formatCountdown(0), 'Expirée');
  assert.equal(formatCountdown(-5), 'Expirée');
  assert.equal(formatCountdown(45), '45 s');
  assert.equal(formatCountdown(59), '59 s');
  assert.equal(formatCountdown(60), '1 min');
  assert.equal(formatCountdown(61), '1 min 1 s');
  assert.equal(formatCountdown(872), '14 min 32 s');
  assert.equal(formatCountdown(899), '14 min 59 s');
});

test('formatExpiryClock : HH:mm locale, tiret si invalide', () => {
  const d = new Date(EXP);
  const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(formatExpiryClock(EXP), expected);
  assert.match(formatExpiryClock(EXP), /^\d{2}:\d{2}$/);
  assert.equal(formatExpiryClock('nope'), '—');
});

test('htmlToPlainText : scripts, onerror, entités, blancs, troncature', () => {
  assert.equal(htmlToPlainText('<script>alert(1)</script>Bonjour').text, 'Bonjour');
  assert.equal(htmlToPlainText('<style>p{color:red}</style><p>Salut</p>').text, 'Salut');
  const img = htmlToPlainText('<img src=x onerror=alert(1)>Texte').text;
  assert.equal(img, 'Texte');
  assert.ok(!img.includes('onerror'));
  assert.equal(htmlToPlainText('<script>alert(1)').text, '');
  assert.equal(htmlToPlainText('<p>a</p><p>b</p>').text, 'a b');
  assert.equal(htmlToPlainText('Tom &amp; Jerry &lt;3 &quot;x&quot; l&#39;a&nbsp;b').text, 'Tom & Jerry <3 "x" l\'a b');
  assert.equal(htmlToPlainText('  a \n\n  b\t c  ').text, 'a b c');
  const long = htmlToPlainText('x'.repeat(1000));
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, 400);
  assert.deepEqual(htmlToPlainText('abc', 3), { text: 'abc', truncated: false });
  assert.deepEqual(htmlToPlainText('abcd', 3), { text: 'abc', truncated: true });
  assert.deepEqual(htmlToPlainText(undefined as unknown as string), { text: '', truncated: false });
});

test('describeAction : imputation', () => {
  const v = describeAction(imputation);
  assert.equal(v.title, 'Imputation de courrier');
  assert.equal(v.reversibility, 'none');
  assert.deepEqual(v.rows, [
    { label: 'Courrier', value: 'n° 4321' },
    { label: 'Motif', value: 'Motif X' },
  ]);
  assert.equal(v.items?.length, 3);
  assert.equal(v.items?.[0]!.title, 'Destinataire 1');
  assert.deepEqual(v.items?.[0].rows, [
    { label: 'Groupe d’utilisateurs', value: 'n° 17' },
    { label: 'Type d’imputation', value: 'n° 2' },
    { label: 'Délai', value: '1 jour' },
    { label: 'Instructions', value: 'À traiter vite' },
  ]);
  assert.equal(v.items?.[1]!.rows[2]!.value, 'Non précisé');
  assert.equal(v.items?.[2]!.rows[2]!.value, '5 jours');
});

test('describeAction : relance et brouillon', () => {
  const r = describeAction(relance);
  assert.equal(r.title, 'Relance');
  assert.equal(r.note, 'Notification interne : aucun e-mail n’est envoyé.');
  assert.deepEqual(r.rows.map((x) => x.label), [
    'Courrier',
    'Imputation visée',
    'Destinataire (groupe)',
    'Message',
    'Escalade vers (groupe)',
  ]);
  assert.equal(r.rows[4]!.value, 'n° 40');
  const noEsc = describeAction({ tool: 'proposer_relance', args: { ...relance.args, escalateToUserGroupId: undefined } } as AsstProposedAction);
  assert.equal(noEsc.rows.length, 4);

  const b = describeAction(brouillon);
  assert.equal(b.title, 'Brouillon de réponse');
  assert.equal(b.reversibility, 'deletable');
  assert.equal(b.note, 'Un document brouillon sera créé.');
  assert.equal(b.rows.find((x) => x.label === 'Contenu du brouillon')?.value, 'Bonjour');
  assert.equal(b.rows.find((x) => x.label === 'Taille')?.value, '(14 caractères)');
  assert.equal(b.rows.find((x) => x.label === 'Espace')?.value, 'n° 6');
  const long = describeAction({
    tool: 'preparer_brouillon_reponse',
    args: { templateId: 't', label: 'L', draftHtml: `<p>${'y'.repeat(900)}</p><script>alert(1)</script>` },
  });
  const content = long.rows.find((x) => x.label === 'Contenu du brouillon')?.value ?? '';
  assert.ok(content.endsWith('…'));
  assert.ok(content.length <= 401);
  assert.ok(!content.includes('alert'));
  assert.ok(!long.rows.some((x) => x.label === 'Courrier' || x.label === 'Espace'));
});

test('describeAction : outil inconnu et données bizarres, sans exception', () => {
  const unknown = describeAction({ tool: 'envoyer_mail', args: {} } as unknown as AsstProposedAction);
  assert.equal(unknown.title, 'Action non reconnue');
  assert.deepEqual(unknown.rows, []);
  assert.equal(unknown.reversibility, 'none');
  assert.match(unknown.note ?? '', /refusez-la/);

  const weird: unknown[] = [
    null,
    undefined,
    42,
    'x',
    [],
    {},
    { tool: null },
    { tool: 'proposer_imputation_courrier' },
    { tool: 'proposer_imputation_courrier', args: null },
    { tool: 'proposer_imputation_courrier', args: { mailId: '12', recipients: null, rationale: 5 } },
    { tool: 'proposer_imputation_courrier', args: { mailId: 'abc', recipients: [null, 3, { userGroupId: {} }] } },
    { tool: 'proposer_relance', args: { mailId: NaN, message: {}, escalateToUserGroupId: 'x' } },
    { tool: 'preparer_brouillon_reponse', args: { draftHtml: 12, label: [], templateId: null } },
  ];
  for (const w of weird) {
    const v = describeAction(w as AsstProposedAction);
    assert.equal(typeof v.title, 'string');
    assert.ok(Array.isArray(v.rows));
    for (const r of v.rows) assert.equal(typeof r.value, 'string');
  }
  const s = describeAction({ tool: 'proposer_imputation_courrier', args: { mailId: '12', recipients: null, rationale: 5 } } as unknown as AsstProposedAction);
  assert.equal(s.rows[0]!.value, 'n° 12');
  assert.equal(s.rows[1]!.value, '5');
  assert.deepEqual(s.items, []);
  const t = describeAction({ tool: 'proposer_imputation_courrier', args: { mailId: 'abc' } } as unknown as AsstProposedAction);
  assert.equal(t.rows[0]!.value, '—');
  assert.doesNotThrow(() => cardWarnings(null as unknown as AsstProposedAction[], { remainingSec: 10 }));
});

test('cardWarnings', () => {
  assert.deepEqual(cardWarnings([brouillon], { remainingSec: 600 }), []);
  assert.deepEqual(cardWarnings([relance], { remainingSec: 600 }), [
    'Cette action écrit dans l’application et ne peut pas être annulée automatiquement.',
  ]);
  const multi = cardWarnings([relance, brouillon, imputation], { remainingSec: 60 });
  assert.equal(multi.length, 3);
  assert.ok(multi.includes('Plusieurs actions seront appliquées en une seule confirmation (3).'));
  assert.ok(multi.includes('Cette proposition expire dans moins d’une minute.'));
  assert.deepEqual(cardWarnings([brouillon], { remainingSec: 61 }), []);
  assert.deepEqual(cardWarnings([brouillon], { remainingSec: 0 }), []);
});

test('describeEffect', () => {
  const d = describeEffect({
    tool: 'proposer_imputation_courrier',
    summary: { mailId: 4321, inputationsCreees: 1, notificationsCreees: 2, documentId: '77', autre: true, obj: { a: 1 }, nul: null },
  });
  assert.equal(d.title, 'Imputation de courrier');
  assert.deepEqual(d.rows.slice(0, 5), [
    { label: 'Courrier', value: 'n° 4321' },
    { label: 'Imputations créées', value: '1' },
    { label: 'Notifications créées', value: '2' },
    { label: 'Document', value: 'n° 77' },
    { label: 'autre', value: 'true' },
  ]);
  assert.equal(d.rows[5]!.value, '{"a":1}');
  assert.equal(describeEffect({ tool: 'x', summary: {} }).title, 'Effet');
  const big = describeEffect({ tool: 'x', summary: { k: { v: 'z'.repeat(500) } } });
  assert.ok(big.rows[0]!.value.length <= 201);
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) many[`k${i}`] = i;
  assert.equal(describeEffect({ tool: 'x', summary: many }).rows.length, 12);
  assert.doesNotThrow(() => describeEffect(null as never));
  assert.doesNotThrow(() => describeEffect({ tool: 'x', summary: 'bizarre' as never }));
  const circ: Record<string, unknown> = {};
  circ.self = circ;
  assert.doesNotThrow(() => describeEffect({ tool: 'x', summary: circ }));
});

const proposalStub = { proposalId: '1', status: 5 } as unknown as AsstProposalDto;

test('resolveProposalError : 11 codes x 2 actions', () => {
  assert.equal(ASST_ERROR_CODE_VALUES.length, 11);
  for (const action of ['confirm', 'refuse'] as const) {
    const r = (code: string | null, extra: object = {}, status = 400) =>
      resolveProposalError(action, { status, errorCode: code, message: 'Message API', ...extra });

    const conflict = r('conflict', {}, 409);
    assert.equal(conflict.kind, 'reload');
    if (conflict.kind === 'reload') assert.equal(conflict.notice.kind, 'conflict');
    assert.ok(!('retry' in conflict));

    const exp = r('proposal_expired', {}, 409);
    assert.deepEqual(exp, { kind: 'reload', notice: { kind: 'info', message: 'Cette proposition a expiré. Reformulez votre demande.' } });

    const np = r('proposal_not_pending', {}, 409);
    assert.deepEqual(np, {
      kind: 'reload',
      notice: { kind: 'info', message: 'Cette proposition n’est plus en attente : voici son état actuel.' },
    });

    assert.deepEqual(r('effect_failed', { proposal: proposalStub }, 422), { kind: 'replace', proposal: proposalStub });
    assert.deepEqual(r('effect_failed', {}, 422), { kind: 'notice', notice: { kind: 'error', message: 'Message API' } });
    assert.deepEqual(r('effect_forbidden', { proposal: proposalStub }, 403), { kind: 'replace', proposal: proposalStub });
    assert.deepEqual(r('effect_forbidden', { proposal: null }, 403), { kind: 'reload', notice: { kind: 'error', message: 'Message API' } });

    assert.deepEqual(r('not_found', {}, 404), { kind: 'remove' });

    const idr = r('identity_refused', {}, 403);
    assert.equal(idr.kind, 'notice');
    if (idr.kind === 'notice') assert.match(idr.notice.message, /^Accès refusé/);

    const inv = r('invalid_input', {}, 422);
    assert.equal(inv.kind, 'notice');
    if (inv.kind === 'notice') assert.equal(inv.notice.kind, 'error');

    assert.deepEqual(r('not_implemented', {}, 501), {
      kind: 'notice',
      notice: { kind: 'error', message: 'Fonction indisponible pour l’instant.' },
    });
    assert.deepEqual(r(null, {}, 501), {
      kind: 'notice',
      notice: { kind: 'error', message: 'Fonction indisponible pour l’instant.' },
    });

    assert.deepEqual(r('budget_exceeded', {}, 429), { kind: 'notice', notice: { kind: 'error', message: 'Message API' } });
    assert.deepEqual(r('assistant_unavailable', {}, 503), { kind: 'notice', notice: { kind: 'error', message: 'Message API' } });
    // Réseau (0) et 5xx hors 503 : état incertain -> relecture, message d'erreur conservé.
    const reloadErr = { kind: 'reload', notice: { kind: 'error', message: 'Message API' } };
    assert.deepEqual(r(null, {}, 0), reloadErr);
    assert.deepEqual(r(null, {}, 500), reloadErr);
    assert.deepEqual(r(null, {}, 502), reloadErr);
    assert.deepEqual(r(null, {}, 503), { kind: 'notice', notice: { kind: 'error', message: 'Message API' } });
    assert.deepEqual(r(null, {}, 400), { kind: 'notice', notice: { kind: 'error', message: 'Message API' } });
  }
});

test('createSubmitLock', () => {
  const lock = createSubmitLock();
  assert.equal(lock.isLocked('a'), false);
  assert.equal(lock.tryAcquire('a'), true);
  assert.equal(lock.tryAcquire('a'), false);
  assert.equal(lock.isLocked('a'), true);
  assert.equal(lock.tryAcquire('b'), true);
  lock.release('a');
  assert.equal(lock.isLocked('a'), false);
  assert.equal(lock.tryAcquire('a'), true);
  assert.equal(lock.isLocked('b'), true);
});

test('confirmPayload renvoie argsHash strictement identique (casse comprise)', () => {
  const hash = 'A7a3406BBDF98eb104148fab4dfdfa1afde2f41860f6c31f1affbd0eec845A5F';
  const out = confirmPayload({ proposalId: '5001', argsHash: hash });
  assert.ok(out.argsHash === hash);
  assert.equal(out.proposalId, '5001');
  assert.deepEqual(Object.keys(out).sort(), ['argsHash', 'proposalId']);
});
