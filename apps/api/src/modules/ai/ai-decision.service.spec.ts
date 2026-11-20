import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, type GedAiDecision } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  GED_AI_INPUT_EXCERPT_MAX_CHARS,
  GED_GOVERNANCE_PROMPT_VERSION,
  GedAiDecisionStatus,
  GedAiTask,
} from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { AiDecisionService } from './ai-decision.service';

const actor: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 5 };

function decision(partial: Partial<GedAiDecision> = {}): GedAiDecision {
  return {
    gedAiDecisionId: 42n,
    documentId: 10,
    sourceItemId: null,
    task: GedAiTask.Classement,
    mode: 2,
    provider: 'openai',
    model: 'gpt',
    promptVersion: null,
    inputExcerpt: 'extrait',
    inputHash: 'a'.repeat(64),
    inputMasked: true,
    output: { documentTypeId: 3, documentTypeLabel: 'Facture', confidence: 0.9, rationale: null },
    confidence: new Prisma.Decimal('0.900'),
    status: GedAiDecisionStatus.Proposee,
    validatedBy: null,
    validatedAt: null,
    requestedBy: null,
    promptTokens: null,
    completionTokens: null,
    durationMs: null,
    errorMessage: null,
    createdAt: new Date('2026-11-20T10:00:00Z'),
    ...partial,
  };
}

/** Faux Prisma : une décision en mémoire, `$transaction` rejoue le callback sur le même faux. */
function setup(initial: GedAiDecision | null) {
  let current = initial;
  const prisma: Record<string, unknown> & {
    gedAiDecision: Record<'create' | 'findUnique' | 'findMany' | 'count' | 'updateMany', jest.Mock>;
    document: { updateMany: jest.Mock };
  } = {
    gedAiDecision: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ gedAiDecisionId: 99n, ...data }),
      ),
      findUnique: jest.fn(() => Promise.resolve(current)),
      findMany: jest.fn(() => Promise.resolve(current ? [current] : [])),
      count: jest.fn(() => Promise.resolve(current ? 1 : 0)),
      updateMany: jest.fn(
        ({ where, data }: { where: { status: number }; data: Partial<GedAiDecision> }) => {
          if (!current || current.status !== where.status) return Promise.resolve({ count: 0 });
          current = { ...current, ...data };
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    document: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
  };
  return { prisma, service: new AiDecisionService(prisma as never) };
}

const baseInput = {
  task: GedAiTask.Classement,
  mode: 2 as const,
  provider: 'openai',
  model: 'gpt',
  inputMasked: true,
  output: { a: 1 },
  confidence: 0.8,
  status: GedAiDecisionStatus.Proposee,
};

describe('AiDecisionService', () => {
  describe('record()', () => {
    it('écrit un extrait tronqué, le SHA-256 du texte complet, jamais le texte entier', async () => {
      const { prisma, service } = setup(null);
      const inputText = 'x'.repeat(GED_AI_INPUT_EXCERPT_MAX_CHARS + 500);

      const id = await service.record({ ...baseInput, inputText });
      expect(id).toBe(99n);

      const data = prisma.gedAiDecision.create.mock.calls[0][0].data as Record<string, unknown>;
      const excerpt = data.inputExcerpt as string;
      expect(excerpt.length).toBe(GED_AI_INPUT_EXCERPT_MAX_CHARS + 1); // + « … »
      expect(excerpt).not.toBe(inputText);
      expect(Object.values(data)).not.toContain(inputText);
      expect(data.inputHash).toBe(createHash('sha256').update(`${inputText}\n`).digest('hex'));
      expect(data.inputHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('intègre les empreintes de binaires TRIÉES au hash, quel que soit l’ordre fourni', async () => {
      const { prisma, service } = setup(null);
      await service.record({ ...baseInput, inputText: 'texte', attachmentHashes: ['b'.repeat(64), 'a'.repeat(64)] });
      await service.record({ ...baseInput, inputText: 'texte', attachmentHashes: ['a'.repeat(64), 'b'.repeat(64)] });

      const [first, second] = prisma.gedAiDecision.create.mock.calls.map(
        (c: Array<{ data: { inputHash: string } }>) => c[0].data.inputHash,
      );
      expect(first).toBe(second);
      expect(first).toBe(
        createHash('sha256')
          .update(`texte\n${'a'.repeat(64)}\n${'b'.repeat(64)}`)
          .digest('hex'),
      );
    });

    it('ôte le NUL de l’extrait mais hache le texte reçu tel quel', async () => {
      const { prisma, service } = setup(null);
      const inputText = 'avant\u0000après';
      await service.record({ ...baseInput, inputText });
      const data = prisma.gedAiDecision.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.inputExcerpt as string).not.toContain('\u0000');
      expect(data.inputExcerpt).toBe('avant�après');
      expect(data.inputHash).toBe(createHash('sha256').update(`${inputText}\n`).digest('hex'));
    });

    it('output absent => JSON null ; champs optionnels => null', async () => {
      const { prisma, service } = setup(null);
      await service.record({ ...baseInput, inputText: 't', output: undefined, confidence: null });
      const data = prisma.gedAiDecision.create.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.output).toBe(Prisma.JsonNull);
      expect(data).toMatchObject({
        confidence: null,
        documentId: null,
        sourceItemId: null,
        requestedBy: null,
        errorMessage: null,
      });
    });
  });

  describe('list() / get()', () => {
    it('sérialise BigInt en chaîne et Decimal en number, avec la pagination bornée', async () => {
      const { prisma, service } = setup(decision({ sourceItemId: 7n }));
      const page = await service.list({ status: 0, task: 0, documentId: 10, page: 2, pageSize: 5000 });

      expect(page).toMatchObject({ total: 1, page: 2, pageSize: 100 });
      expect(page.items[0]).toMatchObject({ id: '42', sourceItemId: '7', confidence: 0.9 });
      expect(() => JSON.stringify(page)).not.toThrow();
      expect(prisma.gedAiDecision.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 0, task: 0, documentId: 10 },
          orderBy: [{ createdAt: 'desc' }, { gedAiDecisionId: 'desc' }],
          skip: 100,
          take: 100,
        }),
      );
    });

    it('valeurs par défaut : page 1, 25 par page, sans filtre', async () => {
      const { prisma, service } = setup(decision());
      await expect(service.list({})).resolves.toMatchObject({ page: 1, pageSize: 25 });
      expect(prisma.gedAiDecision.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, skip: 0, take: 25 }),
      );
    });

    it('get() : 404 si absente', async () => {
      const { service } = setup(null);
      await expect(service.get(1)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('get() : confidence null reste null', async () => {
      const { service } = setup(decision({ confidence: null }));
      await expect(service.get(42)).resolves.toMatchObject({ id: '42', confidence: null });
    });
  });

  describe('validate() / reject()', () => {
    it('validate : statut 1, validatedBy / validatedAt posés, patch appliqué aux champs vides', async () => {
      const { prisma, service } = setup(decision());
      const res = await service.validate(42, actor);

      expect(res).toMatchObject({ status: GedAiDecisionStatus.Validee, validatedBy: 5 });
      expect(res.validatedAt).toBeInstanceOf(Date);
      expect(prisma.document.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.document.updateMany).toHaveBeenCalledWith({
        where: { documentId: 10, documentTypeId: null },
        data: { documentTypeId: 3 },
      });
    });

    it('validate (extraction) : une condition « vide » par champ, jamais d’écrasement', async () => {
      const { prisma, service } = setup(
        decision({
          task: GedAiTask.ExtractionMetadonnees,
          output: { title: 't', date: '2026-03-15', reference: null, summary: ' Un résumé. ', confidence: 0.9 },
        }),
      );
      await service.validate(42, actor);

      expect(prisma.document.updateMany).toHaveBeenCalledWith({
        where: { documentId: 10, documentDate: null },
        data: { documentDate: new Date('2026-03-15T00:00:00Z') },
      });
      expect(prisma.document.updateMany).toHaveBeenCalledWith({
        where: { documentId: 10, overview: null },
        data: { overview: 'Un résumé.' },
      });
      expect(prisma.document.updateMany).toHaveBeenCalledTimes(2);
    });

    it('validate : sans document lié, rien n’est écrit côté document', async () => {
      const { prisma, service } = setup(decision({ documentId: null }));
      await service.validate(42, actor);
      expect(prisma.document.updateMany).not.toHaveBeenCalled();
    });

    it('validate : validatedBy peut rester null (administrateur sans groupe)', async () => {
      const { service } = setup(decision());
      const res = await service.validate(42, { ...actor, userGroupId: null });
      expect(res).toMatchObject({ status: GedAiDecisionStatus.Validee, validatedBy: null });
      expect(res.validatedAt).toBeInstanceOf(Date);
    });

    it('reject : statut 2, validatedBy / validatedAt posés, AUCUNE écriture sur le document', async () => {
      const { prisma, service } = setup(decision());
      const res = await service.reject(42, actor);

      expect(res).toMatchObject({ status: GedAiDecisionStatus.Rejetee, validatedBy: 5 });
      expect(res.validatedAt).toBeInstanceOf(Date);
      expect(prisma.document.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      GedAiDecisionStatus.Validee,
      GedAiDecisionStatus.Rejetee,
      GedAiDecisionStatus.AppliqueeAuto,
      GedAiDecisionStatus.Erreur,
    ])('409 si le statut est %s (hors « proposée »)', async (status) => {
      const { prisma, service } = setup(decision({ status }));
      await expect(service.validate(42, actor)).rejects.toBeInstanceOf(ConflictException);
      await expect(service.reject(42, actor)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.gedAiDecision.updateMany).not.toHaveBeenCalled();
      expect(prisma.document.updateMany).not.toHaveBeenCalled();
    });

    it.each(['validate', 'reject'] as const)(
      '%s : décision de gouvernance => 409, aucune écriture',
      async (action) => {
        const { prisma, service } = setup(decision({ promptVersion: GED_GOVERNANCE_PROMPT_VERSION }));
        const err = await service[action](42, actor).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).message).toContain('module Gouvernance');
        expect(prisma.gedAiDecision.updateMany).not.toHaveBeenCalled();
        expect(prisma.document.updateMany).not.toHaveBeenCalled();
      },
    );

    it('une autre promptVersion garde son comportement', async () => {
      const { service } = setup(decision({ promptVersion: 'autre-v1' }));
      const res = await service.validate(42, actor);
      expect(res).toMatchObject({ status: GedAiDecisionStatus.Validee });
    });

    it('404 si la décision n’existe pas', async () => {
      const { service } = setup(null);
      await expect(service.validate(1, actor)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.reject(1, actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409 si une autre revue a gagné entre la lecture et l’écriture', async () => {
      const { prisma, service } = setup(decision());
      prisma.gedAiDecision.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.validate(42, actor)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.document.updateMany).not.toHaveBeenCalled();
    });
  });
});
