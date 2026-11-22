// Tests des droits d'affichage, des formats et des entrées de navigation Docu-Flow.
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/access.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NAV } from '../../components/nav';
import {
  WF_MENU,
  canMarkLowRisk,
  canTrackInstances,
  computeWorkflowAccess,
  hasAnyWorkflowMenu,
  instanceActionRights,
} from './access';
import { dueInfo, formatConfidence, newIdempotencyKey } from './format';

test('sans profil : aucun droit', () => {
  const a = computeWorkflowAccess(null);
  assert.equal(a.canDesign || a.canLaunch || a.canAdminister || a.isAdmin, false);
  assert.equal(hasAnyWorkflowMenu(a), false);
});

test('menus : seulement ceux du rôle ; administrateur : tous ; menuKeys absent : aucun filtre', () => {
  const role = computeWorkflowAccess({ menuKeys: [WF_MENU.launch], userGroupId: 4 });
  assert.deepEqual([role.canDesign, role.canLaunch, role.canAdminister], [false, true, false]);
  const admin = computeWorkflowAccess({ isAdmin: true, menuKeys: [] });
  assert.deepEqual([admin.canDesign, admin.canLaunch, admin.canAdminister], [true, true, true]);
  assert.equal(canMarkLowRisk(admin), true);
  assert.equal(canMarkLowRisk(role), false);
  const legacy = computeWorkflowAccess({});
  assert.equal(legacy.canDesign, true);
});

test('actions sur instance : lanceur avec menu lancer, ou administration ; états respectés', () => {
  const starter = computeWorkflowAccess({ menuKeys: [WF_MENU.launch], userGroupId: 4 });
  assert.deepEqual(instanceActionRights(starter, { startedBy: 4, status: 1 }), { cancel: true, suspend: true, resume: false });
  assert.deepEqual(instanceActionRights(starter, { startedBy: 4, status: 5 }), { cancel: true, suspend: false, resume: true });
  assert.deepEqual(instanceActionRights(starter, { startedBy: 4, status: 2 }), { cancel: false, suspend: false, resume: false });
  assert.deepEqual(instanceActionRights(starter, { startedBy: 9, status: 1 }), { cancel: false, suspend: false, resume: false });
  const admin = computeWorkflowAccess({ menuKeys: [WF_MENU.admin], userGroupId: 1 });
  assert.equal(instanceActionRights(admin, { startedBy: 9, status: 0 }).cancel, true);
});

test('échéances : retard, proche, correcte, absente', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  assert.equal(dueInfo(null, now).state, 'none');
  assert.equal(dueInfo('2026-11-21T10:00:00Z', now).state, 'overdue');
  assert.match(dueInfo('2026-11-21T10:00:00Z', now).label, /^En retard de 2 h$/);
  assert.equal(dueInfo('2026-11-21T20:00:00Z', now).state, 'soon');
  assert.equal(dueInfo('2026-11-30T12:00:00Z', now).state, 'ok');
});

test('confiance et clé d’idempotence', () => {
  assert.equal(formatConfidence('0.8500'), '85 %');
  assert.equal(formatConfidence(null), null);
  assert.equal(formatConfidence('abc'), null);
  const k = newIdempotencyKey();
  assert.ok(k.length > 6 && k.length <= 200);
  assert.notEqual(k, newIdempotencyKey());
});

test('suivi des instances : menu lancer ou administration (la conception seule ne suffit pas)', () => {
  assert.equal(canTrackInstances(computeWorkflowAccess({ menuKeys: [WF_MENU.design] })), false);
  assert.equal(canTrackInstances(computeWorkflowAccess({ menuKeys: [WF_MENU.launch] })), true);
  assert.equal(canTrackInstances(computeWorkflowAccess({ menuKeys: [WF_MENU.admin] })), true);
});

test('navigation : entrées Docu-Flow alignées sur les menus du catalogue des rôles', () => {
  const section = NAV.find((s) => s.label === 'Docu-Flow');
  assert.ok(section);
  const keys = section.items.map((i) => i.key);
  for (const menu of Object.values(WF_MENU)) assert.ok(keys.includes(menu), `entrée manquante : ${menu}`);
  const altOf = (k: string) =>
    [...((section.items.find((i) => i.key === k) as { altKeys?: string[] } | undefined)?.altKeys ?? [])].sort();
  // Boîte : sans menu propre, ouverte par n'importe quel menu Docu-Flow.
  assert.deepEqual(altOf('/workflows/boite'), Object.values(WF_MENU).sort());
  // Suivi : GET /workflows/instances exige le menu lancer ou administration (jamais la conception seule).
  assert.deepEqual(altOf('/workflows/instances'), [WF_MENU.launch, WF_MENU.admin].sort());
});
