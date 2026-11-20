import { createHash } from 'node:crypto';
import {
  GED_AI_INPUT_EXCERPT_MAX_CHARS,
  GED_AI_PIPELINE_PROMPT_VERSION,
  GedAiDecisionStatus,
  GedAiMode,
  GedAiTask,
  type GedAiDocumentPatch,
} from '@archivage/types';
import { AiConfigurationError, type EffectiveAiConfig } from './ai-config';
import type { DecisionLogEntry } from './ai-decision-log';
import { buildDecisionData, hashSentText } from './ai-decision-log';
import { GED_AI_MAX_TEXT_CHARS, runAiPipeline, type AiPipelineDeps } from './ai-pipeline';
import { AiProviderError, type AiCompletionRequest, type AiProvider } from './ai-providers';

const TEXT =
  'Facture de M. Jean Dupont, contact jean.dupont@example.com, tél 01 23 45 67 89, ' +
  'montant 1 250,00 € à régler avant fin mars.';

const baseConfig = (over: Partial<EffectiveAiConfig> = {}): EffectiveAiConfig => ({
  mode: GedAiMode.Cloud,
  provider: 'openai',
  model: 'gpt-test',
  endpoint: 'https://api.example.com/v1',
  apiKey: 'sk-secret-123',
  maskingEnabled: true,
  threshold: null,
  timeoutSeconds: 30,
  ...over,
});

const TYPES = [
  { id: 10, label: 'Facture' },
  { id: 20, label: 'Contrat' },
];

interface Harness {
  deps: AiPipelineDeps;
  calls: AiCompletionRequest[];
  decisions: DecisionLogEntry[];
  patches: Array<{ documentId: number; patch: GedAiDocumentPatch }>;
  loadDocument: jest.Mock;
  createProvider: jest.Mock;
}

function harness(opts: {
  config?: Partial<EffectiveAiConfig>;
  ocrTexts?: Array<string | null> | null;
  classification?: unknown;
  extraction?: unknown;
  failTask?: 'classification' | 'extraction';
}): Harness {
  const calls: AiCompletionRequest[] = [];
  const decisions: DecisionLogEntry[] = [];
  const patches: Harness['patches'] = [];
  const provider: AiProvider = {
    kind: 'cloud',
    async complete(req) {
      calls.push(req);
      const isClassif = req.schemaName === 'ged_classification';
      if (
        (opts.failTask === 'classification' && isClassif) ||
        (opts.failTask === 'extraction' && !isClassif)
      ) {
        throw new AiProviderError('Fournisseur IA : réponse HTTP 500.');
      }
      const payload = isClassif
        ? (opts.classification ?? {
            documentTypeId: 10,
            documentTypeLabel: 'Facture',
            confidence: 0.9,
            rationale: null,
          })
        : (opts.extraction ?? {
            title: 'Facture mars',
            date: '2026-03-15',
            reference: 'F-1',
            summary: 'Une facture.',
            confidence: 0.9,
          });
      return { content: JSON.stringify(payload), promptTokens: 100, completionTokens: 20 };
    },
  };
  const loadDocument = jest.fn(async () =>
    opts.ocrTexts === null ? null : { ocrTexts: opts.ocrTexts ?? [TEXT] },
  );
  const createProvider = jest.fn(() => provider);
  let seq = 0;
  const deps: AiPipelineDeps = {
    loadConfig: async () => baseConfig(opts.config),
    loadDocument,
    listDocumentTypes: async () => TYPES,
    loadMaskingRules: async () => [],
    createProvider,
    writeDecision: async (e) => {
      decisions.push(e);
      seq += 1;
      return String(seq);
    },
    applyDocumentPatch: async (documentId, patch) => {
      patches.push({ documentId, patch });
    },
  };
  return { deps, calls, decisions, patches, loadDocument, createProvider };
}

const job = { documentId: 7, requestedBy: 3 };

describe('ai-pipeline : mode et fournisseur', () => {
  it('configuration interdite : le job échoue (erreur propagée), sans lecture, appel ni décision', async () => {
    const h = harness({});
    h.deps.loadConfig = async () => {
      throw new AiConfigurationError('Référence de clé API non autorisée.');
    };
    await expect(runAiPipeline(job, h.deps)).rejects.toThrow(AiConfigurationError);
    expect(h.loadDocument).not.toHaveBeenCalled();
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.decisions).toHaveLength(0);
  });

  it('mode 0 : disabled, sans lecture, appel, journal ni erreur', async () => {
    const h = harness({ config: { mode: GedAiMode.Desactivee } });
    const res = await runAiPipeline(job, h.deps);
    expect(res).toEqual({ disabled: true, message: 'IA désactivée' });
    expect(h.loadDocument).not.toHaveBeenCalled();
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
    expect(h.decisions).toHaveLength(0);
  });

  it('mode 1 : fournisseur local ; mode 2 : cloud (mode figé dans le journal)', async () => {
    const local = harness({ config: { mode: GedAiMode.Locale, provider: 'ollama' } });
    await runAiPipeline(job, local.deps);
    expect(local.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ mode: GedAiMode.Locale }),
    );
    expect(local.decisions.every((d) => d.mode === 1)).toBe(true);

    const cloud = harness({});
    await runAiPipeline(job, cloud.deps);
    expect(cloud.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ mode: GedAiMode.Cloud }),
    );
    expect(cloud.decisions.every((d) => d.mode === 2)).toBe(true);
  });
});

describe('ai-pipeline : masquage', () => {
  it('cloud sans masquage : décision en erreur, aucun appel, étape suivante non lancée', async () => {
    const h = harness({ config: { maskingEnabled: false } });
    const res = await runAiPipeline(job, h.deps);
    expect(h.calls).toHaveLength(0);
    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0]).toMatchObject({
      task: GedAiTask.Classement,
      status: GedAiDecisionStatus.Erreur,
      sentText: null,
    });
    expect(res).toMatchObject({ disabled: false });
    if (!res.disabled) expect(res.decisions).toHaveLength(1);
  });

  it('cloud : le texte reçu par le fournisseur ne contient plus e-mail, téléphone, montant, identité', async () => {
    const h = harness({});
    await runAiPipeline(job, h.deps);
    expect(h.calls.length).toBeGreaterThan(0);
    for (const c of h.calls) {
      expect(c.user).not.toContain('jean.dupont@example.com');
      expect(c.user).not.toContain('01 23 45 67 89');
      expect(c.user).not.toContain('1 250,00');
      expect(c.user).not.toContain('Jean Dupont');
      expect(c.user).toContain('[EMAIL]');
    }
    expect(h.decisions.every((d) => d.inputMasked)).toBe(true);
  });

  it('local avec masking_enabled=false : texte envoyé tel quel, inputMasked=false', async () => {
    const h = harness({ config: { mode: GedAiMode.Locale, maskingEnabled: false } });
    await runAiPipeline(job, h.deps);
    expect(h.calls[0]!.user).toContain('jean.dupont@example.com');
    expect(h.decisions[0]!.inputMasked).toBe(false);
  });
});

describe('ai-pipeline : confiance et seuil', () => {
  it('seuil null : Proposee, document inchangé', async () => {
    const h = harness({ config: { threshold: null } });
    const res = await runAiPipeline(job, h.deps);
    expect(h.patches).toHaveLength(0);
    expect(h.decisions.map((d) => d.status)).toEqual([
      GedAiDecisionStatus.Proposee,
      GedAiDecisionStatus.Proposee,
    ]);
    if (!res.disabled) expect(res.decisions[0]).toMatchObject({ decisionId: '1', confidence: 0.9 });
  });

  it('seuil 0.8 et confiance 0.9 : AppliqueeAuto et champs remplis', async () => {
    const h = harness({ config: { threshold: 0.8 } });
    await runAiPipeline(job, h.deps);
    expect(h.decisions.map((d) => d.status)).toEqual([
      GedAiDecisionStatus.AppliqueeAuto,
      GedAiDecisionStatus.AppliqueeAuto,
    ]);
    expect(h.patches).toEqual([
      { documentId: 7, patch: { documentTypeId: 10 } },
      { documentId: 7, patch: { documentDate: '2026-03-15', overview: 'Une facture.' } },
    ]);
  });

  it('confiance 0.5 sous le seuil 0.8 : Proposee, rien d’écrit', async () => {
    const h = harness({
      config: { threshold: 0.8 },
      classification: {
        documentTypeId: 10,
        documentTypeLabel: 'Facture',
        confidence: 0.5,
        rationale: null,
      },
      extraction: {
        title: 't',
        date: '2026-03-15',
        reference: null,
        summary: 's',
        confidence: 0.5,
      },
    });
    await runAiPipeline(job, h.deps);
    expect(h.decisions.every((d) => d.status === GedAiDecisionStatus.Proposee)).toBe(true);
    expect(h.patches).toHaveLength(0);
  });

  it('id de type hors liste : ramené à null, rien d’appliqué', async () => {
    const h = harness({
      config: { threshold: 0.8 },
      classification: {
        documentTypeId: 999,
        documentTypeLabel: 'Inventé',
        confidence: 0.95,
        rationale: null,
      },
    });
    await runAiPipeline(job, h.deps);
    expect(h.decisions[0]!.output).toMatchObject({ documentTypeId: null, documentTypeLabel: null });
    expect(h.decisions[0]!.status).toBe(GedAiDecisionStatus.Proposee);
    expect(h.patches.some((p) => p.patch.documentTypeId !== undefined)).toBe(false);
    // Aucun type retenu : l'extraction ne reçoit pas de contexte de type.
    expect(h.calls[1]!.user).not.toContain('Type de document retenu');
  });

  it('le type retenu sert de contexte à l’extraction', async () => {
    const h = harness({});
    await runAiPipeline(job, h.deps);
    expect(h.calls[1]!.user).toContain('Type de document retenu : Facture');
  });

  it('classement : le modèle ne voit que les types du référentiel', async () => {
    const h = harness({});
    await runAiPipeline(job, h.deps);
    expect(h.calls[0]!.user).toContain('10: Facture');
    expect(h.calls[0]!.user).toContain('20: Contrat');
  });
});

describe('ai-pipeline : journal', () => {
  it('une ligne par étape : extrait tronqué, hash SHA-256 du texte masqué, jetons, version de prompt', async () => {
    const long = `${TEXT} ${'lorem ipsum '.repeat(400)}`;
    const h = harness({ ocrTexts: [long] });
    await runAiPipeline({ documentId: 7, sourceItemId: 5, requestedBy: 3 }, h.deps);
    expect(h.decisions).toHaveLength(2);
    const d = h.decisions[0]!;
    expect(d.sentText).not.toBeNull();
    const data = buildDecisionData(d);
    expect(data.inputExcerpt!.length).toBeLessThanOrEqual(GED_AI_INPUT_EXCERPT_MAX_CHARS + 1);
    expect(data.inputExcerpt!.length).toBeLessThan(d.sentText!.length);
    expect(data.inputHash).toBe(createHash('sha256').update(d.sentText!, 'utf8').digest('hex'));
    expect(data.inputHash).toBe(hashSentText(d.sentText!));
    expect(data.inputExcerpt).not.toContain('jean.dupont@example.com');
    expect(data).toMatchObject({
      documentId: 7,
      sourceItemId: 5n,
      requestedBy: 3,
      mode: 2,
      promptVersion: GED_AI_PIPELINE_PROMPT_VERSION,
      promptTokens: 100,
      completionTokens: 20,
    });
  });

  it('échec fournisseur : décision Erreur sans clé, l’étape suivante continue', async () => {
    const h = harness({ failTask: 'classification' });
    const res = await runAiPipeline(job, h.deps);
    expect(h.decisions[0]).toMatchObject({
      task: GedAiTask.Classement,
      status: GedAiDecisionStatus.Erreur,
    });
    expect(h.decisions[0]!.errorMessage).toContain('HTTP 500');
    expect(h.decisions[0]!.errorMessage).not.toContain('sk-secret-123');
    expect(h.decisions[1]).toMatchObject({
      task: GedAiTask.ExtractionMetadonnees,
      status: GedAiDecisionStatus.Proposee,
    });
    if (!res.disabled) expect(res.decisions).toHaveLength(2);
  });

  it('JSON invalide : Erreur avec message générique (sans contenu)', async () => {
    const h = harness({ classification: { nimporte: 'quoi' } });
    await runAiPipeline(job, h.deps);
    expect(h.decisions[0]).toMatchObject({ status: GedAiDecisionStatus.Erreur });
    expect(h.decisions[0]!.errorMessage).toContain('invalide');
  });

  it('échec de l’application automatique : décision laissée à valider', async () => {
    const h = harness({ config: { threshold: 0.8 } });
    h.deps.applyDocumentPatch = async () => {
      throw new Error('base indisponible avec détails internes');
    };
    await runAiPipeline(job, h.deps);
    expect(h.decisions.every((d) => d.status === GedAiDecisionStatus.Proposee)).toBe(true);
    expect(h.decisions[0]!.errorMessage).not.toContain('internes');
  });
});

describe('ai-pipeline : lecture', () => {
  it('no_text : rien envoyé, aucune décision', async () => {
    const h = harness({ ocrTexts: [null, '   '] });
    const res = await runAiPipeline(job, h.deps);
    expect(res).toEqual({ disabled: false, documentId: 7, skipped: 'no_text', decisions: [] });
    expect(h.calls).toHaveLength(0);
    expect(h.decisions).toHaveLength(0);
  });

  it('document introuvable', async () => {
    const h = harness({ ocrTexts: null });
    const res = await runAiPipeline(job, h.deps);
    expect(res).toEqual({
      disabled: false,
      documentId: 7,
      skipped: 'document_not_found',
      decisions: [],
    });
    expect(h.calls).toHaveLength(0);
  });

  it('concatène les pages et plafonne le texte', async () => {
    const h = harness({
      config: { mode: GedAiMode.Locale, maskingEnabled: false },
      ocrTexts: ['a'.repeat(15_000), 'b'.repeat(15_000)],
    });
    await runAiPipeline(job, h.deps);
    const sent = h.decisions[0]!.sentText!;
    expect(sent.length).toBe(GED_AI_MAX_TEXT_CHARS);
    expect(sent).toContain('b');
  });
});
