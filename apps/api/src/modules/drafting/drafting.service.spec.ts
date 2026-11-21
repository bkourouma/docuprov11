import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GED_AI_DISABLED_MESSAGE,
  GED_DRAFT_EMPTY_TEMPLATE_ID,
  GED_DRAFT_PROMPT_VERSION,
  GED_DRAFT_REVIEW_NOTICE,
  GedAiDecisionStatus,
  GedAiMode,
  GedAiTask,
} from '@archivage/types';
import { AiConfigurationError } from '../ai/ai-provider.factory';
import type { AiService } from '../ai/ai.service';
import { AiMaskingRequiredError, AiProviderError } from '../ai/ai.types';
import type { AuthUser } from '../auth/auth.types';
import type { CollabDocumentsService } from '../collab/documents/collab-documents.service';
import type { DraftingContextService } from './drafting-context.service';
import * as prompt from './drafting-prompt';
import { DraftingService } from './drafting.service';
import { DRAFT_TEMPLATES, findDraftTemplate } from './drafting-templates';

// Le vrai éditeur serveur charge sanitize-html (ESM) : doublure de test déjà utilisée par le module collab.
jest.mock('@archivage/editor/server', () => jest.requireActual('../collab/persistence/editor-server.fake'));

jest.mock(
  './drafting-prompt',
  () => {
    class DraftOutputError extends Error {}
    return {
      DraftOutputError,
      buildDraftRequest: jest.fn(),
      parseDraftOutput: jest.fn(),
      finalizeDraftHtml: jest.fn(),
      hasVisibleInstruction: jest.fn(),
      collectSourceText: jest.fn(),
    };
  },
  { virtual: true },
);
jest.mock('./drafting-context.service', () => ({ DraftingContextService: class {} }), { virtual: true });

const mockedPrompt = prompt as unknown as {
  buildDraftRequest: jest.Mock;
  parseDraftOutput: jest.Mock;
  finalizeDraftHtml: jest.Mock;
  hasVisibleInstruction: jest.Mock;
  collectSourceText: jest.Mock;
  DraftOutputError: new (m?: string) => Error;
};

const user: AuthUser = { userId: 1, username: 'agent', isAdmin: false, userGroupId: 11 };
const REQUEST = { system: 'SYSTEME', text: 'TEXTE ENVOYE', jsonSchema: { name: 'ged_draft', schema: {} }, maxOutputTokens: 100 };
const DOC = {
  marker: 1,
  label: 'Contrat',
  documentTypeLabel: null,
  documentDate: null,
  cote: null,
  overview: null,
  dossierLabel: null,
  excerpts: [],
};

function setup(opts: { enabled?: boolean; runResult?: unknown; context?: unknown[] } = {}) {
  const ai = {
    status: jest.fn(async () =>
      opts.enabled === false
        ? { enabled: false, mode: GedAiMode.Desactivee, message: GED_AI_DISABLED_MESSAGE }
        : { enabled: true, mode: GedAiMode.Locale },
    ),
    run: jest.fn(async (..._a: unknown[]) =>
      opts.runResult === undefined
        ? {
            disabled: false,
            data: { html: '<p>Brut</p>' },
            decisionId: BigInt(42),
            status: GedAiDecisionStatus.Proposee,
            confidence: null,
            provider: 'ollama',
            model: 'llama',
          }
        : opts.runResult,
    ),
  };
  const context = { load: jest.fn(async (..._a: unknown[]) => opts.context ?? []) };
  const collab = { createDocumentFromHtml: jest.fn(async (..._a: unknown[]) => ({ documentId: 5, label: 'L', warnings: [] })) };
  const service = new DraftingService(
    ai as unknown as AiService,
    context as unknown as DraftingContextService,
    collab as unknown as CollabDocumentsService,
  );
  return { ai, context, collab, service };
}

const dto = { templateId: 'vide', instruction: 'Rédige une note' };

beforeEach(() => {
  mockedPrompt.buildDraftRequest.mockReset().mockReturnValue(REQUEST);
  mockedPrompt.parseDraftOutput.mockReset();
  mockedPrompt.hasVisibleInstruction.mockReset().mockReturnValue(true);
  mockedPrompt.collectSourceText.mockReset().mockReturnValue('SOURCE');
  mockedPrompt.finalizeDraftHtml.mockReset().mockReturnValue({ html: '<p>Propre</p>', text: 'Propre' });
});

describe('DraftingService : modèles', () => {
  it('liste le catalogue sans squelette, avec l’état de l’IA', async () => {
    const { service } = setup();
    const res = await service.listTemplates(user);
    expect(res.aiEnabled).toBe(true);
    expect(res.aiMessage).toBeUndefined();
    expect(res.templates).toHaveLength(DRAFT_TEMPLATES.length);
    expect(res.templates.map((t) => t.id)).toContain(GED_DRAFT_EMPTY_TEMPLATE_ID);
    for (const t of res.templates) expect(t).not.toHaveProperty('skeletonHtml');
  });

  it('IA désactivée : le catalogue reste listé avec le message', async () => {
    const { service } = setup({ enabled: false });
    const res = await service.listTemplates(user);
    expect(res).toMatchObject({ aiEnabled: false, aiMessage: GED_AI_DISABLED_MESSAGE });
    expect(res.templates.map((t) => t.id)).toContain(GED_DRAFT_EMPTY_TEMPLATE_ID);
  });

  it('détail : renvoie le squelette ; inconnu => 404 « Modèle introuvable »', () => {
    const { service } = setup();
    expect(service.getTemplate('vide', user)).toMatchObject({ id: 'vide', skeletonHtml: '<p></p>' });
    expect(() => service.getTemplate('inconnu', user)).toThrow(new NotFoundException('Modèle introuvable'));
  });
});

describe('DraftingService.generate', () => {
  it('compte sans profil ou identité machine : 403, rien n’est lu', async () => {
    const h = setup();
    await expect(h.service.generate(dto, { ...user, userGroupId: null })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.generate(dto, { ...user, isScanAgent: true })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.ai.status).not.toHaveBeenCalled();
    expect(h.context.load).not.toHaveBeenCalled();
  });

  it('modèle inconnu : 404 avant tout (ni statut IA, ni contexte, ni appel)', async () => {
    const h = setup();
    await expect(h.service.generate({ ...dto, templateId: 'inconnu' }, user)).rejects.toThrow(
      new NotFoundException('Modèle introuvable'),
    );
    expect(h.ai.status).not.toHaveBeenCalled();
    expect(h.context.load).not.toHaveBeenCalled();
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('IA désactivée : réponse disabled, aucun contexte chargé, aucun run', async () => {
    const h = setup({ enabled: false });
    const res = await h.service.generate({ ...dto, contextDocumentIds: [3] }, user);
    expect(res).toEqual({ disabled: true, message: GED_AI_DISABLED_MESSAGE });
    expect(h.ai.status).toHaveBeenCalledTimes(1);
    expect(h.context.load).not.toHaveBeenCalled();
    expect(h.ai.run).not.toHaveBeenCalled();
    expect(mockedPrompt.buildDraftRequest).not.toHaveBeenCalled();
  });

  it('run renvoie disabled (course de configuration) : réponse disabled', async () => {
    const h = setup({ runResult: { disabled: true, message: 'Désactivée' } });
    await expect(h.service.generate(dto, user)).resolves.toEqual({ disabled: true, message: 'Désactivée' });
    expect(mockedPrompt.finalizeDraftHtml).not.toHaveBeenCalled();
  });

  it('appelle AiService.run avec la tâche Autre, drafting-v1, autoApply false, requestedBy et le texte construit', async () => {
    const h = setup({ context: [DOC] });
    await h.service.generate({ ...dto, contextDocumentIds: [3] }, user);
    expect(h.context.load).toHaveBeenCalledWith({ contextDocumentIds: [3], dossierId: undefined }, user);
    const template = findDraftTemplate('vide')!;
    expect(mockedPrompt.buildDraftRequest).toHaveBeenCalledWith({
      template: { label: template.label, guidance: template.guidance, skeletonHtml: template.skeletonHtml },
      instruction: dto.instruction,
      context: [DOC],
    });
    expect(h.ai.run).toHaveBeenCalledTimes(1);
    const opts = h.ai.run.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).toMatchObject({
      task: GedAiTask.Autre,
      request: REQUEST,
      promptVersion: GED_DRAFT_PROMPT_VERSION,
      requestedBy: 11,
      documentId: 3,
      autoApply: false,
    });
    expect(opts.promptVersion).toBe('drafting-v1');
    expect(opts.parse).toBe(mockedPrompt.parseDraftOutput);
    expect(opts.confidence).toBeUndefined();
  });

  it('documentId : null sans contexte, avec plusieurs documents ou via un dossier', async () => {
    const none = setup({ context: [] });
    await none.service.generate(dto, user);
    expect(none.ai.run.mock.calls[0][0]).toMatchObject({ documentId: null });

    const many = setup({ context: [DOC, { ...DOC, marker: 2 }] });
    await many.service.generate({ ...dto, contextDocumentIds: [3, 4] }, user);
    expect(many.ai.run.mock.calls[0][0]).toMatchObject({ documentId: null });

    const dossier = setup({ context: [DOC] });
    await dossier.service.generate({ ...dto, dossierId: 9 }, user);
    expect(dossier.ai.run.mock.calls[0][0]).toMatchObject({ documentId: null });
  });

  it('réponse complète : HTML finalisé, decisionId en chaîne, mention de relecture, nombre de documents', async () => {
    const h = setup({ context: [DOC, { ...DOC, marker: 2 }] });
    const res = await h.service.generate({ ...dto, contextDocumentIds: [3, 4] }, user);
    expect(mockedPrompt.finalizeDraftHtml).toHaveBeenCalledWith('<p>Brut</p>', 'SOURCE');
    expect(res).toEqual({
      disabled: false,
      templateId: 'vide',
      draftHtml: '<p>Propre</p>',
      draftText: 'Propre',
      contextDocumentCount: 2,
      decisionId: '42',
      provider: 'ollama',
      model: 'llama',
      notice: GED_DRAFT_REVIEW_NOTICE,
    });
  });

  it('journal indisponible : decisionId null, le brouillon est tout de même rendu', async () => {
    const h = setup({
      runResult: {
        disabled: false,
        data: { html: '<p>x</p>' },
        decisionId: null,
        status: GedAiDecisionStatus.Proposee,
        confidence: null,
        provider: 'p',
        model: 'm',
      },
    });
    await expect(h.service.generate(dto, user)).resolves.toMatchObject({ disabled: false, decisionId: null });
  });

  it('contexte refusé (404 uniforme) : remonte tel quel, run jamais appelé', async () => {
    const h = setup();
    h.context.load.mockRejectedValue(new NotFoundException('Document introuvable'));
    await expect(h.service.generate({ ...dto, contextDocumentIds: [3] }, user)).rejects.toThrow(
      new NotFoundException('Document introuvable'),
    );
    expect(h.ai.run).not.toHaveBeenCalled();
    expect(mockedPrompt.buildDraftRequest).not.toHaveBeenCalled();
  });

  it('sortie inexploitable (DraftOutputError à la finalisation) : 502 avec message français', async () => {
    const h = setup();
    mockedPrompt.finalizeDraftHtml.mockImplementation(() => {
      throw new mockedPrompt.DraftOutputError('vide');
    });
    const err = await h.service.generate(dto, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect((err as BadGatewayException).message).toBe(
      'Le brouillon généré est inexploitable. Réessayez ou reformulez la consigne.',
    );
  });

  it('DraftOutputError levée dans AiService.run (JSON invalide, champ en trop, sortie trop longue) : 502, jamais 500', async () => {
    for (const reason of [
      'Sortie du modèle illisible : JSON invalide.',
      'Sortie du modèle non conforme au contrat attendu.',
      'Sortie du modèle trop longue.',
    ]) {
      const h = setup();
      h.ai.run.mockRejectedValue(new mockedPrompt.DraftOutputError(reason));
      const err = await h.service.generate(dto, user).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadGatewayException);
      expect((err as BadGatewayException).message).toBe(
        'Le brouillon généré est inexploitable. Réessayez ou reformulez la consigne.',
      );
    }
  });

  it('consigne vide après nettoyage (caractères invisibles) : 400 français, ni contexte ni appel IA', async () => {
    const h = setup();
    mockedPrompt.hasVisibleInstruction.mockReturnValue(false);
    const err = await h.service.generate({ ...dto, contextDocumentIds: [3] }, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toMatch(/consigne/i);
    expect(h.context.load).not.toHaveBeenCalled();
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('le texte source des liens autorisés vient de la consigne et du contexte chargé', async () => {
    const h = setup({ context: [DOC] });
    await h.service.generate(dto, user);
    expect(mockedPrompt.collectSourceText).toHaveBeenCalledWith(dto.instruction, [DOC]);
  });

  it('une erreur imprévue de finalisation n’est pas masquée en 502', async () => {
    const h = setup();
    mockedPrompt.finalizeDraftHtml.mockImplementation(() => {
      throw new TypeError('bug');
    });
    await expect(h.service.generate(dto, user)).rejects.toBeInstanceOf(TypeError);
  });

  it('AiMaskingRequiredError => 409 avec le message de l’erreur', async () => {
    const h = setup();
    h.ai.run.mockRejectedValue(new AiMaskingRequiredError('Envoi cloud refusé : masquage requis.'));
    const err = await h.service.generate(dto, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe('Envoi cloud refusé : masquage requis.');
  });

  it('AiProviderError => 502 générique (le message d’origine n’est pas relayé)', async () => {
    const h = setup();
    h.ai.run.mockRejectedValue(new AiProviderError('HTTP 500 secret-interne'));
    const err = await h.service.generate(dto, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect((err as Error).message).not.toContain('secret-interne');
  });

  it('AiConfigurationError => 503 générique', async () => {
    const h = setup();
    h.ai.run.mockRejectedValue(new AiConfigurationError('endpoint http://u:p@h'));
    const err = await h.service.generate(dto, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).not.toContain('http://');
  });

  it('erreur inconnue de run : propagée', async () => {
    const h = setup();
    h.ai.run.mockRejectedValue(new RangeError('boom'));
    await expect(h.service.generate(dto, user)).rejects.toBeInstanceOf(RangeError);
  });

  it('n’écrit jamais le brouillon : seul run (journal tenu par AiService) est appelé, pas la création', async () => {
    const h = setup({ context: [DOC] });
    await h.service.generate({ ...dto, contextDocumentIds: [3] }, user);
    expect(h.collab.createDocumentFromHtml).not.toHaveBeenCalled();
    // Le service ne détient aucune dépendance d'écriture : AiService, lecture de contexte, création depuis modèle.
    expect(Object.keys(h.service as unknown as Record<string, unknown>).sort()).toEqual([
      'ai',
      'collabDocuments',
      'context',
      'logger',
    ]);
  });

  it('les logs d’échec ne contiennent ni consigne ni contexte ni brouillon', async () => {
    const h = setup({ context: [DOC] });
    const logger = (h.service as unknown as { logger: { warn: (m: string) => void } }).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    h.ai.run.mockRejectedValue(new AiProviderError('contenu SECRET-TEXTE'));
    await h.service.generate({ ...dto, instruction: 'INSTRUCTION-CONFIDENTIELLE' }, user).catch(() => undefined);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('AiProviderError');
    expect(logged).not.toContain('INSTRUCTION-CONFIDENTIELLE');
    expect(logged).not.toContain('SECRET-TEXTE');
    expect(logged).not.toContain('Contrat');
  });
});

describe('DraftingService.createDocumentFromTemplate', () => {
  it('délègue à CollabDocumentsService avec le squelette du modèle', async () => {
    const h = setup();
    const res = await h.service.createDocumentFromTemplate(
      { spaceId: 3, templateId: 'vide', label: 'Ma note' },
      user,
    );
    expect(h.collab.createDocumentFromHtml).toHaveBeenCalledWith(3, 'Ma note', '<p></p>', user);
    expect(res).toEqual({ documentId: 5, label: 'L', warnings: [] });
    expect(h.ai.run).not.toHaveBeenCalled();
  });

  it('modèle inconnu : 404, rien n’est créé', async () => {
    const h = setup();
    expect(() =>
      h.service.createDocumentFromTemplate({ spaceId: 3, templateId: 'inconnu', label: 'X' }, user),
    ).toThrow(new NotFoundException('Modèle introuvable'));
    expect(h.collab.createDocumentFromHtml).not.toHaveBeenCalled();
  });
});
