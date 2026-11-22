import 'reflect-metadata';
import { ASST_MESSAGE_MAX_CHARS, ASST_TITLE_MAX_CHARS } from '@archivage/types';
import { AsstError } from '../assistant.contracts';
import {
  asstProposedActionSchema,
  asstProposedActionsSchema,
  asstZodPipe,
  confirmProposalBody,
  confirmProposalPipe,
  conversationIdParam,
  conversationIdPipe,
  createConversationBody,
  listConversationsQuery,
  listConversationsPipe,
  postMessageBody,
  proposalIdPipe,
  refuseProposalBody,
  refuseProposalPipe,
} from './assistant.dto';

const HASH = 'f'.repeat(64);
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe('dto assistant : schémas ré-exportés', () => {
  it('createConversationBody : titre et contexte optionnels, strict', () => {
    expect(ok(createConversationBody, {})).toBe(true);
    expect(createConversationBody.parse({ title: '  t  ' })).toEqual({ title: 't' });
    expect(ok(createConversationBody, { title: 'x'.repeat(ASST_TITLE_MAX_CHARS) })).toBe(true);
    expect(ok(createConversationBody, { title: 'x'.repeat(ASST_TITLE_MAX_CHARS + 1) })).toBe(false);
    expect(ok(createConversationBody, { title: '   ' })).toBe(false);
    expect(ok(createConversationBody, { userId: 3 })).toBe(false);
    expect(ok(createConversationBody, { pageContext: { route: 'sans-slash' } })).toBe(false);
    expect(ok(createConversationBody, { pageContext: { route: '/x', subjectId: 'abc' } })).toBe(false);
  });

  it('listConversationsQuery : défauts, coercition et bornes', () => {
    expect(listConversationsQuery.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(listConversationsQuery.parse({ limit: '50', offset: '3' })).toEqual({ limit: 50, offset: 3 });
    expect(ok(listConversationsQuery, { limit: '0' })).toBe(false);
    expect(ok(listConversationsQuery, { limit: '51' })).toBe(false);
    expect(ok(listConversationsQuery, { offset: '-1' })).toBe(false);
    expect(ok(listConversationsQuery, { autre: '1' })).toBe(false);
  });

  it('identifiants : 1 à 18 chiffres', () => {
    expect(ok(conversationIdParam, '1')).toBe(true);
    expect(ok(conversationIdParam, '9'.repeat(18))).toBe(true);
    expect(ok(conversationIdParam, '9'.repeat(19))).toBe(false);
    expect(ok(conversationIdParam, '')).toBe(false);
    expect(ok(conversationIdParam, '1a')).toBe(false);
    expect(ok(conversationIdParam, '-1')).toBe(false);
  });

  it('postMessageBody : contenu obligatoire, borné, rogné', () => {
    expect(postMessageBody.parse({ content: ' salut ' })).toEqual({ content: 'salut' });
    expect(ok(postMessageBody, { content: 'x'.repeat(ASST_MESSAGE_MAX_CHARS) })).toBe(true);
    expect(ok(postMessageBody, { content: 'x'.repeat(ASST_MESSAGE_MAX_CHARS + 1) })).toBe(false);
    expect(ok(postMessageBody, { content: '  ' })).toBe(false);
    expect(ok(postMessageBody, {})).toBe(false);
    expect(ok(postMessageBody, { content: 'a', userId: 1 })).toBe(false);
  });

  it('confirmProposalBody : empreinte SHA-256 hexadécimale minuscule', () => {
    expect(ok(confirmProposalBody, { argsHash: HASH })).toBe(true);
    expect(ok(confirmProposalBody, { argsHash: 'F'.repeat(64) })).toBe(false);
    expect(ok(confirmProposalBody, { argsHash: 'f'.repeat(63) })).toBe(false);
    expect(ok(confirmProposalBody, {})).toBe(false);
    expect(ok(confirmProposalBody, { argsHash: HASH, extra: 1 })).toBe(false);
  });

  it('refuseProposalBody : motif facultatif, 500 caractères au plus', () => {
    expect(ok(refuseProposalBody, {})).toBe(true);
    expect(ok(refuseProposalBody, { reason: 'x'.repeat(500) })).toBe(true);
    expect(ok(refuseProposalBody, { reason: 'x'.repeat(501) })).toBe(false);
    expect(ok(refuseProposalBody, { reason: ' ' })).toBe(false);
  });

  it('actions proposées : union discriminée, 1 à 5 actions, délégation exclue', () => {
    const relance = {
      tool: 'proposer_relance',
      args: { mailId: 1, mailInputationId: 2, recipientUserGroupId: 3, message: 'Merci de traiter.' },
    };
    expect(ok(asstProposedActionSchema, relance)).toBe(true);
    expect(ok(asstProposedActionSchema, { tool: 'proposer_delegation', args: {} })).toBe(false);
    expect(ok(asstProposedActionsSchema, [])).toBe(false);
    expect(ok(asstProposedActionsSchema, Array(5).fill(relance))).toBe(true);
    expect(ok(asstProposedActionsSchema, Array(6).fill(relance))).toBe(false);
  });
});

describe('dto assistant : pipes', () => {
  const thrown = (fn: () => unknown): AsstError => {
    try {
      fn();
    } catch (e) {
      return e as AsstError;
    }
    throw new Error('aucune erreur levée');
  };

  it('une entrée valide traverse le pipe (sortie parsée)', () => {
    expect(conversationIdPipe.transform('12')).toBe('12');
    expect(proposalIdPipe.transform('12')).toBe('12');
    expect(listConversationsPipe.transform({})).toEqual({ limit: 20, offset: 0 });
    expect(confirmProposalPipe.transform({ argsHash: HASH })).toEqual({ argsHash: HASH });
    expect(refuseProposalPipe.transform({ reason: ' non ' })).toEqual({ reason: 'non' });
  });

  it('une entrée invalide lève AsstError invalid_input avec le détail des champs', () => {
    const err = thrown(() => confirmProposalPipe.transform({ argsHash: 'x', extra: true }));
    expect(err).toBeInstanceOf(AsstError);
    expect(err.errorCode).toBe('invalid_input');
    expect(Array.isArray(err.details)).toBe(true);
    expect((err.details as { path: string; message: string }[]).map((d) => d.path)).toEqual(
      expect.arrayContaining(['argsHash']),
    );
  });

  it('asstZodPipe : racine nommée « (root) »', () => {
    const err = thrown(() => asstZodPipe(conversationIdParam).transform(12));
    expect(err.details).toEqual([{ path: '(root)', message: expect.any(String) }]);
  });
});
