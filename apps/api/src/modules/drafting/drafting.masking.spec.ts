// Intégration légère : DraftingService + vrai AiService + vrai AiMaskingService, fournisseur simulé
// (fetch). Montre qu'en mode cloud le texte envoyé (consigne + contexte) part MASQUÉ et que le
// journal reçoit le texte masqué. L'éditeur serveur est remplacé (sanitize-html est un module ESM
// que la configuration jest de l'API ne transforme pas) ; la finalisation HTML est simulée ici
// (elle est testée dans les specs du prompt).
import { GedAiMode, GedAiTask } from '@archivage/types';
import type { AiDecisionService } from '../ai/ai-decision.service';
import { AiMaskingService } from '../ai/ai-masking.service';
import type { AiSettingsService } from '../ai/ai-settings.service';
import { AiService } from '../ai/ai.service';
import type { AiEffectiveConfig } from '../ai/ai.types';
import type { AuthUser } from '../auth/auth.types';
import type { CollabDocumentsService } from '../collab/documents/collab-documents.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { DraftingContextService } from './drafting-context.service';
import { DraftingService } from './drafting.service';

jest.mock('@archivage/editor/server', () => ({
  extractMentionIds: jest.fn(() => []),
  htmlToYDoc: jest.fn(),
  sanitizeEditorHtml: jest.fn((h: string) => h),
  validateYDocStructure: jest.fn(),
  yDocToHtml: jest.fn(() => ''),
  yDocToPlainText: jest.fn(() => ''),
}));
jest.mock('./drafting-prompt', () => ({
  ...jest.requireActual('./drafting-prompt'),
  finalizeDraftHtml: jest.fn((h: string) => ({ html: h, text: 'texte' })),
}));

const user: AuthUser = { userId: 1, username: 'agent', isAdmin: false, userGroupId: 11 };
const EMAIL = 'jean.dupont@exemple.com';

function config(over: Partial<AiEffectiveConfig> = {}): AiEffectiveConfig {
  return {
    mode: GedAiMode.Cloud,
    provider: null,
    model: null,
    embeddingModel: null,
    embeddingDimension: 1024,
    endpoint: null,
    apiKeyRef: null,
    maskingEnabled: true,
    autoApplyThreshold: null,
    timeoutSeconds: 30,
    ...over,
  };
}

function setup(cfg: AiEffectiveConfig) {
  const fetchMock = jest.fn(
    async () =>
      new Response(
        JSON.stringify({ model: 'gpt-x', output_text: '{"html":"<p>ok</p>"}', usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200 },
      ),
  );
  const record = jest.fn().mockResolvedValue(BigInt(7));
  const ai = new AiService(
    { getEffective: jest.fn().mockResolvedValue(cfg) } as unknown as AiSettingsService,
    new AiMaskingService({ gedAiMaskingRule: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService),
    { record } as unknown as AiDecisionService,
  );
  ai.providerDeps = { env: { OPENAI_API_KEY: 'sk-test-SECRET-0123456789' }, fetchImpl: fetchMock as unknown as typeof fetch };
  const context = {
    load: jest.fn(async () => [
      {
        marker: 1,
        label: `Contrat de ${EMAIL}`,
        documentTypeLabel: null,
        documentDate: null,
        cote: null,
        overview: `Contacter ${EMAIL} pour la suite.`,
        dossierLabel: null,
        excerpts: [],
      },
    ]),
  };
  const collab = { createDocumentFromHtml: jest.fn() };
  const service = new DraftingService(
    ai,
    context as unknown as DraftingContextService,
    collab as unknown as CollabDocumentsService,
  );
  return { service, fetchMock, record, collab };
}

const dto = { templateId: 'vide', instruction: `Écris à ${EMAIL} au sujet du contrat`, contextDocumentIds: [3] };

describe('rédaction assistée + AiService : masquage', () => {
  it('cloud : la consigne et le contexte partent masqués, le journal reçoit le texte masqué', async () => {
    const h = setup(config());
    const res = await h.service.generate(dto, user);
    expect(res).toMatchObject({ disabled: false, draftHtml: '<p>ok</p>', decisionId: '7', provider: 'openai' });

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const sent = String((h.fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(sent).not.toContain(EMAIL);
    expect(sent).toContain('Écris à');

    expect(h.record).toHaveBeenCalledTimes(1);
    const journal = h.record.mock.calls[0][0] as {
      task: GedAiTask;
      inputText: string;
      inputMasked: boolean;
      promptVersion: string;
      documentId: number;
      requestedBy: number;
      status: unknown;
    };
    expect(journal).toMatchObject({
      task: GedAiTask.Autre,
      inputMasked: true,
      promptVersion: 'drafting-v1',
      documentId: 3,
      requestedBy: 11,
    });
    expect(journal.inputText).not.toContain(EMAIL);
  });

  it('cloud avec masquage coupé : refusé en 409, aucun appel fournisseur, aucun journal', async () => {
    const h = setup(config({ maskingEnabled: false }));
    await expect(h.service.generate(dto, user)).rejects.toMatchObject({ status: 409 });
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('IA désactivée : aucun contexte lu, aucun appel, réponse disabled', async () => {
    const h = setup(config({ mode: GedAiMode.Desactivee }));
    const res = await h.service.generate(dto, user);
    expect(res).toMatchObject({ disabled: true });
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });
});
