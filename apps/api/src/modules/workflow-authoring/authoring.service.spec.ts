import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GedAiMode, GedAiTask, WfDefinitionSource, WfDefinitionStatus } from '@archivage/types';
import { AiMaskingRequiredError, AiProviderError } from '../ai/ai.types';
import { AiConfigurationError } from '../ai/ai-provider.factory';
import type { AuthUser } from '../auth/auth.types';
import { AgentBlockedError, type AgentBlockReason } from '../workflow-agents/agent.contracts';
import { AuthoringOutputError, WF_AUTHORING_PROMPT_VERSION } from './authoring.contracts';
import { AuthoringService } from './authoring.service';

// Les fonctions pures des autres exécutants sont remplacées : on teste l'orchestration du service.
jest.mock('./authoring.prompt', () => ({
  buildAuthoringPrompt: jest.fn(),
}));
jest.mock('./authoring.output', () => ({ parseAuthoringOutput: jest.fn() }));
jest.mock('./authoring.guardrails', () => ({ applyGuardrails: jest.fn() }));
jest.mock('./authoring.trigger', () => ({ suggestTrigger: jest.fn() }));
jest.mock('./authoring.assumptions', () => ({ extractFigures: jest.fn() }));
jest.mock('./authoring.explain', () => ({ explainGraph: jest.fn() }));

import { extractFigures } from './authoring.assumptions';
import { explainGraph } from './authoring.explain';
import { applyGuardrails } from './authoring.guardrails';
import { parseAuthoringOutput } from './authoring.output';
import { buildAuthoringPrompt } from './authoring.prompt';
import { suggestTrigger } from './authoring.trigger';

const actor: AuthUser = { userId: 7, username: 'conc', fullName: 'Concepteur', isAdmin: false, userGroupId: 70 };
const machine: AuthUser = { userId: 0, username: 'scan', isAdmin: false, userGroupId: null, isScanAgent: true };

interface CreateData {
  name: string;
  description: string | null;
  versions: { create: { sourcePrompt: string; graph: unknown; versionNumber: number } };
}

const SECRET = 'SECRET-DESCRIPTION-MARQUEUR';
const DESCRIPTION = `${SECRET} : valider les factures de plus de 5000 euros par le DAF.`;

const goodGraph = {
  schemaVersion: 1,
  start: 'saisie',
  steps: [
    { key: 'saisie', name: 'Saisie', type: 'formulaire', next: [{ to: 'visa' }] },
    { key: 'visa', name: 'Visa', type: 'validation', next: [] },
  ],
};
// Forme correcte, atteignabilité en défaut : étape orpheline.
const semanticBadGraph = {
  ...goodGraph,
  steps: [...goodGraph.steps, { key: 'orpheline', name: 'Orpheline', type: 'validation', next: [] }],
};
const shapeBadGraph = { schemaVersion: 1 };

const REMOVED = { tools: 1, autonomy: 0, assignees: 0, configKeys: 0, suspiciousText: 0 };

function output(graph: unknown, extra: Record<string, unknown> = {}) {
  return {
    name: 'Validation des factures',
    description: 'Circuit de validation.',
    graph,
    assumptions: ['Seuil de 5000 euros supposé.'],
    trigger: null,
    ...extra,
  };
}

interface Rig {
  service: AuthoringService;
  ai: { getEffectiveConfig: jest.Mock; run: jest.Mock };
  gate: Record<'assertRunnable' | 'reserve' | 'settle' | 'release' | 'costOf', jest.Mock>;
  prisma: {
    wfTool: { findMany: jest.Mock };
    wfDefinition: { create: jest.Mock; findUnique: jest.Mock };
    wfDefinitionVersion: { findMany: jest.Mock };
  };
  audit: { dataChange: jest.Mock };
  /** Sorties successives du modèle (une par appel). */
  outputs: unknown[];
}

function rig(opts: { mode?: GedAiMode } = {}): Rig {
  const outputs: unknown[] = [];
  const ai = {
    getEffectiveConfig: jest.fn().mockResolvedValue({ mode: opts.mode ?? GedAiMode.Locale }),
    run: jest.fn(async () => {
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return { disabled: false, data: next, promptTokens: 100, completionTokens: 50 };
    }),
  };
  const gate = {
    assertRunnable: jest.fn().mockResolvedValue(undefined),
    reserve: jest.fn(async () => ({ id: 'r1', definitionId: 0, reserved: { promptTokens: 0, completionTokens: 0, cost: 0 } })),
    settle: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    costOf: jest.fn(() => 0.5),
  };
  const prisma = {
    wfTool: {
      findMany: jest.fn().mockResolvedValue([
        { toolKey: 'search_documents', label: 'Recherche', description: null, sideEffect: 0 },
      ]),
    },
    wfDefinition: {
      create: jest.fn(async ({ data }: { data: { name: string } }) => ({ wfDefinitionId: 42, name: data.name })),
      findUnique: jest.fn(),
    },
    wfDefinitionVersion: { findMany: jest.fn() },
  };
  const audit = { dataChange: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthoringService(ai as never, gate as never, prisma as never, audit as never);
  service.now = () => new Date('2026-11-21T10:00:00.000Z');
  return { service, ai, gate, prisma, audit, outputs };
}

const auditPayloads = (r: Rig): Array<Record<string, unknown>> =>
  r.audit.dataChange.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeEach(() => {
  jest.clearAllMocks();
  (buildAuthoringPrompt as jest.Mock).mockImplementation(() => ({
    system: 'a'.repeat(300),
    text: 'b'.repeat(300),
    jsonSchema: { name: 'wf', schema: {} },
    maxOutputTokens: 6000,
  }));
  (parseAuthoringOutput as jest.Mock).mockImplementation((s: string) => s);
  (applyGuardrails as jest.Mock).mockImplementation((graph: unknown) => ({
    graph,
    notes: ['Un outil inconnu a été retiré.'],
    toComplete: [],
    removed: REMOVED,
  }));
  (suggestTrigger as jest.Mock).mockReturnValue(null);
  (extractFigures as jest.Mock).mockReturnValue(['Montant lu dans la description : 5000 euros.']);
});

describe('AuthoringService.generate', () => {
  it('refuse une identité machine ou sans groupe (403), sans rien écrire', async () => {
    const r = rig();
    await expect(r.service.generate({ description: DESCRIPTION }, machine)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      r.service.generate({ description: DESCRIPTION }, { ...actor, userGroupId: null }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(r.ai.run).not.toHaveBeenCalled();
    expect(r.prisma.wfDefinition.create).not.toHaveBeenCalled();
  });

  describe('IA désactivée', () => {
    it('mode désactivé : 409, aucune garde, aucun appel, aucune création, audit écrit', async () => {
      const r = rig({ mode: GedAiMode.Desactivee });
      const err = await r.service.generate({ description: DESCRIPTION }, actor).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toBe('IA désactivée pour ce client');
      expect(r.gate.assertRunnable).not.toHaveBeenCalled();
      expect(r.gate.reserve).not.toHaveBeenCalled();
      expect(r.ai.run).not.toHaveBeenCalled();
      expect(r.prisma.wfDefinition.create).not.toHaveBeenCalled();
      expect(JSON.parse(auditPayloads(r)[0].newValue as string).outcome).toBe('ai_disabled');
    });

    it('run renvoie { disabled: true } : 409, réservation libérée, aucune création', async () => {
      const r = rig();
      r.ai.run.mockResolvedValueOnce({ disabled: true, message: 'x' });
      await expect(r.service.generate({ description: DESCRIPTION }, actor)).rejects.toBeInstanceOf(ConflictException);
      expect(r.gate.reserve).toHaveBeenCalledTimes(1);
      expect(r.gate.release).toHaveBeenCalledTimes(1);
      expect(r.gate.settle).not.toHaveBeenCalled();
      expect(r.prisma.wfDefinition.create).not.toHaveBeenCalled();
    });

    it('la garde répond ai_disabled : 409', async () => {
      const r = rig();
      r.gate.assertRunnable.mockRejectedValueOnce(new AgentBlockedError('ai_disabled', 'x'));
      const err = await r.service.generate({ description: DESCRIPTION }, actor).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toBe('IA désactivée pour ce client');
    });
  });

  describe('garde de budget et arrêt d’urgence', () => {
    const cases: Array<[AgentBlockReason, number, string]> = [
      ['emergency_stop_global', 409, 'Arrêt d’urgence des agents actif : la génération est suspendue.'],
      ['emergency_stop_workflow', 409, 'Arrêt d’urgence des agents actif : la génération est suspendue.'],
      ['budget_exceeded_global', 429, 'Budget IA atteint : génération refusée.'],
      ['budget_exceeded_workflow', 429, 'Budget IA atteint : génération refusée.'],
      ['budget_unavailable', 503, 'Budget IA illisible : la génération est suspendue par prudence.'],
    ];
    it.each(cases)('%s => %i, aucun appel modèle, aucune création, audit écrit', async (reason, status, message) => {
      for (const stage of ['assertRunnable', 'reserve'] as const) {
        const r = rig();
        r.gate[stage].mockRejectedValueOnce(new AgentBlockedError(reason, 'x'));
        const err = (await r.service.generate({ description: DESCRIPTION }, actor).catch((e: unknown) => e)) as HttpException;
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(status);
        expect(err.message).toBe(message);
        expect(r.ai.run).not.toHaveBeenCalled();
        expect(r.prisma.wfDefinition.create).not.toHaveBeenCalled();
        expect(JSON.parse(auditPayloads(r)[0].newValue as string).outcome).toBe(`blocked:${reason}`);
      }
    });

    it('erreur non typée de la garde : échec fermé en 503', async () => {
      const r = rig();
      r.gate.assertRunnable.mockRejectedValueOnce(new Error('db down'));
      await expect(r.service.generate({ description: DESCRIPTION }, actor)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(r.ai.run).not.toHaveBeenCalled();
    });

    it('coût illisible : 503, aucun appel', async () => {
      const r = rig();
      r.gate.costOf.mockReturnValue(Number.NaN);
      await expect(r.service.generate({ description: DESCRIPTION }, actor)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(r.ai.run).not.toHaveBeenCalled();
      expect(r.gate.reserve).not.toHaveBeenCalled();
    });

    it('réserve avant l’appel avec une estimation prudente (definitionId 0) puis règle les jetons réels', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph));
      const order: string[] = [];
      r.gate.reserve.mockImplementationOnce(async () => {
        order.push('reserve');
        return { id: 'r1', definitionId: 0, reserved: { promptTokens: 0, completionTokens: 0, cost: 0 } };
      });
      r.ai.run.mockImplementationOnce(async () => {
        order.push('run');
        return { disabled: false, data: output(goodGraph), promptTokens: 111, completionTokens: 22 };
      });
      r.gate.settle.mockImplementationOnce(async () => {
        order.push('settle');
      });
      await r.service.generate({ description: DESCRIPTION }, actor);
      expect(order).toEqual(['reserve', 'run', 'settle']);
      expect(r.gate.assertRunnable).toHaveBeenCalledWith({ definitionId: 0 });
      expect(r.gate.reserve).toHaveBeenCalledWith(
        { definitionId: 0 },
        { promptTokens: 200, completionTokens: 6000, cost: 0.5 },
      );
      expect(r.gate.settle).toHaveBeenCalledWith(expect.anything(), { promptTokens: 111, completionTokens: 22, cost: 0.5 });
      expect(r.gate.release).not.toHaveBeenCalled();
    });

    it('règle l’estimation quand le fournisseur ne renvoie pas de jetons', async () => {
      const r = rig();
      r.ai.run.mockResolvedValueOnce({ disabled: false, data: output(goodGraph), promptTokens: null, completionTokens: null });
      await r.service.generate({ description: DESCRIPTION }, actor);
      expect(r.gate.settle).toHaveBeenCalledWith(expect.anything(), { promptTokens: 200, completionTokens: 6000, cost: 0.5 });
    });
  });

  describe('appel au modèle', () => {
    it('envoie la requête champ par champ, sans pièce jointe', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph));
      await r.service.generate({ description: DESCRIPTION }, actor);
      const opts = r.ai.run.mock.calls[0][0] as Record<string, unknown>;
      expect(opts.task).toBe(GedAiTask.Autre);
      expect(opts.request).not.toHaveProperty('attachments');
      expect(Object.keys(opts.request as object).sort()).toEqual(
        ['jsonSchema', 'maxOutputTokens', 'strictSchema', 'system', 'text'].sort(),
      );
      expect((opts.request as { strictSchema: boolean }).strictSchema).toBe(false);
      expect(opts).toMatchObject({
        promptVersion: WF_AUTHORING_PROMPT_VERSION,
        requestedBy: 70,
        autoApply: false,
        documentId: null,
        parse: parseAuthoringOutput,
      });
      expect(opts).not.toHaveProperty('allowLocalAttachments');
    });

    it('construit le prompt avec le catalogue actif et un jeton propre à chaque appel', async () => {
      const r = rig();
      r.outputs.push(output(semanticBadGraph), output(goodGraph));
      await r.service.generate({ description: DESCRIPTION, triggerHint: 'mail.arrived' }, actor);
      expect(r.prisma.wfTool.findMany).toHaveBeenCalledWith({ where: { isEnabled: true } });
      const calls = (buildAuthoringPrompt as jest.Mock).mock.calls.map((c) => c[0]);
      expect(calls[0].tools).toEqual([{ key: 'search_documents', label: 'Recherche', description: null, sideEffect: 0 }]);
      expect(calls[0].triggerHint).toBe('mail.arrived');
      expect(calls[0].nonce).not.toBe(calls[1].nonce);
      expect((applyGuardrails as jest.Mock).mock.calls[0][1].allowedTools).toEqual(new Set(['search_documents']));
    });

    it('masquage refusé : 409, réservation libérée, rien de créé', async () => {
      const r = rig();
      r.outputs.push(new AiMaskingRequiredError('x'));
      const err = (await r.service.generate({ description: DESCRIPTION }, actor).catch((e: unknown) => e)) as HttpException;
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe('Envoi refusé : le masquage des données est obligatoire pour ce mode d’IA.');
      expect(r.gate.release).toHaveBeenCalledTimes(1);
      expect(r.gate.settle).not.toHaveBeenCalled();
      expect(r.prisma.wfDefinition.create).not.toHaveBeenCalled();
      expect(JSON.parse(auditPayloads(r)[0].newValue as string).outcome).toBe('masking_required');
    });

    it('fournisseur en erreur : 502 sans fuite du message, estimation réglée, audit écrit', async () => {
      const r = rig();
      r.outputs.push(new AiProviderError('clé sk-123 invalide'));
      const err = (await r.service.generate({ description: DESCRIPTION }, actor).catch((e: unknown) => e)) as HttpException;
      expect(err).toBeInstanceOf(BadGatewayException);
      expect(err.message).toBe('Le service d’IA n’a pas pu répondre. Réessayez plus tard.');
      expect(JSON.stringify(err.getResponse())).not.toContain('sk-123');
      expect(r.gate.settle).toHaveBeenCalledTimes(1);
      expect(r.prisma.wfDefinition.create).not.toHaveBeenCalled();
      expect(JSON.parse(auditPayloads(r)[0].newValue as string).outcome).toBe('provider_error');
    });

    it('configuration IA inexploitable (avant tout appel) : 502, réservation LIBÉRÉE et non soldée', async () => {
      const r = rig();
      r.outputs.push(new AiConfigurationError('endpoint absent'));
      const err = (await r.service.generate({ description: DESCRIPTION }, actor).catch((e: unknown) => e)) as HttpException;
      expect(err).toBeInstanceOf(BadGatewayException);
      expect(r.gate.release).toHaveBeenCalledTimes(1);
      expect(r.gate.settle).not.toHaveBeenCalled();
      expect(JSON.parse(auditPayloads(r)[0].newValue as string).outcome).toBe('provider_error');
    });

    it('erreur inattendue du modèle : 502', async () => {
      const r = rig();
      r.outputs.push(new TypeError('boom'));
      await expect(r.service.generate({ description: DESCRIPTION }, actor)).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('création du brouillon', () => {
    it('sortie valide : brouillon créé (langage naturel, brouillon, v1, pas de faible risque)', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph));
      const res = await r.service.generate({ description: DESCRIPTION }, actor);

      expect(r.ai.run).toHaveBeenCalledTimes(1);
      expect(r.prisma.wfDefinition.create).toHaveBeenCalledTimes(1);
      const data = (r.prisma.wfDefinition.create.mock.calls[0][0] as { data: CreateData }).data;
      expect(data).toMatchObject({
        name: 'Validation des factures',
        description: 'Circuit de validation.',
        status: WfDefinitionStatus.Draft,
        source: WfDefinitionSource.NaturalLanguage,
        createdBy: 70,
      });
      expect(data).not.toHaveProperty('isLowRisk');
      expect(data.versions.create).toMatchObject({ versionNumber: 1, status: 0, createdBy: 70, graph: goodGraph });
      expect(data.versions.create.sourcePrompt).toContain(SECRET);

      expect(res.definitionId).toBe(42);
      expect(res.name).toBe('Validation des factures');
      expect(res.graph).toEqual(goodGraph);
      expect(res.issues).toEqual([]);
      expect(res.assumptions).toEqual([
        'Seuil de 5000 euros supposé.',
        'Un outil inconnu a été retiré.',
        'Montant lu dans la description : 5000 euros.',
        'Ce brouillon est à relire : rien n’est publié.',
      ]);
      expect(res.triggerSuggestion).toBeNull();
    });

    it('source_prompt assaini et tronqué, nom et description assainis', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph, { name: `  <b>Nom</b>\n\u0000sur\nplusieurs lignes ${'x'.repeat(300)}`, description: '<i>d</i>' }));
      const long = `<script>alert(1)</script>${'y'.repeat(3900)}`;
      await r.service.generate({ description: long }, actor);
      const data = (r.prisma.wfDefinition.create.mock.calls[0][0] as { data: CreateData }).data;
      const prompt = data.versions.create.sourcePrompt as string;
      expect(Array.from(prompt).length).toBeLessThanOrEqual(2000);
      expect(prompt).not.toMatch(/[<>]/);
      expect(data.name).not.toMatch(/[<>]/);
      expect(data.name).not.toContain(String.fromCharCode(0));
      expect(data.name.includes(String.fromCharCode(10))).toBe(false);
      expect(Array.from(data.name as string).length).toBeLessThanOrEqual(120);
      expect(data.description).not.toMatch(/[<>]/);
    });

    it('nom vide : repli daté en UTC', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph, { name: '   ', description: '' }));
      const res = await r.service.generate({ description: DESCRIPTION }, actor);
      expect(res.name).toBe('Workflow décrit en langage naturel 2026-11-21');
      expect((r.prisma.wfDefinition.create.mock.calls[0][0] as { data: CreateData }).data.description).toBeNull();
    });

    it('collision de nom : suffixe (2), (3)…', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph));
      r.prisma.wfDefinition.create
        .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
        .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
      const res = await r.service.generate({ description: DESCRIPTION }, actor);
      expect(res.name).toBe('Validation des factures (3)');
      expect(r.prisma.wfDefinition.create).toHaveBeenCalledTimes(3);
      expect(r.ai.run).toHaveBeenCalledTimes(1);
    });

    it('collisions répétées : 409 après 5 réessais, rien d’autre n’est créé', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph));
      r.prisma.wfDefinition.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
      await expect(r.service.generate({ description: DESCRIPTION }, actor)).rejects.toBeInstanceOf(ConflictException);
      expect(r.prisma.wfDefinition.create).toHaveBeenCalledTimes(6);
      expect(JSON.parse(auditPayloads(r)[0].newValue as string).outcome).toBe('name_taken');
    });

    it('autre erreur de base : propagée, audit « error »', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph));
      r.prisma.wfDefinition.create.mockRejectedValueOnce(new Error('db'));
      await expect(r.service.generate({ description: DESCRIPTION }, actor)).rejects.toThrow('db');
      expect(JSON.parse(auditPayloads(r)[0].newValue as string).outcome).toBe('error');
    });

    it('la suggestion de déclencheur est renvoyée, jamais créée', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph, { trigger: { eventType: 'mail.arrived' } }));
      const suggestion = { eventType: 'mail.arrived', label: 'Courrier', conditions: {}, reason: 'r', incomplete: [] };
      (suggestTrigger as jest.Mock).mockReturnValue(suggestion);
      const res = await r.service.generate({ description: DESCRIPTION, triggerHint: 'mail.arrived' }, actor);
      expect(res.triggerSuggestion).toEqual(suggestion);
      expect((suggestTrigger as jest.Mock).mock.calls[0][0]).toMatchObject({
        description: DESCRIPTION,
        triggerHint: 'mail.arrived',
        modelTrigger: { eventType: 'mail.arrived' },
      });
    });
  });

  describe('réparation (une seule passe)', () => {
    it('sortie invalide puis réparée : exactement 2 appels, 2 gardes, 2 règlements', async () => {
      const r = rig();
      r.outputs.push(output(semanticBadGraph), output(goodGraph));
      const res = await r.service.generate({ description: DESCRIPTION }, actor);
      expect(r.ai.run).toHaveBeenCalledTimes(2);
      expect(r.gate.assertRunnable).toHaveBeenCalledTimes(2);
      expect(r.gate.reserve).toHaveBeenCalledTimes(2);
      expect(r.gate.settle).toHaveBeenCalledTimes(2);
      expect(res.issues).toEqual([]);
      const repair = (buildAuthoringPrompt as jest.Mock).mock.calls[1][0].repair;
      expect(repair.previousGraph).toEqual(semanticBadGraph);
      expect(repair.issues.length).toBeGreaterThan(0);
      expect(repair.issues.length).toBeLessThanOrEqual(30);
      expect(repair.issues.every((m: string) => m.length <= 300)).toBe(true);
      const payload = JSON.parse(auditPayloads(r)[0].newValue as string);
      expect(payload).toMatchObject({ outcome: 'created', repairUsed: true, promptTokens: 200, completionTokens: 100 });
    });

    it('jamais plus de 2 appels, même si tout reste invalide', async () => {
      const r = rig();
      r.outputs.push(output(shapeBadGraph), output(shapeBadGraph), output(goodGraph));
      await expect(r.service.generate({ description: DESCRIPTION }, actor)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(r.ai.run).toHaveBeenCalledTimes(2);
    });

    it('sémantique invalide après réparation : brouillon créé et problèmes renvoyés', async () => {
      const r = rig();
      r.outputs.push(output(semanticBadGraph), output(semanticBadGraph));
      const res = await r.service.generate({ description: DESCRIPTION }, actor);
      expect(r.ai.run).toHaveBeenCalledTimes(2);
      expect(r.prisma.wfDefinition.create).toHaveBeenCalledTimes(1);
      expect(res.issues.some((i) => i.code === 'UNREACHABLE_STEP' && i.stepKey === 'orpheline')).toBe(true);
      expect(res.definitionId).toBe(42);
    });

    it('forme invalide après réparation : 422 AUTHORING_INVALID, rien n’est créé', async () => {
      const r = rig();
      r.outputs.push(output(semanticBadGraph), output(shapeBadGraph));
      const err = (await r.service.generate({ description: DESCRIPTION }, actor).catch((e: unknown) => e)) as UnprocessableEntityException;
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(err.getResponse()).toMatchObject({ code: 'AUTHORING_INVALID' });
      expect((err.getResponse() as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
      expect(r.prisma.wfDefinition.create).not.toHaveBeenCalled();
      expect(JSON.parse(auditPayloads(r)[0].newValue as string).outcome).toBe('invalid_output');
    });

    it('sortie illisible deux fois : 422 sans création ; illisible puis valide : créé', async () => {
      const r1 = rig();
      r1.outputs.push(new AuthoringOutputError('x'), new AuthoringOutputError('x'));
      await expect(r1.service.generate({ description: DESCRIPTION }, actor)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(r1.ai.run).toHaveBeenCalledTimes(2);
      expect(r1.prisma.wfDefinition.create).not.toHaveBeenCalled();

      const r2 = rig();
      r2.outputs.push(new AuthoringOutputError('x'), output(goodGraph));
      const res = await r2.service.generate({ description: DESCRIPTION }, actor);
      expect(res.definitionId).toBe(42);
      expect((buildAuthoringPrompt as jest.Mock).mock.calls[1][0].repair.previousGraph).toBeNull();
    });

    it('le refus de la garde au second appel interrompt la réparation', async () => {
      const r = rig();
      r.outputs.push(output(semanticBadGraph));
      r.gate.reserve
        .mockResolvedValueOnce({ id: 'r1', definitionId: 0, reserved: { promptTokens: 0, completionTokens: 0, cost: 0 } })
        .mockRejectedValueOnce(new AgentBlockedError('budget_exceeded_global', 'x'));
      const err = (await r.service.generate({ description: DESCRIPTION }, actor).catch((e: unknown) => e)) as HttpException;
      expect(err.getStatus()).toBe(429);
      expect(r.ai.run).toHaveBeenCalledTimes(1);
      expect(r.prisma.wfDefinition.create).not.toHaveBeenCalled();
    });
  });

  describe('audit', () => {
    it('succès : objet wf_authoring:definition:<id>, compteurs, aucun texte de description ni de graphe', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph));
      await r.service.generate({ description: DESCRIPTION }, actor);
      expect(r.audit.dataChange).toHaveBeenCalledTimes(1);
      const entry = auditPayloads(r)[0];
      expect(entry).toMatchObject({
        userGroupId: 70,
        actorFullName: 'Concepteur',
        objectRef: 'wf_authoring:definition:42',
      });
      const payload = JSON.parse(entry.newValue as string);
      expect(payload).toEqual({
        outcome: 'created',
        descriptionLength: DESCRIPTION.length,
        promptTokens: 100,
        completionTokens: 50,
        repairUsed: false,
        issuesCount: 0,
        removed: REMOVED,
      });
      expect(JSON.stringify(entry)).not.toContain(SECRET);
      expect(JSON.stringify(entry)).not.toContain('Saisie');
    });

    it('échecs : objet wf_authoring:generate, sans texte, nom d’acteur de repli sur l’identifiant', async () => {
      const r = rig();
      r.outputs.push(new AiProviderError(`détail ${SECRET}`));
      await r.service.generate({ description: DESCRIPTION }, { ...actor, fullName: null }).catch(() => undefined);
      const entry = auditPayloads(r)[0];
      expect(entry.objectRef).toBe('wf_authoring:generate');
      expect(entry.actorFullName).toBe('conc');
      expect(JSON.stringify(entry)).not.toContain(SECRET);
    });

    it('un audit en échec ne bloque jamais la génération', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph));
      r.audit.dataChange.mockRejectedValue(new Error('audit down'));
      await expect(r.service.generate({ description: DESCRIPTION }, actor)).resolves.toMatchObject({ definitionId: 42 });
    });

    it('un échec de règlement du budget ne fait pas échouer la génération', async () => {
      const r = rig();
      r.outputs.push(output(goodGraph));
      r.gate.settle.mockRejectedValue(new Error('x'));
      await expect(r.service.generate({ description: DESCRIPTION }, actor)).resolves.toMatchObject({ definitionId: 42 });
    });
  });
});

describe('AuthoringService.explain', () => {
  it('refuse l’identité machine', async () => {
    const r = rig();
    await expect(r.service.explain(1, machine)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404 si la définition est absente ou sans version', async () => {
    const r = rig();
    r.prisma.wfDefinition.findUnique.mockResolvedValue(null);
    const err = (await r.service.explain(9, actor).catch((e: unknown) => e)) as NotFoundException;
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Workflow introuvable.');

    r.prisma.wfDefinition.findUnique.mockResolvedValue({ wfDefinitionId: 9, name: 'W' });
    r.prisma.wfDefinitionVersion.findMany.mockResolvedValue([]);
    await expect(r.service.explain(9, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('choisit le brouillon sinon la version la plus récente, et explique', async () => {
    const r = rig();
    r.prisma.wfDefinition.findUnique.mockResolvedValue({ wfDefinitionId: 9, name: 'W' });
    (explainGraph as jest.Mock).mockReturnValue({ definitionId: 9, versionNumber: 2 });
    r.prisma.wfDefinitionVersion.findMany.mockResolvedValue([
      { versionNumber: 3, status: 1, graph: goodGraph },
      { versionNumber: 2, status: 0, graph: goodGraph },
    ]);
    await r.service.explain(9, actor);
    expect(explainGraph).toHaveBeenCalledWith(expect.objectContaining({ start: 'saisie' }), {
      definitionId: 9,
      versionNumber: 2,
      name: 'W',
    });

    r.prisma.wfDefinitionVersion.findMany.mockResolvedValue([{ versionNumber: 3, status: 1, graph: goodGraph }]);
    await r.service.explain(9, actor);
    expect((explainGraph as jest.Mock).mock.calls[1][1].versionNumber).toBe(3);
    expect(r.ai.run).not.toHaveBeenCalled();
  });

  it('422 si le graphe stocké est invalide', async () => {
    const r = rig();
    r.prisma.wfDefinition.findUnique.mockResolvedValue({ wfDefinitionId: 9, name: 'W' });
    r.prisma.wfDefinitionVersion.findMany.mockResolvedValue([{ versionNumber: 1, status: 0, graph: shapeBadGraph }]);
    await expect(r.service.explain(9, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(explainGraph).not.toHaveBeenCalled();
  });
});
