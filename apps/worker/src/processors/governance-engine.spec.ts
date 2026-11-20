import {
  GED_GOVERNANCE_DETERMINISTIC_MODEL,
  GED_GOVERNANCE_DETERMINISTIC_PROVIDER,
  GED_GOVERNANCE_MAX_NEAR_DUPLICATES,
  GED_GOVERNANCE_PROMPT_VERSION,
  GedAiDecisionStatus,
  GedAiMode,
  GedAiTask,
  governanceDuplicateOutputSchema,
  governancePiiOutputSchema,
  governanceSensitivityOutputSchema,
  type GovernancePiiFinding,
  type GovernanceSensitivityOutput,
} from '@archivage/types';
import type { EffectiveAiConfig } from './ai-config';
import type { DecisionLogEntry } from './ai-decision-log';
import {
  analyzeDocument,
  GOVERNANCE_AI_SYSTEM_PROMPT,
  type GovernanceDetectors,
  type GovernanceDocument,
  type GovernanceEngineDeps,
} from './governance-engine';

// Données « réalistes » : aucune ne doit jamais réapparaître en clair dans le journal.
const EMAIL = 'jean.dupont@example.com';
const IBAN = 'FR7630006000011234567890189';
const NIR = '1850578006084';
const PHONE = '06 12 34 56 78';
const NAME = 'Jean Dupont';
const RAW_TEXT = `Contrat de ${NAME}. Contact : ${EMAIL}, tél ${PHONE}. IBAN ${IBAN}. NIR ${NIR}. Dossier médical joint.`;
const RAW_VALUES = [EMAIL, IBAN, NIR, PHONE, NAME];

const OLD = new Date('2020-01-01T00:00:00Z');
const NEW = new Date('2024-01-01T00:00:00Z');

// Détecteurs de test : le moteur ne dépend pas de l'implémentation réelle (T1).
const maskLine = (s: string) =>
  s.split(EMAIL).join('[EMAIL]').split(IBAN).join('[IBAN]').split(NIR).join('[NIR]').split(PHONE).join('[TÉLÉPHONE]');

function fakeDetectors(): GovernanceDetectors {
  return {
    detectPii: jest.fn((text: string): GovernancePiiFinding[] => {
      const out: GovernancePiiFinding[] = [];
      if (text.includes(EMAIL)) out.push({ entity: 'email', count: 1, confidence: 1, contexts: [`Contact : ${EMAIL}`] });
      if (text.includes(IBAN)) out.push({ entity: 'iban', count: 1, confidence: 1, contexts: [`IBAN ${IBAN}`] });
      return out;
    }),
    maskPiiContextText: jest.fn(maskLine),
    detectSensitivityKeywords: jest.fn((text: string) =>
      /médical/i.test(text) ? (['keyword_health'] as const).slice() : [],
    ),
    proposeSensitivity: jest.fn((input) => {
      const score = Math.max(
        input.aiScore ?? 0,
        input.findings.length > 0 ? 2 : input.keywordReasons.length > 0 ? 1 : 0,
      ) as 0 | 1 | 2;
      if (score === 0) return null;
      const sorted = [...input.levels].sort((a, b) => a.rank - b.rank);
      const target = score === 2 ? sorted[sorted.length - 1]! : sorted[1]!;
      if (input.current.rank !== null && target.rank <= input.current.rank) return null;
      const out: GovernanceSensitivityOutput = {
        schemaVersion: 1,
        kind: 'sensitivity',
        score,
        currentConfidentialiteId: input.current.confidentialiteId,
        currentRank: input.current.rank,
        proposedConfidentialiteId: target.confidentialiteId,
        proposedRank: target.rank,
        direction: 'raise',
        reasons: [...input.keywordReasons],
        detection: { deterministic: true, ai: false },
      };
      return out;
    }),
    titleSimilarity: jest.fn((a: string, b: string) => (a.toLowerCase() === b.toLowerCase() ? 1 : 0)),
    buildDuplicateGroupKey: (id: number) => `dup:${id}`,
    pickOriginalDocumentId: (c) =>
      [...c].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.documentId - b.documentId)[0]!
        .documentId,
  };
}

const LEVELS = [
  { confidentialiteId: 1, label: 'Public', rank: 0 },
  { confidentialiteId: 2, label: 'Interne', rank: 1 },
  { confidentialiteId: 3, label: 'Confidentiel', rank: 2 },
];

const cfg = (mode: GedAiMode, extra: Partial<EffectiveAiConfig> = {}): EffectiveAiConfig => ({
  mode,
  provider: mode === GedAiMode.Desactivee ? null : 'ollama',
  model: mode === GedAiMode.Desactivee ? '' : 'llama-test',
  endpoint: 'http://localhost:11434/v1',
  apiKey: null,
  maskingEnabled: true,
  threshold: 0.1, // seuil d'auto-application configuré : le worker ne doit JAMAIS appliquer
  timeoutSeconds: 60,
  ...extra,
});

const baseDoc = (over: Partial<GovernanceDocument> = {}): GovernanceDocument => ({
  documentId: 10,
  label: 'Facture mars',
  documentTypeId: 4,
  documentDate: '2026-03-01',
  isArchived: true,
  documentState: 1,
  confidentialiteId: null,
  confidentialiteRank: null,
  createdAt: NEW,
  ocrTexts: [RAW_TEXT],
  ...over,
});

const aiJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ personNameCount: 0, nameConfidence: 0, sensitivityScore: 0, confidence: 0.9, ...over });

interface Harness {
  deps: GovernanceEngineDeps;
  decisions: DecisionLogEntry[];
  complete: jest.Mock;
  neighbours: jest.Mock;
  titles: jest.Mock;
  exact: jest.Mock;
  rules: jest.Mock;
}

function harness(
  opts: {
    config?: EffectiveAiConfig;
    doc?: GovernanceDocument | null;
    exact?: Array<{ documentId: number; createdAt: Date; method: 'file_hash' | 'source_hash' }>;
    neighbours?: Array<{ documentId: number; createdAt: Date; similarity: number }>;
    titles?: Array<{ documentId: number; createdAt: Date; label: string }>;
    ai?: string | Error;
    levels?: typeof LEVELS;
    detectors?: Partial<GovernanceDetectors>;
  } = {},
): Harness {
  const decisions: DecisionLogEntry[] = [];
  const complete = jest.fn(async () => {
    if (opts.ai instanceof Error) throw opts.ai;
    return { content: opts.ai ?? aiJson(), promptTokens: 1, completionTokens: 1 };
  });
  const neighbours = jest.fn(async () => opts.neighbours ?? []);
  const titles = jest.fn(async () => opts.titles ?? []);
  const exact = jest.fn(async () => opts.exact ?? []);
  const rules = jest.fn(async () => []);
  const deps: GovernanceEngineDeps = {
    loadConfig: async () => opts.config ?? cfg(GedAiMode.Locale),
    loadDocument: async () => (opts.doc === undefined ? baseDoc() : opts.doc),
    loadMaskingRules: rules,
    createProvider: () => ({ kind: 'local', complete }),
    listConfidentialiteLevels: async () => opts.levels ?? LEVELS,
    findExactDuplicates: exact,
    findEmbeddingNeighbours: neighbours,
    findTitleCandidates: titles,
    // Journal en mémoire : ce que le moteur a écrit est ce que l'idempotence relit.
    listExistingProposals: async (ids) =>
      decisions
        .filter((d) => d.documentId !== undefined && ids.includes(d.documentId) && d.status !== GedAiDecisionStatus.Erreur)
        .map((d) => ({ documentId: d.documentId, status: d.status, output: d.output })),
    writeDecision: async (e) => {
      decisions.push(e);
      return String(decisions.length);
    },
    detectors: { ...fakeDetectors(), ...opts.detectors },
  };
  return { deps, decisions, complete, neighbours, titles, exact, rules };
}

const kindsOf = (r: { created: Array<{ kind: string }> }) => r.created.map((c) => c.kind);
const dupOutputs = (h: Harness) =>
  h.decisions
    .filter((d) => d.status === GedAiDecisionStatus.Proposee)
    .map((d) => d.output as { kind: string })
    .filter((o) => o.kind.startsWith('duplicate'))
    .map((o) => governanceDuplicateOutputSchema.parse(o));

describe('éligibilité', () => {
  it('document inexistant : skipped document_not_found, rien d’écrit', async () => {
    const h = harness({ doc: null });
    const r = await analyzeDocument(10, h.deps);
    expect(r.skipped).toBe('document_not_found');
    expect(h.decisions).toHaveLength(0);
  });
  it('non archivé ou épuré : skipped not_analyzable', async () => {
    for (const doc of [baseDoc({ isArchived: false }), baseDoc({ documentState: 3 })]) {
      const h = harness({ doc });
      const r = await analyzeDocument(10, h.deps);
      expect(r.skipped).toBe('not_analyzable');
      expect(h.exact).not.toHaveBeenCalled();
      expect(h.decisions).toHaveLength(0);
    }
  });
});

describe('doublons exacts', () => {
  it('file_hash : le plus récent est le doublon du plus ancien (groupKey, sortie conforme)', async () => {
    const h = harness({ doc: baseDoc({ ocrTexts: [] }), exact: [{ documentId: 2, createdAt: OLD, method: 'file_hash' }] });
    const r = await analyzeDocument(10, h.deps, { requestedBy: 7 });
    expect(kindsOf(r)).toEqual(['duplicate_exact']);
    const d = h.decisions[0]!;
    expect(d.documentId).toBe(10);
    expect(d.task).toBe(GedAiTask.Similarite);
    expect(d.status).toBe(GedAiDecisionStatus.Proposee);
    expect(d.promptVersion).toBe(GED_GOVERNANCE_PROMPT_VERSION);
    expect(d.requestedBy).toBe(7);
    expect(d.inputMasked).toBe(true);
    expect(d.sentText).toBe('doublon 10 de 2 par file_hash');
    expect(d.confidence).toBe(1);
    expect(governanceDuplicateOutputSchema.parse(d.output)).toMatchObject({
      method: 'file_hash',
      similarity: 1,
      groupKey: 'dup:2',
      originalDocumentId: 2,
      duplicateDocumentId: 10,
      proposedAction: 'archive_duplicate',
    });
  });

  it('source_hash : le document analysé plus ancien est l’original, la décision porte sur le doublon', async () => {
    const h = harness({
      doc: baseDoc({ ocrTexts: [], createdAt: OLD }),
      exact: [{ documentId: 3, createdAt: NEW, method: 'source_hash' }],
    });
    await analyzeDocument(10, h.deps);
    expect(h.decisions).toHaveLength(1);
    expect(h.decisions[0]!.documentId).toBe(3);
    expect(dupOutputs(h)[0]).toMatchObject({ method: 'source_hash', originalDocumentId: 10, duplicateDocumentId: 3, groupKey: 'dup:10' });
  });

  it('plusieurs doublons : tous deviennent doublons de l’original (le plus ancien)', async () => {
    const h = harness({
      doc: baseDoc({ ocrTexts: [], createdAt: NEW }),
      exact: [
        { documentId: 2, createdAt: OLD, method: 'file_hash' },
        { documentId: 3, createdAt: new Date('2022-01-01T00:00:00Z'), method: 'file_hash' },
      ],
    });
    await analyzeDocument(10, h.deps);
    const outs = dupOutputs(h);
    expect(outs.map((o) => [o.duplicateDocumentId, o.originalDocumentId]).sort()).toEqual([
      [10, 2],
      [3, 2],
    ]);
    expect(new Set(outs.map((o) => o.groupKey))).toEqual(new Set(['dup:2']));
  });

  it('aucune correspondance (empreintes seulement partiellement communes côté SQL) : aucune proposition', async () => {
    const h = harness({ doc: baseDoc({ ocrTexts: [] }), exact: [] });
    const r = await analyzeDocument(10, h.deps);
    expect(r.created).toEqual([]);
  });
});

describe('quasi-doublons', () => {
  it('embedding : retenu à 0,95, écarté à 0,949 (méthode embedding, modèle IA consigné)', async () => {
    const h = harness({
      doc: baseDoc({ ocrTexts: [], documentTypeId: null }),
      neighbours: [
        { documentId: 2, createdAt: OLD, similarity: 0.95 },
        { documentId: 3, createdAt: OLD, similarity: 0.949 },
      ],
    });
    const r = await analyzeDocument(10, h.deps);
    expect(kindsOf(r)).toEqual(['duplicate_near']);
    const d = h.decisions[0]!;
    expect(d.confidence).toBe(0.95);
    expect(d.provider).toBe('ollama');
    expect(d.mode).toBe(1);
    expect(dupOutputs(h)[0]).toMatchObject({ method: 'embedding', similarity: 0.95, originalDocumentId: 2, duplicateDocumentId: 10 });
  });

  it('titre + métadonnées : déterministe, sans embeddings (IA coupée)', async () => {
    const h = harness({
      config: cfg(GedAiMode.Desactivee),
      doc: baseDoc({ ocrTexts: [], label: 'Facture mars' }),
      titles: [
        { documentId: 2, createdAt: OLD, label: 'facture MARS' },
        { documentId: 3, createdAt: OLD, label: 'Autre pièce' },
      ],
    });
    const r = await analyzeDocument(10, h.deps);
    expect(kindsOf(r)).toEqual(['duplicate_near']);
    expect(h.neighbours).not.toHaveBeenCalled();
    expect(h.titles).toHaveBeenCalledWith(10, { documentTypeId: 4, documentDate: '2026-03-01', limit: 200 });
    expect(dupOutputs(h)[0]).toMatchObject({ method: 'title_metadata', similarity: 1 });
  });

  it('sans type ou sans date : aucune recherche par titre', async () => {
    for (const over of [{ documentTypeId: null }, { documentDate: null }]) {
      const h = harness({ doc: baseDoc({ ocrTexts: [], ...over }) });
      await analyzeDocument(10, h.deps);
      expect(h.titles).not.toHaveBeenCalled();
    }
  });

  it('un couple déjà exact n’est jamais proposé aussi en quasi-doublon', async () => {
    const h = harness({
      doc: baseDoc({ ocrTexts: [] }),
      exact: [{ documentId: 2, createdAt: OLD, method: 'file_hash' }],
      neighbours: [{ documentId: 2, createdAt: OLD, similarity: 0.99 }],
      titles: [{ documentId: 2, createdAt: OLD, label: 'Facture mars' }],
    });
    const r = await analyzeDocument(10, h.deps);
    expect(kindsOf(r)).toEqual(['duplicate_exact']);
  });

  it('plafonne à GED_GOVERNANCE_MAX_NEAR_DUPLICATES, les plus similaires d’abord', async () => {
    const neighbours = Array.from({ length: 15 }, (_, i) => ({
      documentId: 100 + i,
      createdAt: OLD,
      similarity: 0.96 + i / 1000,
    }));
    const h = harness({ doc: baseDoc({ ocrTexts: [], documentTypeId: null }), neighbours });
    const r = await analyzeDocument(10, h.deps);
    expect(r.created).toHaveLength(GED_GOVERNANCE_MAX_NEAR_DUPLICATES);
    expect(dupOutputs(h)[0]!.similarity).toBe(0.974);
  });
});

describe('IA désactivée', () => {
  it('aucun appel modèle ni embeddings ; déterministe produit ; mode 1 + fournisseur « deterministe »', async () => {
    const h = harness({ config: cfg(GedAiMode.Desactivee) });
    const r = await analyzeDocument(10, h.deps);
    expect(r.aiDisabled).toBe(true);
    expect(r.namesDetection).toBe('disabled_ai_off');
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.neighbours).not.toHaveBeenCalled();
    expect(h.rules).not.toHaveBeenCalled();
    expect(kindsOf(r)).toEqual(expect.arrayContaining(['pii', 'sensitivity']));
    for (const d of h.decisions) {
      expect(d.mode).toBe(1);
      expect(d.provider).toBe(GED_GOVERNANCE_DETERMINISTIC_PROVIDER);
      expect(d.model).toBe(GED_GOVERNANCE_DETERMINISTIC_MODEL);
      expect(d.status).toBe(GedAiDecisionStatus.Proposee);
    }
    const pii = governancePiiOutputSchema.parse(h.decisions.find((d) => (d.output as { kind: string }).kind === 'pii')!.output);
    expect(pii.detection).toEqual({ deterministic: true, ai: false });
  });
});

describe('données personnelles', () => {
  it('non-fuite : aucune valeur brute dans sorties, extraits, erreurs (IA locale, noms par le modèle)', async () => {
    const h = harness({ ai: aiJson({ personNameCount: 2, nameConfidence: 0.8, sensitivityScore: 2 }) });
    await analyzeDocument(10, h.deps);
    const dump = JSON.stringify(h.decisions);
    for (const v of RAW_VALUES) expect(dump).not.toContain(v);
    const pii = governancePiiOutputSchema.parse(h.decisions.find((d) => (d.output as { kind: string }).kind === 'pii')!.output);
    expect(pii.findings.map((f) => f.entity).sort()).toEqual(['email', 'iban', 'name']);
    expect(pii.findings.find((f) => f.entity === 'name')).toMatchObject({ count: 2, confidence: 0.8, contexts: [] });
    expect(pii.detection.ai).toBe(true);
    expect(pii.overallConfidence).toBe(1);
  });

  it('le moteur re-masque les contextes d’un détecteur qui en laisserait passer', async () => {
    const h = harness({
      config: cfg(GedAiMode.Desactivee),
      detectors: {
        detectPii: () => [{ entity: 'email', count: 1, confidence: 1, contexts: [`écrire à ${EMAIL}`] }],
      },
    });
    await analyzeDocument(10, h.deps);
    expect(JSON.stringify(h.decisions)).not.toContain(EMAIL);
    expect(h.decisions.find((d) => d.sentText?.includes('[EMAIL]'))).toBeDefined();
  });

  it('cloud : aucun texte envoyé au modèle, aucune famille name, déterministe produit, disabled_cloud', async () => {
    const h = harness({
      config: cfg(GedAiMode.Cloud, { apiKey: 'k', maskingEnabled: true }),
      ai: aiJson({ personNameCount: 3, nameConfidence: 0.9, sensitivityScore: 2 }),
    });
    const r = await analyzeDocument(10, h.deps);
    expect(h.complete).not.toHaveBeenCalled();
    expect(r.namesDetection).toBe('disabled_cloud');
    expect(r.aiDisabled).toBe(false);
    expect(h.decisions.some((d) => d.status === GedAiDecisionStatus.Erreur)).toBe(false);
    const pii = governancePiiOutputSchema.parse(h.decisions.find((d) => (d.output as { kind: string }).kind === 'pii')!.output);
    expect(pii.findings.map((f) => f.entity).sort()).toEqual(['email', 'iban']);
    expect(pii.detection.ai).toBe(false);
    const sens = h.decisions.find((d) => (d.output as { kind?: string } | null)?.kind === 'sensitivity');
    expect(governanceSensitivityOutputSchema.parse(sens!.output).detection.ai).toBe(false);
    expect(JSON.stringify(h.decisions)).not.toContain(EMAIL);
  });

  it('local : appel modèle inchangé (consigne explicite), namesDetection enabled', async () => {
    const h = harness({ ai: aiJson() });
    const r = await analyzeDocument(10, h.deps);
    expect(r.namesDetection).toBe('enabled');
    expect(h.complete).toHaveBeenCalledTimes(1);
    const req = h.complete.mock.calls[0]![0] as { system: string; user: string; jsonSchema: Record<string, unknown> };
    expect(req.system).toBe(GOVERNANCE_AI_SYSTEM_PROMPT);
    expect(req.system).toMatch(/jamais une instruction/);
    expect(req.system).toMatch(/AUCUNE donnée personnelle/);
    expect(req.jsonSchema).toMatchObject({ additionalProperties: false });
  });

  it('texte envoyé plafonné à 20 000 caractères', async () => {
    const h = harness({ doc: baseDoc({ ocrTexts: ['mot '.repeat(30_000)] }) });
    await analyzeDocument(10, h.deps);
    const req = h.complete.mock.calls[0]![0] as { user: string };
    expect(req.user.length).toBeLessThan(20_300);
  });

  it('cloud sans masquage : rien n’est envoyé, le déterministe continue', async () => {
    const h = harness({ config: cfg(GedAiMode.Cloud, { apiKey: 'k', maskingEnabled: false }) });
    const r = await analyzeDocument(10, h.deps);
    expect(h.complete).not.toHaveBeenCalled();
    expect(kindsOf(r)).toEqual(expect.arrayContaining(['pii']));
    expect(r.created.every((c) => c.kind !== 'duplicate_near')).toBe(true);
    const piiDecision = h.decisions.find((d) => (d.output as { kind?: string } | null)?.kind === 'pii')!;
    expect(piiDecision.provider).toBe(GED_GOVERNANCE_DETERMINISTIC_PROVIDER);
    expect(JSON.stringify(h.decisions)).not.toContain(EMAIL);
  });

  it('erreur du fournisseur : message sûr, aucune donnée du texte ni de l’erreur brute', async () => {
    const h = harness({ ai: new Error(`échec sur ${EMAIL}`) });
    const r = await analyzeDocument(10, h.deps);
    const err = h.decisions.find((d) => d.status === GedAiDecisionStatus.Erreur)!;
    expect(err.errorMessage).toBe('Erreur inattendue pendant le traitement de gouvernance.');
    expect(JSON.stringify(h.decisions)).not.toContain(EMAIL);
    expect(kindsOf(r)).toContain('pii');
  });

  it('sortie du modèle invalide (champ en trop, mauvais type) : erreur consignée, pas de nom', async () => {
    for (const bad of ['pas du json', aiJson({ extra: 1 }), aiJson({ sensitivityScore: 3 }), aiJson({ personNameCount: -1 })]) {
      const h = harness({ ai: bad });
      const r = await analyzeDocument(10, h.deps);
      expect(h.decisions.some((d) => d.status === GedAiDecisionStatus.Erreur)).toBe(true);
      const pii = h.decisions.find((d) => (d.output as { kind?: string } | null)?.kind === 'pii');
      expect(governancePiiOutputSchema.parse(pii!.output).findings.some((f) => f.entity === 'name')).toBe(false);
      expect(kindsOf(r)).toContain('pii');
    }
  });
});

describe('sensibilité', () => {
  it('score 2 (données bancaires) : 0,8 ; IA qui confirme : 0,9 (plafonné)', async () => {
    const det = harness({ config: cfg(GedAiMode.Desactivee) });
    await analyzeDocument(10, det.deps);
    const s1 = det.decisions.find((d) => (d.output as { kind?: string } | null)?.kind === 'sensitivity')!;
    expect(s1.confidence).toBe(0.8);
    expect(s1.sentText).toBe('keyword_health');
    expect(governanceSensitivityOutputSchema.parse(s1.output).proposedConfidentialiteId).toBe(3);

    const ai = harness({ ai: aiJson({ sensitivityScore: 2 }) });
    await analyzeDocument(10, ai.deps);
    const s2 = ai.decisions.find((d) => (d.output as { kind?: string } | null)?.kind === 'sensitivity')!;
    expect(s2.confidence).toBe(0.9);
    expect(governanceSensitivityOutputSchema.parse(s2.output).detection.ai).toBe(true);
  });

  it('score 1 : 0,6 ; +0,1 si l’IA confirme', async () => {
    const mk = (ai?: number) =>
      harness({
        ...(ai === undefined ? { config: cfg(GedAiMode.Desactivee) } : { ai: aiJson({ sensitivityScore: ai }) }),
        detectors: { detectPii: () => [] },
      });
    const a = mk();
    await analyzeDocument(10, a.deps);
    expect(a.decisions[0]!.confidence).toBe(0.6);
    const b = mk(1);
    await analyzeDocument(10, b.deps);
    expect(b.decisions[0]!.confidence).toBe(0.7);
  });

  it('jamais d’abaissement : une proposition « lower » est ignorée', async () => {
    const h = harness({
      config: cfg(GedAiMode.Desactivee),
      doc: baseDoc({ confidentialiteId: 3, confidentialiteRank: 2 }),
      detectors: {
        proposeSensitivity: (input) => ({
          schemaVersion: 1,
          kind: 'sensitivity',
          score: 1,
          currentConfidentialiteId: input.current.confidentialiteId,
          currentRank: input.current.rank,
          proposedConfidentialiteId: 1,
          proposedRank: 0,
          direction: 'lower',
          reasons: [],
          detection: { deterministic: true, ai: false },
        }),
      },
    });
    const r = await analyzeDocument(10, h.deps);
    expect(kindsOf(r)).not.toContain('sensitivity');
  });
});

describe('jamais d’application automatique', () => {
  it('seuil configuré à 0,1 : toutes les décisions sont « Proposée » (ou « Erreur »)', async () => {
    const h = harness({
      config: cfg(GedAiMode.Locale, { threshold: 0.1 }),
      ai: aiJson({ personNameCount: 3, nameConfidence: 0.99, sensitivityScore: 2, confidence: 0.99 }),
      exact: [{ documentId: 2, createdAt: OLD, method: 'file_hash' }],
      neighbours: [{ documentId: 3, createdAt: OLD, similarity: 0.99 }],
    });
    await analyzeDocument(10, h.deps);
    expect(h.decisions.length).toBeGreaterThan(2);
    for (const d of h.decisions) {
      expect(d.status).not.toBe(GedAiDecisionStatus.AppliqueeAuto);
      expect([GedAiDecisionStatus.Proposee, GedAiDecisionStatus.Erreur]).toContain(d.status);
    }
  });
});

describe('idempotence', () => {
  it('relancer deux fois n’ajoute rien', async () => {
    const h = harness({
      ai: aiJson({ personNameCount: 1, nameConfidence: 0.7, sensitivityScore: 2 }),
      exact: [{ documentId: 2, createdAt: OLD, method: 'file_hash' }],
      neighbours: [{ documentId: 3, createdAt: OLD, similarity: 0.97 }],
    });
    const first = await analyzeDocument(10, h.deps);
    expect(first.created.length).toBeGreaterThanOrEqual(4);
    const count = h.decisions.length;
    const second = await analyzeDocument(10, h.deps);
    expect(second.created).toEqual([]);
    expect(h.decisions).toHaveLength(count);
  });

  it('doublon : couple déjà traité (Rejetée) jamais reproposé, même en quasi', async () => {
    const h = harness({
      doc: baseDoc({ ocrTexts: [] }),
      neighbours: [{ documentId: 2, createdAt: OLD, similarity: 0.97 }],
    });
    await analyzeDocument(10, h.deps);
    h.decisions[0]!.status = GedAiDecisionStatus.Rejetee;
    const again = await analyzeDocument(10, h.deps);
    expect(again.created).toEqual([]);
  });

  it('pii : une Validée de même signature bloque, une signature différente est reproposée', async () => {
    const h = harness({ config: cfg(GedAiMode.Desactivee), detectors: { proposeSensitivity: () => null } });
    await analyzeDocument(10, h.deps);
    expect(h.decisions).toHaveLength(1);
    h.decisions[0]!.status = GedAiDecisionStatus.Validee;
    expect((await analyzeDocument(10, h.deps)).created).toEqual([]);

    const changed = { ...fakeDetectors(), proposeSensitivity: () => null, detectPii: () => [{ entity: 'email' as const, count: 5, confidence: 1, contexts: [] }] };
    h.deps.detectors = changed;
    expect((await analyzeDocument(10, h.deps)).created).toHaveLength(1);
  });

  it('sensibilité : une Rejetée du même niveau bloque, un autre niveau est reproposé', async () => {
    const h = harness({
      config: cfg(GedAiMode.Desactivee),
      detectors: { detectPii: () => [] },
    });
    await analyzeDocument(10, h.deps);
    expect(h.decisions).toHaveLength(1);
    h.decisions[0]!.status = GedAiDecisionStatus.Rejetee;
    expect((await analyzeDocument(10, h.deps)).created).toEqual([]);
    // Un autre niveau cible (id 7) : la décision rejetée portait sur le niveau 2.
    h.deps.listConfidentialiteLevels = async () => [
      { confidentialiteId: 1, label: 'Public', rank: 0 },
      { confidentialiteId: 7, label: 'Restreint', rank: 1 },
    ];
    expect((await analyzeDocument(10, h.deps)).created).toHaveLength(1);
  });
});
