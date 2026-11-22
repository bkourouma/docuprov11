// Le service de rédaction tire l'éditeur (ESM) : doublé ici, seule son interface compte.
jest.mock('../../drafting/drafting.service', () => ({ DraftingService: class {} }));

import { AgentBlockedError, AgentIdentityError, type AgentReservation } from '../agent.contracts';
import { createGenerationSuggestionExecutor } from '../../workflows/extension/generation-suggester';
import type { WfExecutorContext } from '../../workflows/engine/engine.types';
import { DraftingGenerationSuggester } from './drafting-generation-suggester';

const user = { userId: 7, username: 'lanceur', isAdmin: false, userGroupId: 70 };
const reservation: AgentReservation = {
  id: 'r1',
  definitionId: 3,
  reserved: { promptTokens: 4000, completionTokens: 3000, cost: 1 },
};
const okResponse = {
  disabled: false,
  templateId: 'courrier',
  draftHtml: '<p>Bonjour</p>',
  draftText: 'Bonjour',
  contextDocumentCount: 2,
  decisionId: '1',
  provider: 'p',
  model: 'm',
  notice: 'n',
};

function setup() {
  const drafting = { generate: jest.fn().mockResolvedValue(okResponse) };
  const identity = { resolve: jest.fn().mockResolvedValue({ principal: {}, user }) };
  const gate = {
    assertRunnable: jest.fn().mockResolvedValue(undefined),
    reserve: jest.fn().mockResolvedValue(reservation),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    costOf: jest.fn().mockReturnValue(1),
  };
  const s = new DraftingGenerationSuggester(drafting as never, identity as never, gate as never);
  return { s, drafting, identity, gate };
}

const input = (inp: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
  instanceId: '1',
  taskId: '2',
  stepKey: 'redaction',
  context: inp === undefined ? {} : { input: inp },
  runAs: { userGroupId: 70 },
  definitionId: 3,
  ...over,
});
const valid = { templateId: 'courrier', instruction: 'Rédige une réponse', contextDocumentIds: [11, 12] };

describe('DraftingGenerationSuggester', () => {
  it('chemin nominal : identité du lanceur, garde, réservation, règlement, sources, pas de confiance', async () => {
    const { s, drafting, identity, gate } = setup();
    const r = await s.suggest(input(valid));
    expect(identity.resolve).toHaveBeenCalledWith(70);
    expect(gate.assertRunnable).toHaveBeenCalledWith({ definitionId: 3 });
    expect(gate.reserve).toHaveBeenCalledWith(
      { definitionId: 3 },
      expect.objectContaining({ promptTokens: 4000, completionTokens: 3000 }),
    );
    expect(drafting.generate).toHaveBeenCalledWith(
      { templateId: 'courrier', instruction: 'Rédige une réponse', contextDocumentIds: [11, 12] },
      user,
    );
    expect(gate.settle).toHaveBeenCalledWith(reservation, expect.objectContaining({ promptTokens: 4000 }));
    expect(gate.release).not.toHaveBeenCalled();
    expect(r.content).toBe('Bonjour');
    expect(r.explanation).toContain('à relire');
    expect(r.sources).toEqual([
      { kind: 'document', id: 11 },
      { kind: 'document', id: 12 },
    ]);
    expect(r.confidence).toBeUndefined();
  });

  it('transmet dossierId', async () => {
    const { s, drafting } = setup();
    await s.suggest(input({ templateId: 'vide', instruction: 'abc', dossierId: 5 }));
    expect(drafting.generate).toHaveBeenCalledWith({ templateId: 'vide', instruction: 'abc', dossierId: 5 }, user);
  });

  it.each([
    ['contexte sans input', undefined],
    ['templateId manquant', { instruction: 'abc' }],
    ['templateId non texte', { templateId: 5, instruction: 'abc' }],
    ['instruction manquante', { templateId: 'courrier' }],
    ['instruction vide', { templateId: 'courrier', instruction: '   ' }],
    ['instruction trop longue', { templateId: 'courrier', instruction: 'x'.repeat(2001) }],
    ['templateId invalide', { templateId: 'Mauvais Id', instruction: 'abc' }],
    ['trop de documents', { templateId: 'courrier', instruction: 'abc', contextDocumentIds: [1, 2, 3, 4, 5, 6] }],
    ['identifiant de document invalide', { templateId: 'courrier', instruction: 'abc', contextDocumentIds: [0] }],
    ['identifiant non entier', { templateId: 'courrier', instruction: 'abc', contextDocumentIds: ['1'] }],
  ])('paramètres invalides (%s) : erreur, aucun appel', async (_n, inp) => {
    const { s, drafting, gate } = setup();
    await expect(s.suggest(input(inp as never))).rejects.toThrow();
    expect(drafting.generate).not.toHaveBeenCalled();
    expect(gate.reserve).not.toHaveBeenCalled();
  });

  it('identité refusée : erreur relancée, rien d’appelé', async () => {
    const { s, identity, drafting, gate } = setup();
    identity.resolve.mockRejectedValue(new AgentIdentityError('disabled', 'compte désactivé'));
    await expect(s.suggest(input(valid))).rejects.toBeInstanceOf(AgentIdentityError);
    expect(gate.assertRunnable).not.toHaveBeenCalled();
    expect(drafting.generate).not.toHaveBeenCalled();
  });

  it('definitionId absent : erreur, generate non appelé', async () => {
    const { s, drafting } = setup();
    await expect(s.suggest(input(valid, { definitionId: undefined }))).rejects.toThrow();
    expect(drafting.generate).not.toHaveBeenCalled();
  });

  it('garde qui refuse : generate non appelé, rien réservé', async () => {
    const { s, gate, drafting } = setup();
    gate.assertRunnable.mockRejectedValue(new AgentBlockedError('emergency_stop_global', 'arrêt'));
    await expect(s.suggest(input(valid))).rejects.toBeInstanceOf(AgentBlockedError);
    expect(gate.reserve).not.toHaveBeenCalled();
    expect(drafting.generate).not.toHaveBeenCalled();
  });

  it('réservation refusée : generate non appelé', async () => {
    const { s, gate, drafting } = setup();
    gate.reserve.mockRejectedValue(new AgentBlockedError('budget_exceeded_global', 'plafond'));
    await expect(s.suggest(input(valid))).rejects.toBeInstanceOf(AgentBlockedError);
    expect(drafting.generate).not.toHaveBeenCalled();
  });

  it('échec de generate (ex. 404 uniforme) : release, pas de settle, erreur relancée', async () => {
    const { s, gate, drafting } = setup();
    drafting.generate.mockRejectedValue(new Error('404'));
    await expect(s.suggest(input(valid))).rejects.toThrow('404');
    expect(gate.release).toHaveBeenCalledWith(reservation);
    expect(gate.settle).not.toHaveBeenCalled();
  });

  it('réponse disabled : erreur et réservation libérée', async () => {
    const { s, gate, drafting } = setup();
    drafting.generate.mockResolvedValue({ disabled: true, message: 'IA désactivée' });
    await expect(s.suggest(input(valid))).rejects.toThrow();
    expect(gate.release).toHaveBeenCalledWith(reservation);
    expect(gate.settle).not.toHaveBeenCalled();
  });

  it('échec de settle : le brouillon est quand même renvoyé', async () => {
    const { s, gate } = setup();
    gate.settle.mockRejectedValue(new Error('db'));
    await expect(s.suggest(input(valid))).resolves.toMatchObject({ content: 'Bonjour' });
  });

  it('échec de release : l’erreur d’origine est conservée', async () => {
    const { s, gate, drafting } = setup();
    drafting.generate.mockRejectedValue(new Error('origine'));
    gate.release.mockRejectedValue(new Error('release'));
    await expect(s.suggest(input(valid))).rejects.toThrow('origine');
  });

  it('exécuteur : transmet definitionId et reste en proposition (kind propose) ; erreur => wait', async () => {
    const { s, gate } = setup();
    const exec = createGenerationSuggestionExecutor(s);
    const ctx = {
      instanceId: '1',
      taskId: '2',
      step: { key: 'redaction' },
      context: { input: valid },
      runAs: { userGroupId: 70 },
      definitionId: 3,
    } as unknown as WfExecutorContext;
    const out = await exec.execute(ctx);
    expect(out.kind).toBe('propose');
    expect(gate.assertRunnable).toHaveBeenCalledWith({ definitionId: 3 });
    gate.assertRunnable.mockRejectedValue(new AgentBlockedError('ai_disabled', 'IA désactivée'));
    await expect(exec.execute(ctx)).resolves.toEqual({ kind: 'wait' });
  });
});
