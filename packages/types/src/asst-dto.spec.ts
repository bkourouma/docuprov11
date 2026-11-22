import { ASST_ERROR_CODE_VALUES } from './asst-enums';
import {
  ASST_ROUTES,
  ASST_ROUTE_MENU,
  asstBrouillonArgsSchema,
  asstClarificationSchema,
  asstCanonicalActionsJson,
  asstIdSchema,
  asstImputationArgsSchema,
  asstPageContextSchema,
  asstProposedActionSchema,
  asstProposedActionsSchema,
  asstRelanceArgsSchema,
  confirmProposalBody,
  conversationIdParam,
  createConversationBody,
  isAsstProposalExpired,
  listConversationsQuery,
  postMessageBody,
  proposalIdParam,
  refuseProposalBody,
  type AsstProposedAction,
} from './asst-dto';

const imputation = {
  mailId: 12,
  recipients: [{ userGroupId: 3, mailInputationTypeId: 10, instructions: 'Pour suivi', delayDays: 5 }],
  rationale: 'Courrier relevant de la direction',
};
const relance = { mailId: 12, mailInputationId: 7, recipientUserGroupId: 3, message: 'Merci de traiter' };
const brouillon = { templateId: 'reponse-simple', label: 'Réponse', draftHtml: '<p>Bonjour</p>' };

describe('briques', () => {
  it('asstIdSchema accepte 1 à 18 chiffres uniquement', () => {
    expect(asstIdSchema.safeParse('1').success).toBe(true);
    expect(asstIdSchema.safeParse('9'.repeat(18)).success).toBe(true);
    for (const ko of ['', '0a', '-1', '1'.repeat(19), ' 1']) expect(asstIdSchema.safeParse(ko).success).toBe(false);
  });

  it('asstPageContextSchema : valide, route sans /, sujet invalide, clé inconnue', () => {
    expect(asstPageContextSchema.safeParse({ route: '/courriers/12', subjectType: 'mail', subjectId: '12' }).success).toBe(true);
    expect(asstPageContextSchema.safeParse({ route: '/' }).success).toBe(true);
    expect(asstPageContextSchema.safeParse({ route: 'courriers' }).success).toBe(false);
    expect(asstPageContextSchema.safeParse({ route: '/' + 'a'.repeat(200) }).success).toBe(false);
    expect(asstPageContextSchema.safeParse({ route: '/a', subjectType: 'Mail' }).success).toBe(false);
    expect(asstPageContextSchema.safeParse({ route: '/a', subjectType: 'a'.repeat(51) }).success).toBe(false);
    expect(asstPageContextSchema.safeParse({ route: '/a', subjectId: 'x' }).success).toBe(false);
    expect(asstPageContextSchema.safeParse({ route: '/a', consigne: 'ignore' }).success).toBe(false);
  });
});

describe('arguments d’actions', () => {
  it('imputation : cas valide, bornes de délai, de destinataires et d’instructions, clé inconnue', () => {
    expect(asstImputationArgsSchema.safeParse(imputation).success).toBe(true);
    const withRecipient = (r: object) => ({ ...imputation, recipients: [{ userGroupId: 3, mailInputationTypeId: 10, ...r }] });
    expect(asstImputationArgsSchema.safeParse(withRecipient({ delayDays: 90 })).success).toBe(true);
    expect(asstImputationArgsSchema.safeParse(withRecipient({ delayDays: 91 })).success).toBe(false);
    expect(asstImputationArgsSchema.safeParse(withRecipient({ delayDays: 0 })).success).toBe(false);
    expect(asstImputationArgsSchema.safeParse(withRecipient({ instructions: 'a'.repeat(1001) })).success).toBe(false);
    expect(asstImputationArgsSchema.safeParse(withRecipient({ extra: 1 })).success).toBe(false);
    const rec = imputation.recipients[0];
    expect(asstImputationArgsSchema.safeParse({ ...imputation, recipients: [] }).success).toBe(false);
    expect(asstImputationArgsSchema.safeParse({ ...imputation, recipients: Array(5).fill(rec) }).success).toBe(true);
    expect(asstImputationArgsSchema.safeParse({ ...imputation, recipients: Array(6).fill(rec) }).success).toBe(false);
    expect(asstImputationArgsSchema.safeParse({ ...imputation, mailId: 2_147_483_648 }).success).toBe(false);
    expect(asstImputationArgsSchema.safeParse({ ...imputation, rationale: '   ' }).success).toBe(false);
    expect(asstImputationArgsSchema.safeParse({ ...imputation, intrus: true }).success).toBe(false);
  });

  it('relance : cas valide, message borné à 500, clé inconnue', () => {
    expect(asstRelanceArgsSchema.safeParse(relance).success).toBe(true);
    expect(asstRelanceArgsSchema.safeParse({ ...relance, escalateToUserGroupId: 9 }).success).toBe(true);
    expect(asstRelanceArgsSchema.safeParse({ ...relance, message: 'a'.repeat(500) }).success).toBe(true);
    expect(asstRelanceArgsSchema.safeParse({ ...relance, message: 'a'.repeat(501) }).success).toBe(false);
    expect(asstRelanceArgsSchema.safeParse({ ...relance, message: '  ' }).success).toBe(false);
    expect(asstRelanceArgsSchema.safeParse({ ...relance, mailId: 0 }).success).toBe(false);
    expect(asstRelanceArgsSchema.safeParse({ ...relance, x: 1 }).success).toBe(false);
  });

  it('brouillon : cas valide, borne de 20000 caractères, decisionId, clé inconnue', () => {
    expect(asstBrouillonArgsSchema.safeParse(brouillon).success).toBe(true);
    expect(asstBrouillonArgsSchema.safeParse({ ...brouillon, mailId: 1, spaceId: 2, decisionId: '55' }).success).toBe(true);
    expect(asstBrouillonArgsSchema.safeParse({ ...brouillon, draftHtml: 'a'.repeat(20_000) }).success).toBe(true);
    expect(asstBrouillonArgsSchema.safeParse({ ...brouillon, draftHtml: 'a'.repeat(20_001) }).success).toBe(false);
    expect(asstBrouillonArgsSchema.safeParse({ ...brouillon, draftHtml: '' }).success).toBe(false);
    expect(asstBrouillonArgsSchema.safeParse({ ...brouillon, decisionId: 'abc' }).success).toBe(false);
    expect(asstBrouillonArgsSchema.safeParse({ ...brouillon, x: 1 }).success).toBe(false);
  });
});

describe('actions proposées', () => {
  it('accepte les trois outils', () => {
    expect(asstProposedActionSchema.safeParse({ tool: 'proposer_imputation_courrier', args: imputation }).success).toBe(true);
    expect(asstProposedActionSchema.safeParse({ tool: 'proposer_relance', args: relance }).success).toBe(true);
    expect(asstProposedActionSchema.safeParse({ tool: 'preparer_brouillon_reponse', args: brouillon }).success).toBe(true);
  });

  it('refuse la délégation, un outil inconnu, des args hors union et une clé en trop', () => {
    expect(asstProposedActionSchema.safeParse({ tool: 'proposer_delegation', args: relance }).success).toBe(false);
    expect(asstProposedActionSchema.safeParse({ tool: 'autre', args: {} }).success).toBe(false);
    expect(asstProposedActionSchema.safeParse({ tool: 'proposer_relance', args: imputation }).success).toBe(false);
    expect(asstProposedActionSchema.safeParse({ tool: 'proposer_relance', args: relance, extra: 1 }).success).toBe(false);
    expect(asstProposedActionSchema.safeParse({ args: relance }).success).toBe(false);
  });

  it('asstProposedActionsSchema : 1 à 5 actions', () => {
    const a = { tool: 'proposer_relance', args: relance };
    expect(asstProposedActionsSchema.safeParse([]).success).toBe(false);
    expect(asstProposedActionsSchema.safeParse([a]).success).toBe(true);
    expect(asstProposedActionsSchema.safeParse(Array(5).fill(a)).success).toBe(true);
    expect(asstProposedActionsSchema.safeParse(Array(6).fill(a)).success).toBe(false);
  });
});

describe('requêtes', () => {
  it('createConversationBody', () => {
    expect(createConversationBody.safeParse({}).success).toBe(true);
    expect(createConversationBody.safeParse({ title: ' Mon échange ', pageContext: { route: '/x' } }).success).toBe(true);
    expect(createConversationBody.parse({ title: ' Mon échange ' }).title).toBe('Mon échange');
    expect(createConversationBody.safeParse({ title: '' }).success).toBe(false);
    expect(createConversationBody.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
    expect(createConversationBody.safeParse({ userId: 1 }).success).toBe(false);
  });

  it('listConversationsQuery : défauts, coercition et bornes', () => {
    expect(listConversationsQuery.parse({})).toEqual({ limit: 20, offset: 0 });
    expect(listConversationsQuery.parse({ limit: '50', offset: '10' })).toEqual({ limit: 50, offset: 10 });
    expect(listConversationsQuery.parse({ offset: '1000000' }).offset).toBe(1_000_000);
    for (const bad of [{ limit: '0' }, { limit: '51' }, { limit: '1.5' }, { offset: '-1' }, { offset: '1000001' }, { limit: 'abc' }, { x: '1' }]) {
      expect(listConversationsQuery.safeParse(bad).success).toBe(false);
    }
  });

  it('conversationIdParam / proposalIdParam', () => {
    expect(conversationIdParam.safeParse('42').success).toBe(true);
    expect(proposalIdParam.safeParse('42').success).toBe(true);
    expect(conversationIdParam.safeParse('abc').success).toBe(false);
    expect(proposalIdParam.safeParse('').success).toBe(false);
  });

  it('postMessageBody : contenu 1..4000, contexte optionnel, clé inconnue', () => {
    expect(postMessageBody.safeParse({ content: 'Bonjour' }).success).toBe(true);
    expect(postMessageBody.safeParse({ content: 'a'.repeat(4000), pageContext: { route: '/a' } }).success).toBe(true);
    expect(postMessageBody.safeParse({ content: 'a'.repeat(4001) }).success).toBe(false);
    expect(postMessageBody.safeParse({ content: '   ' }).success).toBe(false);
    expect(postMessageBody.safeParse({}).success).toBe(false);
    expect(postMessageBody.safeParse({ content: 'x', role: 'assistant' }).success).toBe(false);
  });

  it('postMessageBody : refuse NUL, ESC, DEL et C1 ; accepte retours à la ligne, tabulation, accents, emoji', () => {
    for (const bad of ['a\u0000b', 'a\u001Bb', 'a\u007Fb', 'a\u0085b', 'a\u009Fb', 'a\u0008b', 'a\u000Bb', 'a\u000Cb', 'a\u001Fb']) {
      const r = postMessageBody.safeParse({ content: bad });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBe('Le texte contient des caractères de contrôle interdits.');
    }
    for (const ok of ['ligne 1\nligne 2', 'ligne 1\r\nligne 2', 'a\tb', 'Éléphant à l’œuvre', 'Bonjour 😀 👍🏽']) {
      expect(postMessageBody.safeParse({ content: ok }).success).toBe(true);
    }
    expect(postMessageBody.safeParse({ content: 'a'.repeat(4000) }).success).toBe(true);
    expect(postMessageBody.safeParse({ content: 'a'.repeat(4001) }).success).toBe(false);
  });

  it('createConversationBody.title : refuse contrôle et retours à la ligne, accepte accents et emoji', () => {
    for (const bad of ['a\u0000b', 'a\nb', 'a\rb', 'a\tb', 'a\u001Bb', 'a\u007Fb', 'a\u0090b', 'a\u0085b', 'a\u2028b', 'a\u2029b', '\u2028']) {
      expect(createConversationBody.safeParse({ title: bad }).success).toBe(false);
    }
    expect(createConversationBody.safeParse({ title: 'Courrier été 📬' }).success).toBe(true);
  });

  it('postMessageBody.content : U+2028 et U+2029 (sauts de ligne de texte libre) restent acceptés, U+0085 refusé (comportement inchangé)', () => {
    expect(postMessageBody.safeParse({ content: 'ligne 1\u2028ligne 2\u2029ligne 3' }).success).toBe(true);
    expect(postMessageBody.safeParse({ content: 'a\u0085b' }).success).toBe(false);
  });

  it('confirmProposalBody : argsHash = SHA-256 hexadécimal minuscule', () => {
    expect(confirmProposalBody.safeParse({ argsHash: 'a'.repeat(64) }).success).toBe(true);
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '']) {
      expect(confirmProposalBody.safeParse({ argsHash: bad }).success).toBe(false);
    }
    expect(confirmProposalBody.safeParse({}).success).toBe(false);
    expect(confirmProposalBody.safeParse({ argsHash: 'a'.repeat(64), x: 1 }).success).toBe(false);
  });

  it('refuseProposalBody : motif optionnel borné à 500', () => {
    expect(refuseProposalBody.safeParse({}).success).toBe(true);
    expect(refuseProposalBody.safeParse({ reason: 'Inutile' }).success).toBe(true);
    expect(refuseProposalBody.safeParse({ reason: '' }).success).toBe(false);
    expect(refuseProposalBody.safeParse({ reason: 'a'.repeat(501) }).success).toBe(false);
    expect(refuseProposalBody.safeParse({ x: 1 }).success).toBe(false);
  });
});

describe('asstCanonicalActionsJson', () => {
  it('est stable quel que soit l’ordre des clés et sans espaces', () => {
    const a = { tool: 'proposer_relance', args: { mailId: 1, mailInputationId: 2, recipientUserGroupId: 3, message: 'm' } };
    const b = { args: { message: 'm', recipientUserGroupId: 3, mailInputationId: 2, mailId: 1 }, tool: 'proposer_relance' };
    const ja = asstCanonicalActionsJson([a as AsstProposedAction]);
    expect(ja).toBe(asstCanonicalActionsJson([b as AsstProposedAction]));
    expect(ja).toBe('[{"args":{"mailId":1,"mailInputationId":2,"message":"m","recipientUserGroupId":3},"tool":"proposer_relance"}]');
  });

  it('trie récursivement (objets dans tableaux) et conserve l’ordre du tableau d’actions', () => {
    const imp: AsstProposedAction = {
      tool: 'proposer_imputation_courrier',
      args: { rationale: 'r', recipients: [{ mailInputationTypeId: 10, userGroupId: 3 }], mailId: 1 },
    };
    const rel: AsstProposedAction = { tool: 'proposer_relance', args: { ...relance } };
    expect(asstCanonicalActionsJson([imp])).toContain('"recipients":[{"mailInputationTypeId":10,"userGroupId":3}]');
    expect(asstCanonicalActionsJson([imp, rel])).not.toBe(asstCanonicalActionsJson([rel, imp]));
  });
});

describe('isAsstProposalExpired', () => {
  const exp = '2026-11-22T10:00:00.000Z';
  it('est expirée dès now >= expiresAt', () => {
    expect(isAsstProposalExpired(exp, new Date('2026-11-22T09:59:59.999Z'))).toBe(false);
    expect(isAsstProposalExpired(exp, new Date('2026-11-22T10:00:00.000Z'))).toBe(true);
    expect(isAsstProposalExpired(exp, new Date('2026-11-22T10:00:00.001Z'))).toBe(true);
  });
});

describe('ASST_ROUTES', () => {
  it('décrit les 8 routes attendues, uniques, avec leur statut de succès', () => {
    expect(ASST_ROUTE_MENU).toBe('/assistant');
    expect(ASST_ROUTES).toHaveLength(8);
    const sig = ASST_ROUTES.map((r) => `${r.method} ${r.path} ${r.successStatus}`).sort();
    expect(sig).toEqual(
      [
        'POST /assistant/conversations 201',
        'GET /assistant/conversations 200',
        'GET /assistant/conversations/:id 200',
        'POST /assistant/conversations/:id/messages 201',
        'POST /assistant/proposals/:id/confirm 200',
        'POST /assistant/proposals/:id/refuse 200',
        'GET /assistant/proposals/:id 200',
        'DELETE /assistant/conversations/:id 204',
      ].sort(),
    );
    expect(new Set(ASST_ROUTES.map((r) => r.key)).size).toBe(8);
    expect(new Set(sig).size).toBe(8);
  });

  it('référence uniquement des codes d’erreur valides, sans doublon, et le menu /assistant', () => {
    for (const route of ASST_ROUTES) {
      expect(route.menu).toBe('/assistant');
      expect(route.errors.length).toBeGreaterThan(0);
      expect(new Set(route.errors).size).toBe(route.errors.length);
      for (const code of route.errors) expect(ASST_ERROR_CODE_VALUES).toContain(code);
    }
  });
});

describe('asstClarificationSchema', () => {
  it('accepte 2 à 6 choix distincts de 80 caractères au plus, avec ou sans question', () => {
    expect(asstClarificationSchema.safeParse({ choices: ['DAF Nord', 'DAF Sud'] }).success).toBe(true);
    expect(asstClarificationSchema.safeParse({ question: 'Lequel ?', choices: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(true);
  });

  it('refuse 1 ou 7 choix, un doublon, un choix vide ou trop long, une clé inconnue', () => {
    expect(asstClarificationSchema.safeParse({ choices: ['a'] }).success).toBe(false);
    expect(asstClarificationSchema.safeParse({ choices: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).success).toBe(false);
    expect(asstClarificationSchema.safeParse({ choices: ['a', 'a'] }).success).toBe(false);
    expect(asstClarificationSchema.safeParse({ choices: ['a', '  '] }).success).toBe(false);
    expect(asstClarificationSchema.safeParse({ choices: ['a', 'x'.repeat(81)] }).success).toBe(false);
    expect(asstClarificationSchema.safeParse({ choices: ['a', 'b'], extra: 1 }).success).toBe(false);
  });
});
