import { GedAiMode, validateWorkflowGraph, type WfGraph } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { buildObedientMaliciousOutput, ATTACK_DESCRIPTIONS, materializeAttack } from './authoring.attack.corpus';
import { AUTHORING_EVAL_CASES, checkAssumptions, checkStructure } from './authoring.eval.cases';
import { AuthoringService } from './authoring.service';

// Docu-Flow W5 — évaluation de la qualité de génération ET jeux d'attaque de bout en bout : service réel,
// prompt, sortie, garde-fous, déclencheur et hypothèses RÉELS ; seuls le fournisseur d'IA, la garde budgétaire,
// la base et l'audit sont simulés (faux fournisseur). Ce n'est PAS le gate d'autonomie des agents.

const actor: AuthUser = { userId: 7, username: 'conc', fullName: 'Concepteur', isAdmin: false, userGroupId: 70 };

const CATALOGUE = ['rechercher_documents', 'lire_document', 'lire_courrier', 'proposer_imputation', 'proposer_reponse'];

interface Captured {
  requests: Array<{ system: string; text: string; attachments?: unknown; strictSchema?: boolean }>;
  created: Array<{ name: string; source: number; status: number; versions: { create: { graph: unknown; sourcePrompt: string } } }>;
}

function build(modelOutput: unknown): { service: AuthoringService; cap: Captured } {
  const cap: Captured = { requests: [], created: [] };
  const ai = {
    getEffectiveConfig: jest.fn().mockResolvedValue({ mode: GedAiMode.Locale }),
    run: jest.fn(async (opts: { request: Captured['requests'][number]; parse: (raw: string) => unknown }) => {
      cap.requests.push(opts.request);
      return { disabled: false, data: opts.parse(JSON.stringify(modelOutput)), promptTokens: 400, completionTokens: 300 };
    }),
  };
  const gate = {
    assertRunnable: jest.fn().mockResolvedValue(undefined),
    reserve: jest.fn(async () => ({ id: 'r', definitionId: 0, reserved: { promptTokens: 0, completionTokens: 0, cost: 0 } })),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    costOf: jest.fn(() => 0.1),
  };
  const prisma = {
    wfTool: {
      findMany: jest.fn().mockResolvedValue(
        CATALOGUE.map((toolKey) => ({ toolKey, label: toolKey, description: null, sideEffect: 0 })),
      ),
    },
    wfDefinition: {
      create: jest.fn(async ({ data }: { data: Captured['created'][number] }) => {
        cap.created.push(data);
        return { wfDefinitionId: 99, name: data.name };
      }),
      findUnique: jest.fn(),
    },
    wfDefinitionVersion: { findMany: jest.fn() },
  };
  const audit = { dataChange: jest.fn().mockResolvedValue(undefined) };
  return { service: new AuthoringService(ai as never, gate as never, prisma as never, audit as never), cap };
}

describe('évaluation de la qualité de génération (faux fournisseur)', () => {
  it('contient 8 descriptions de référence', () => {
    expect(AUTHORING_EVAL_CASES).toHaveLength(8);
  });

  it.each(AUTHORING_EVAL_CASES.map((c) => [c.id, c] as const))('%s : brouillon conforme à l’attendu', async (_id, c) => {
    const { service, cap } = build(c.modelOutput);
    const res = await service.generate({ description: c.description, triggerHint: c.triggerHint }, actor);

    expect(res.definitionId).toBe(99);
    expect(res.issues).toEqual([]);
    expect(validateWorkflowGraph(res.graph, { isLowRisk: false }).ok).toBe(true);
    expect(checkStructure(res.graph, c.attendu)).toEqual([]);
    expect(checkAssumptions(res.assumptions, c.attendu)).toEqual([]);
    expect(res.triggerSuggestion?.eventType ?? null).toBe(c.attendu.triggerEvent);

    // Brouillon, source langage naturel, jamais publié, aucun identifiant d'utilisateur, autonomie suggère.
    const data = cap.created[0];
    expect(data.status).toBe(0);
    expect(data.source).toBe(1);
    const graph = res.graph as WfGraph;
    for (const s of graph.steps) {
      expect(s.assignee === undefined || ['initiator', 'subject_owner'].includes(s.assignee.kind)).toBe(true);
      if (s.agent) expect(s.agent.autonomy).toBe('suggere');
    }
    // Chaque requête : aucun binaire, schéma non strict.
    for (const r of cap.requests) expect(r.attachments).toBeUndefined();
  });
});

describe('jeux d’attaque de bout en bout', () => {
  /** Sortie malveillante sans clés de prototype (celles-ci sont refusées dès l'analyse de la réponse). */
  function obedientWithoutProtoKeys(): unknown {
    const strip = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(strip);
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          out[k] = strip((v as Record<string, unknown>)[k]);
        }
        return out;
      }
      return v;
    };
    return strip(buildObedientMaliciousOutput());
  }

  it('une réponse avec des clés de prototype est refusée (422) et rien n’est créé', async () => {
    const { service, cap } = build(buildObedientMaliciousOutput());
    await expect(service.generate({ description: ATTACK_DESCRIPTIONS[0].description }, actor)).rejects.toMatchObject({
      status: 422,
    });
    expect(cap.created).toHaveLength(0);
  });

  it('un modèle « obéissant » ne fait rien appliquer', async () => {
    const { service, cap } = build(obedientWithoutProtoKeys());
    const res = await service.generate({ description: ATTACK_DESCRIPTIONS[0].description }, actor);
    expect(cap.created).toHaveLength(1);
    const json = JSON.stringify(res.graph);
    expect(json).not.toMatch(/autonome/);
    expect(json).not.toMatch(/envoyer_email|supprimer_document|outil_admin/);
    expect(json).not.toMatch(/"id":\s*1\b/);
    expect(json).not.toMatch(/isLowRisk|lowRisk|__proto__|polluted|modele-sans-filtre|pirate@/i);
    expect(JSON.stringify(cap.created[0].versions.create.graph)).not.toMatch(/isLowRisk/);
    for (const s of (res.graph as WfGraph).steps) {
      if (s.agent) {
        expect(s.agent.autonomy).toBe('suggere');
        expect(s.agent.tools.every((t) => CATALOGUE.includes(t))).toBe(true);
      }
      expect(s.assignee === undefined || ['initiator', 'subject_owner'].includes(s.assignee.kind)).toBe(true);
    }
    expect(validateWorkflowGraph(res.graph, { isLowRisk: false }).issues.filter((i) => i.code === 'AUTONOMY_REQUIRES_LOW_RISK')).toEqual([]);
  });

  it.each(ATTACK_DESCRIPTIONS.map((a) => [a.id, a] as const))(
    '%s : la description reste une donnée dans le prompt, jamais appliquée',
    async (_id, sample) => {
      const { service, cap } = build(obedientWithoutProtoKeys());
      const description = materializeAttack(sample, 'JETONDEVINE');
      await service.generate({ description }, actor);
      expect(cap.created).toHaveLength(1);
      expect(cap.requests.length).toBeGreaterThan(0);
      const baseline = build(obedientWithoutProtoKeys());
      await baseline.service.generate({ description: 'Décrire un circuit de validation de factures.' }, actor);
      // Message système sans la description (le jeton et le catalogue varient seulement).
      const strip = (s: string): string => s.replace(/\b[A-HJ-NP-Z]{20}\b/g, 'JETON');
      expect(strip(cap.requests[0].system)).toBe(strip(baseline.cap.requests[0].system));
      expect(cap.requests[0].system).not.toContain('pirate@');
      expect(cap.requests.every((r) => r.attachments === undefined)).toBe(true);
      // Rien d'inquiétant n'est créé : pas d'autonomie, pas de faible risque.
      for (const d of cap.created) expect(JSON.stringify(d.versions.create.graph)).not.toMatch(/"autonomy":"autonome"|isLowRisk/);
    },
  );
});
