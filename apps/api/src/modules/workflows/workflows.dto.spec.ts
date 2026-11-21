import {
  bigintIdSchema,
  completeTaskSchema,
  delegateTaskSchema,
  instanceReasonSchema,
  launchInstanceSchema,
  listInboxQuerySchema,
  listInstancesQuerySchema,
} from './workflows.dto';

describe('workflows.dto', () => {
  it('identifiant BigInt : chiffres seulement, 18 max', () => {
    expect(bigintIdSchema.safeParse('123').success).toBe(true);
    for (const bad of ['', '0x1', '-1', '1.5', 'abc', '1'.repeat(19)]) {
      expect(bigintIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('lancement : clé d’idempotence bornée à 200, objet lié en paire, champs inconnus refusés', () => {
    expect(launchInstanceSchema.safeParse({ definitionId: 1, idempotencyKey: 'x'.repeat(200) }).success).toBe(true);
    expect(launchInstanceSchema.safeParse({ definitionId: 1, idempotencyKey: 'x'.repeat(201) }).success).toBe(false);
    expect(launchInstanceSchema.safeParse({ definitionId: 1, subjectType: 'document' }).success).toBe(false);
    expect(launchInstanceSchema.safeParse({ definitionId: 1, subjectType: 'document', subjectId: '3' }).success).toBe(true);
    expect(launchInstanceSchema.safeParse({ definitionId: 1, startedBy: 9 }).success).toBe(false);
    expect(launchInstanceSchema.safeParse({ definitionId: 0 }).success).toBe(false);
  });

  it('listes : défauts de pagination, statut validé', () => {
    expect(listInstancesQuerySchema.parse({})).toMatchObject({ limit: 25, offset: 0 });
    expect(listInstancesQuerySchema.safeParse({ status: '9' }).success).toBe(false);
    expect(listInstancesQuerySchema.parse({ status: '2', mine: 'true' })).toMatchObject({ status: 2, mine: true });
    expect(listInstancesQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(listInboxQuerySchema.parse({ status: '0,1,1' }).status).toEqual([0, 1]);
    expect(listInboxQuerySchema.safeParse({ status: '7' }).success).toBe(false);
  });

  it('corps : complete exige result ; delegate exige un destinataire ; raison facultative', () => {
    expect(completeTaskSchema.safeParse({}).success).toBe(false);
    expect(completeTaskSchema.safeParse({ result: { approved: true }, expectedRowVersion: 2 }).success).toBe(true);
    expect(delegateTaskSchema.safeParse({}).success).toBe(false);
    expect(instanceReasonSchema.parse(undefined)).toEqual({});
  });
});
