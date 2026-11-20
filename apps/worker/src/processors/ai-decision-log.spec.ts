import { createHash } from 'node:crypto';
import { GED_AI_INPUT_EXCERPT_MAX_CHARS, GedAiDecisionStatus, GedAiTask } from '@archivage/types';
import { buildDecisionData, writeAiDecision, type DecisionLogEntry } from './ai-decision-log';

const entry = (over: Partial<DecisionLogEntry> = {}): DecisionLogEntry => ({
  documentId: 4,
  task: GedAiTask.Classement,
  mode: 2,
  provider: 'openai',
  model: 'm',
  promptVersion: 'v1',
  sentText: 'texte masqué',
  inputMasked: true,
  output: { a: 1 },
  confidence: 0.7,
  status: GedAiDecisionStatus.Proposee,
  promptTokens: 1,
  completionTokens: 2,
  durationMs: 3,
  errorMessage: null,
  ...over,
});

describe('buildDecisionData', () => {
  it('tronque l’extrait, hache le texte complet et ne le conserve jamais', () => {
    const long = 'a'.repeat(GED_AI_INPUT_EXCERPT_MAX_CHARS * 3);
    const data = buildDecisionData(entry({ sentText: long }));
    expect(data.inputExcerpt!.length).toBeLessThanOrEqual(GED_AI_INPUT_EXCERPT_MAX_CHARS + 1);
    expect(data.inputHash).toBe(createHash('sha256').update(long, 'utf8').digest('hex'));
    expect(JSON.stringify(data)).not.toContain(long);
  });

  it('texte court : extrait identique ; aucun texte envoyé : extrait et hash nuls', () => {
    expect(buildDecisionData(entry()).inputExcerpt).toBe('texte masqué');
    const none = buildDecisionData(entry({ sentText: null, inputMasked: false, output: null }));
    expect(none).toMatchObject({ inputExcerpt: null, inputHash: null, inputMasked: false });
    expect('output' in none).toBe(false);
  });

  it('convertit sourceItemId en BigInt et reporte inputMasked tel quel', () => {
    const data = buildDecisionData(entry({ sourceItemId: 9, inputMasked: false, requestedBy: 5 }));
    expect(data).toMatchObject({ sourceItemId: 9n, inputMasked: false, requestedBy: 5 });
    expect(buildDecisionData(entry()).sourceItemId).toBeNull();
  });
});

describe('writeAiDecision', () => {
  it('renvoie l’identifiant en chaîne', async () => {
    const create = jest.fn().mockResolvedValue({ gedAiDecisionId: 42n });
    const id = await writeAiDecision({ gedAiDecision: { create } } as never, entry());
    expect(id).toBe('42');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
