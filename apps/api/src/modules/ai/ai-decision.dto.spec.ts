import { AI_DECISION_MAX_PAGE_SIZE, listAiDecisionsQuerySchema } from './ai-decision.dto';

describe('listAiDecisionsQuerySchema', () => {
  it('coerce des chaînes valides en entiers', () => {
    expect(
      listAiDecisionsQuerySchema.parse({ status: '0', task: '7', documentId: '12', page: '2', pageSize: '50' }),
    ).toEqual({ status: 0, task: 7, documentId: 12, page: 2, pageSize: 50 });
  });

  it('accepte une requête vide', () => {
    expect(listAiDecisionsQuerySchema.parse({})).toEqual({});
  });

  it.each(['status', 'task', 'documentId', 'page', 'pageSize'])('%s : chaîne vide ou blanche refusée', (k) => {
    expect(listAiDecisionsQuerySchema.safeParse({ [k]: '' }).success).toBe(false);
    expect(listAiDecisionsQuerySchema.safeParse({ [k]: '  ' }).success).toBe(false);
  });

  it('refuse les valeurs hors bornes ou non entières', () => {
    const bad = [
      { status: '5' },
      { task: '8' },
      { documentId: '0' },
      { page: '0' },
      { pageSize: String(AI_DECISION_MAX_PAGE_SIZE + 1) },
      { page: '1.5' },
      { status: 'abc' },
    ];
    for (const q of bad) expect(listAiDecisionsQuerySchema.safeParse(q).success).toBe(false);
  });
});
