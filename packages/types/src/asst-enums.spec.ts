import {
  ASST_ACTION_TOOL_VALUES,
  ASST_ERROR_CODE_VALUES,
  ASST_ERROR_HTTP_STATUS,
  ASST_PROPOSAL_STATUS_VALUES,
  ASST_PROPOSAL_TRANSITIONS,
  ASST_PROPOSAL_TTL_MINUTES,
  ASST_RETENTION_DAYS,
  AsstErrorCode,
  AsstMessageRole,
  AsstProposalStatus,
  isAsstErrorCode,
  isAsstProposalStatus,
  isAsstProposalTerminal,
  isAsstProposalTransitionAllowed,
} from './asst-enums';

describe('asst-enums', () => {
  it('fige les valeurs numériques des statuts (0..5) et des rôles', () => {
    expect(AsstProposalStatus).toEqual({ Proposed: 0, Confirmed: 1, Applied: 2, Refused: 3, Expired: 4, Failed: 5 });
    expect([...ASST_PROPOSAL_STATUS_VALUES]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(AsstMessageRole).toEqual({ User: 0, Assistant: 1 });
    expect(isAsstProposalStatus(5)).toBe(true);
    expect(isAsstProposalStatus(6)).toBe(false);
    expect(isAsstProposalStatus('0')).toBe(false);
  });

  it('autorise EXACTEMENT les transitions 0->1, 0->3, 0->4, 1->2, 1->5', () => {
    const legal: string[] = [];
    for (const from of ASST_PROPOSAL_STATUS_VALUES) {
      for (const to of ASST_PROPOSAL_STATUS_VALUES) {
        if (isAsstProposalTransitionAllowed(from, to)) legal.push(`${from}->${to}`);
      }
    }
    expect(legal.sort()).toEqual(['0->1', '0->3', '0->4', '1->2', '1->5']);
    expect(Object.keys(ASST_PROPOSAL_TRANSITIONS)).toHaveLength(6);
  });

  it('identifie les statuts terminaux (2, 3, 4, 5)', () => {
    const terminals = ASST_PROPOSAL_STATUS_VALUES.filter((s) => isAsstProposalTerminal(s));
    expect(terminals).toEqual([2, 3, 4, 5]);
  });

  it('associe un statut HTTP à chaque code d’erreur', () => {
    expect(ASST_ERROR_HTTP_STATUS).toEqual({
      not_implemented: 501,
      not_found: 404,
      identity_refused: 403,
      proposal_expired: 409,
      proposal_not_pending: 409,
      conflict: 409,
      effect_forbidden: 403,
      effect_failed: 422,
      budget_exceeded: 429,
      assistant_unavailable: 503,
      invalid_input: 422,
    });
    expect(Object.keys(ASST_ERROR_HTTP_STATUS).sort()).toEqual([...ASST_ERROR_CODE_VALUES].sort());
    expect(isAsstErrorCode(AsstErrorCode.Conflict)).toBe(true);
    expect(isAsstErrorCode('autre')).toBe(false);
  });

  it('limite les outils aux clés du catalogue (valeurs en dur), sans délégation', () => {
    expect([...ASST_ACTION_TOOL_VALUES].sort()).toEqual([
      'preparer_brouillon_reponse',
      'proposer_imputation_courrier',
      'proposer_relance',
    ]);
    expect(ASST_ACTION_TOOL_VALUES as readonly string[]).not.toContain('proposer_delegation');
  });

  it('fixe le TTL à 15 minutes et la rétention à 90 jours', () => {
    expect(ASST_PROPOSAL_TTL_MINUTES).toBe(15);
    expect(ASST_RETENTION_DAYS).toBe(90);
  });
});
