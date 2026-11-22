import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchInstanceSchema } from './workflows.dto';
import { WF_TRIGGER_IDEMPOTENCY_PREFIX, isReservedTriggerIdempotencyKey } from './extension/trigger-idempotency';

const parse = (idempotencyKey?: string) =>
  launchInstanceSchema.safeParse({ definitionId: 1, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });

describe('launchInstanceSchema : clé d\'idempotence réservée', () => {
  it.each(['trg:1:x', 'TRG:1', ' trg:', ' trg:1', '﻿trg:1', '	trg:1'])('refuse la clé réservée %j', (key) => {
    const res = parse(key);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(['idempotencyKey']);
      expect(res.error.issues[0]?.message).toBe("Ce préfixe de clé d'idempotence est réservé aux déclencheurs.");
    }
  });

  it.each(['manuel-42', 'trigger:1'])('accepte la clé %j', (key) => {
    expect(parse(key).success).toBe(true);
  });

  it('accepte l\'absence de clé', () => {
    expect(parse().success).toBe(true);
  });

  it('la clé du démarreur (trg:...) n’est refusée que par la route publique, jamais côté moteur', () => {
    expect(isReservedTriggerIdempotencyKey(`${WF_TRIGGER_IDEMPOTENCY_PREFIX}7:mail.arrived:mail:42`)).toBe(true);
    for (const file of ['engine/engine.ts', 'instances.service.ts', 'extension/trigger-starter.ts']) {
      expect(readFileSync(join(__dirname, file), 'utf8')).not.toContain('isReservedTriggerIdempotencyKey');
    }
  });
});
