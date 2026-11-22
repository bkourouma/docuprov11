import {
  actionsFromJson,
  pageContextFromJson,
  parseAsstId,
  resultFromJson,
  toConversationDto,
  toMessageDto,
  toProposalDto,
  type AsstProposalRow,
} from './asst-store.mappers';

const D = new Date('2026-11-22T10:00:00.000Z');

const proposalRow = (over: Partial<AsstProposalRow> = {}): AsstProposalRow => ({
  asstProposalId: 12n,
  conversationId: 3n,
  messageId: 7n,
  status: 0,
  actions: [{ tool: 'relance', args: {} }],
  summary: 'Résumé',
  argsHash: 'a'.repeat(64),
  expiresAt: D,
  createdAt: D,
  confirmedAt: null,
  finishedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  rowVersion: 0,
  ...over,
});

describe('asst-store.mappers', () => {
  it('expose les BigInt en chaînes et les dates en ISO UTC (conversation)', () => {
    const dto = toConversationDto(
      {
        asstConversationId: 42n,
        title: 'T',
        pageContext: { route: '/courriers', subjectType: 'mail', subjectId: '5' },
        createdAt: D,
        updatedAt: D,
        lastMessageAt: D,
        purgeAt: D,
      },
      3,
    );
    expect(dto).toEqual({
      conversationId: '42',
      title: 'T',
      pageContext: { route: '/courriers', subjectType: 'mail', subjectId: '5' },
      createdAt: '2026-11-22T10:00:00.000Z',
      updatedAt: '2026-11-22T10:00:00.000Z',
      lastMessageAt: '2026-11-22T10:00:00.000Z',
      purgeAt: '2026-11-22T10:00:00.000Z',
      messageCount: 3,
    });
  });

  it('relit pageContext par le schéma : invalide ou absent -> null', () => {
    expect(pageContextFromJson({ route: 'sans-slash' })).toBeNull();
    expect(pageContextFromJson({ route: '/x', extra: 1 })).toBeNull();
    expect(pageContextFromJson('texte')).toBeNull();
    expect(pageContextFromJson(null)).toBeNull();
    expect(pageContextFromJson({ route: '/x' })).toEqual({ route: '/x' });
  });

  it('actions : tableau d’objets avec tool, sinon tableau vide', () => {
    expect(actionsFromJson([{ tool: 'a', args: {} }])).toHaveLength(1);
    expect(actionsFromJson('x')).toEqual([]);
    expect(actionsFromJson([{ args: {} }])).toEqual([]);
    expect(actionsFromJson([1])).toEqual([]);
  });

  it('result : objet avec effects, sinon null', () => {
    expect(resultFromJson({ effects: [] })).toEqual({ effects: [] });
    expect(resultFromJson({})).toBeNull();
    expect(resultFromJson(null)).toBeNull();
    expect(resultFromJson([])).toBeNull();
  });

  it('proposition : champs nuls conservés, dates ISO', () => {
    const dto = toProposalDto(proposalRow({ status: 2, confirmedAt: D, finishedAt: D, result: { effects: [] }, rowVersion: 2 }));
    expect(dto.proposalId).toBe('12');
    expect(dto.conversationId).toBe('3');
    expect(dto.messageId).toBe('7');
    expect(dto.confirmedAt).toBe('2026-11-22T10:00:00.000Z');
    expect(dto.result).toEqual({ effects: [] });
    expect(dto.rowVersion).toBe(2);
  });

  it('message : propositions jointes, aucun jeton exposé', () => {
    const dto = toMessageDto(
      { asstMessageId: 9n, conversationId: 3n, role: 1, content: 'ok', position: 2, createdAt: D },
      [proposalRow()],
    );
    expect(dto.messageId).toBe('9');
    expect(dto.proposals).toHaveLength(1);
    expect(Object.keys(dto)).not.toContain('promptTokens');
  });

  it('parseAsstId : 1 à 18 chiffres seulement', () => {
    expect(parseAsstId('123456789012345678')).toBe(123456789012345678n);
    expect(parseAsstId('1234567890123456789')).toBeNull();
    expect(parseAsstId('')).toBeNull();
    expect(parseAsstId('12a')).toBeNull();
    expect(parseAsstId('-1')).toBeNull();
    expect(parseAsstId(12)).toBeNull();
  });
});
