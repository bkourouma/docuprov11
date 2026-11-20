// Auto-test de whatsapp-config.ts (le paquet web n'a pas de runner de tests).
// Lancer : pnpm --filter @archivage/web exec tsx app/connecteurs/_components/whatsapp-config.selftest.ts
import assert from 'node:assert/strict';
import type { GedConnectorView } from '@archivage/types';
import {
  buildWhatsappPayload,
  maskWhatsappPhone,
  normalizeWhatsappPhone,
  readWhatsappValues,
  whatsappWebhookUrl,
  type WhatsappFormValues,
} from './whatsapp-config';

// Normalisation
assert.deepEqual(normalizeWhatsappPhone('+221 77-123.45 (67)'), {
  ok: true,
  phone: '221771234567',
});
assert.equal(normalizeWhatsappPhone('0771234567').ok, false);
assert.equal(normalizeWhatsappPhone('1234567').ok, false);
assert.equal(normalizeWhatsappPhone('1234567890123456').ok, false);
assert.equal(normalizeWhatsappPhone('22a771234567').ok, false);
assert.equal(normalizeWhatsappPhone('   ').ok, false);

// Masquage
assert.equal(maskWhatsappPhone('221771234567'), '+221 •• ••• •• 67');
assert.ok(!maskWhatsappPhone('221771234567').includes('1234'));
assert.equal(maskWhatsappPhone('abc'), '••••');

const base: WhatsappFormValues = {
  phoneNumberId: ' 1098765432 ',
  graphApiVersion: '',
  maxFileMio: 10,
  ackEnabled: true,
  refuseUnknownSenders: false,
  senders: [
    { phone: '+221 77 123 45 67', label: ' Compta ', userGroupId: 4 },
    { phone: '33612345678', label: '', userGroupId: null },
  ],
  fallbackGroupIds: [3, '7', 3],
  secrets: { accessToken: 'a', appSecret: 'b', verifyToken: 'c' },
};

// Création
const created = buildWhatsappPayload(base, { editing: false });
assert.ok(created.ok);
if (created.ok) {
  const p = created.payload;
  assert.equal(p.mode, 0);
  assert.equal(p.syncIntervalMinutes, null);
  assert.deepEqual(p.credentials, { accessToken: 'a', appSecret: 'b', verifyToken: 'c' });
  assert.equal(p.config.phoneNumberId, '1098765432');
  assert.equal(p.config.maxFileBytes, 10 * 1024 * 1024);
  assert.ok(!('graphApiVersion' in p.config));
  assert.deepEqual(p.config.senders, [
    { phone: '221771234567', label: 'Compta' },
    { phone: '33612345678' },
  ]);
  assert.deepEqual(p.config.rights, {
    principalMap: { 'wa:221771234567': 4 },
    fallbackUserGroupIds: [3, 7],
  });
}

// Doublon (après normalisation) et repli vide
const dup = buildWhatsappPayload(
  {
    ...base,
    senders: [{ phone: '221771234567' }, { phone: '+221 77 123 45 67' }],
    fallbackGroupIds: [],
  },
  { editing: false },
);
assert.ok(!dup.ok);
if (!dup.ok) assert.equal(dup.errors.length, 2);

// Création sans secrets : refusée
assert.ok(!buildWhatsappPayload({ ...base, secrets: {} }, { editing: false }).ok);

// Édition : sans « Remplacer les secrets », pas de credentials
const keep = buildWhatsappPayload({ ...base, secrets: {} }, { editing: true });
assert.ok(keep.ok);
if (keep.ok) assert.ok(!('credentials' in keep.payload));
// Remplacement incomplet : refusé ; complet : envoyé
assert.ok(
  !buildWhatsappPayload(
    { ...base, replaceSecrets: true, secrets: { accessToken: 'a' } },
    { editing: true },
  ).ok,
);
const repl = buildWhatsappPayload({ ...base, replaceSecrets: true }, { editing: true });
assert.ok(repl.ok && repl.payload.credentials !== undefined);

// Aller-retour
assert.ok(created.ok);
if (created.ok) {
  const view = {
    gedSourceConnectorId: 9,
    config: { ...created.payload.config, futureKey: 1 },
    hasCredentials: true,
  } as unknown as GedConnectorView;
  const back = readWhatsappValues(view);
  assert.deepEqual(back.secrets, {});
  assert.equal(back.replaceSecrets, false);
  assert.equal(back.maxFileMio, 10);
  assert.deepEqual(back.fallbackGroupIds, [3, 7]);
  assert.deepEqual(back.senders, [
    { phone: '221771234567', label: 'Compta', userGroupId: 4 },
    { phone: '33612345678', label: '', userGroupId: null },
  ]);
  const again = buildWhatsappPayload(back, { editing: true, existingConfig: view.config });
  assert.ok(again.ok);
  if (again.ok) {
    assert.equal(again.payload.config.futureKey, 1);
    assert.deepEqual(
      { ...again.payload.config, futureKey: undefined },
      { ...created.payload.config, futureKey: undefined },
    );
  }
}

// Webhook
assert.deepEqual(whatsappWebhookUrl(5, '/api'), {
  url: '/api/ged/webhooks/whatsapp/5',
  complete: false,
});
assert.deepEqual(whatsappWebhookUrl(5, 'https://api.exemple.fr/api'), {
  url: 'https://api.exemple.fr/api/ged/webhooks/whatsapp/5',
  complete: true,
});

console.log('whatsapp-config : OK');
