import { wfEscalationConfigSchema } from './wf-dto';

describe('wfEscalationConfigSchema', () => {
  const base = { assignee: { kind: 'group', id: 3 }, dueInHours: 24 };

  it('accepte une configuration valide, avec ou sans options', () => {
    expect(wfEscalationConfigSchema.safeParse(base).success).toBe(true);
    expect(wfEscalationConfigSchema.safeParse({ ...base, maxEscalations: 2, message: 'Urgent' }).success).toBe(true);
  });

  it('refuse l’absence de dueInHours ou une valeur non positive / non entière', () => {
    expect(wfEscalationConfigSchema.safeParse({ assignee: base.assignee }).success).toBe(false);
    expect(wfEscalationConfigSchema.safeParse({ ...base, dueInHours: 0 }).success).toBe(false);
    expect(wfEscalationConfigSchema.safeParse({ ...base, dueInHours: 1.5 }).success).toBe(false);
  });

  it('borne dueInHours à un an (8760 h)', () => {
    expect(wfEscalationConfigSchema.safeParse({ ...base, dueInHours: 8760 }).success).toBe(true);
    expect(wfEscalationConfigSchema.safeParse({ ...base, dueInHours: 8761 }).success).toBe(false);
  });

  it('refuse un type de bénéficiaire inconnu, un id invalide ou une clé en trop', () => {
    expect(wfEscalationConfigSchema.safeParse({ ...base, assignee: { kind: 'initiator', id: 1 } }).success).toBe(false);
    expect(wfEscalationConfigSchema.safeParse({ ...base, assignee: { kind: 'user', id: 0 } }).success).toBe(false);
    expect(wfEscalationConfigSchema.safeParse({ ...base, assignee: { kind: 'user', id: 1, x: 1 } }).success).toBe(false);
  });

  it('borne maxEscalations à [1, 5]', () => {
    for (const ok of [1, 5]) expect(wfEscalationConfigSchema.safeParse({ ...base, maxEscalations: ok }).success).toBe(true);
    for (const ko of [0, 6, 2.5]) expect(wfEscalationConfigSchema.safeParse({ ...base, maxEscalations: ko }).success).toBe(false);
  });

  it('limite le message à 500 caractères', () => {
    expect(wfEscalationConfigSchema.safeParse({ ...base, message: 'a'.repeat(501) }).success).toBe(false);
  });
});
