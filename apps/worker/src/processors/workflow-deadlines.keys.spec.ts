// Docu-Flow W3 - la clé d'idempotence du worker doit être IDENTIQUE à celle de l'API (valeurs d'or communes).
import { triggerIdempotencyKey } from './workflow-deadlines.keys';

describe('triggerIdempotencyKey (worker)', () => {
  it('échéance : avec occurrence', () => {
    expect(
      triggerIdempotencyKey(7, {
        type: 'deadline.reached',
        subjectType: 'mail',
        subjectId: '42',
        occurrenceKey: '2026-11-21',
      }),
    ).toBe('trg:7:deadline.reached:mail:42:2026-11-21');
  });

  it('courrier arrivé : sans occurrence', () => {
    expect(triggerIdempotencyKey(7, { type: 'mail.arrived', subjectType: 'mail', subjectId: '42' })).toBe(
      'trg:7:mail.arrived:mail:42',
    );
  });

  it('seuil : sans occurrence', () => {
    expect(triggerIdempotencyKey(3, { type: 'threshold.crossed', subjectType: 'document', subjectId: '900' })).toBe(
      'trg:3:threshold.crossed:document:900',
    );
  });
});
