import { BadRequestException } from '@nestjs/common';
import { Prisma, type GedAiSetting } from '@prisma/client';
import { AiSettingsService } from './ai-settings.service';
import type { AuthUser } from '../auth/auth.types';

const actor: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 7 };

/** Ligne par défaut : IA désactivée, comme l'INSERT de ged.sql. */
function row(partial: Partial<GedAiSetting> = {}): GedAiSetting {
  return {
    gedAiSettingId: 1,
    mode: 0,
    provider: null,
    model: null,
    embeddingModel: null,
    embeddingDimension: 1024,
    endpoint: null,
    apiKeyRef: null,
    maskingEnabled: true,
    autoApplyThreshold: null,
    timeoutSeconds: 60,
    updatedAt: new Date('2026-11-20T10:00:00Z'),
    updatedBy: null,
    ...partial,
  };
}

/** Faux Prisma à état conservé : un `update` puis un `getView` doivent se répondre. */
function setup(initial: GedAiSetting | null, env: Record<string, string | undefined> = {}) {
  let current: GedAiSetting | null = initial;
  const prisma = {
    gedAiSetting: {
      findUnique: jest.fn(() => Promise.resolve(current)),
      upsert: jest.fn(
        ({ create, update }: { create: Partial<GedAiSetting>; update: Partial<GedAiSetting> }) => {
          // Prisma rend un Decimal, pas un number : le faux doit en faire autant.
          const toDecimal = <T extends Partial<GedAiSetting>>(d: T): T =>
            d.autoApplyThreshold == null
              ? d
              : { ...d, autoApplyThreshold: new Prisma.Decimal(d.autoApplyThreshold as never) };
          current = current ? { ...current, ...toDecimal(update) } : row(toDecimal(create));
          return Promise.resolve(current);
        },
      ),
    },
    gedAiMaskingRule: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const config = { get: jest.fn((k: string) => env[k]) };
  const service = new AiSettingsService(prisma as never, config as never);
  return { service, prisma };
}

describe('AiSettingsService', () => {
  describe('update() — règles métier (miroir des CHECK SQL)', () => {
    it('refuse le cloud avec masquage coupé EXPLICITE', async () => {
      const { service, prisma } = setup(row());
      await expect(
        service.update({ mode: 2, maskingEnabled: false }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.gedAiSetting.upsert).not.toHaveBeenCalled();
    });

    it('refuse le cloud quand le masquage est coupé dans la ligne EXISTANTE', async () => {
      const { service, prisma } = setup(row({ mode: 1, endpoint: 'http://ollama:11434', maskingEnabled: false }));
      await expect(service.update({ mode: 2 }, actor)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.gedAiSetting.upsert).not.toHaveBeenCalled();
    });

    it('refuse de couper le masquage sur une ligne déjà en cloud', async () => {
      const { service } = setup(row({ mode: 2, provider: 'openai' }));
      await expect(service.update({ maskingEnabled: false }, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each(['sk-abc', 'JWT_SECRET', 'sk-proj-AAAA1111', 'ma clé', 'DATABASE_URL'])(
      'refuse la référence de clé %s',
      async (apiKeyRef) => {
        const { service, prisma } = setup(row());
        await expect(service.update({ apiKeyRef }, actor)).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.gedAiSetting.upsert).not.toHaveBeenCalled();
      },
    );

    it('accepte OPENAI_API_KEY et GED_AI_* comme référence', async () => {
      const { service } = setup(row());
      await expect(service.update({ apiKeyRef: 'GED_AI_API_KEY' }, actor)).resolves.toMatchObject({
        apiKeyRef: 'GED_AI_API_KEY',
      });
      await expect(service.update({ apiKeyRef: 'OPENAI_API_KEY' }, actor)).resolves.toBeDefined();
    });

    it('refuse une dimension d’embedding différente de 1024', async () => {
      const { service } = setup(row());
      await expect(service.update({ embeddingDimension: 768 }, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.update({ embeddingDimension: 1024 }, actor)).resolves.toBeDefined();
    });

    it.each([-0.1, 1.5, Number.NaN])('refuse le seuil %s hors de 0..1', async (autoApplyThreshold) => {
      const { service } = setup(row());
      await expect(service.update({ autoApplyThreshold }, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('accepte un seuil null, 0 et 1', async () => {
      const { service } = setup(row());
      for (const autoApplyThreshold of [null, 0, 1, 0.85]) {
        await expect(service.update({ autoApplyThreshold }, actor)).resolves.toBeDefined();
      }
    });

    it.each([0, 601])('refuse un délai de %s secondes', async (timeoutSeconds) => {
      const { service } = setup(row());
      await expect(service.update({ timeoutSeconds }, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('le mode local exige un endpoint (existant ou fourni)', async () => {
      const { service } = setup(row());
      await expect(service.update({ mode: 1 }, actor)).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update({ mode: 1, endpoint: 'http://ollama:11434' }, actor),
      ).resolves.toMatchObject({ mode: 1, endpoint: 'http://ollama:11434' });
    });

    it('refuse un endpoint qui n’est pas une URL http(s)', async () => {
      const { service } = setup(row());
      await expect(
        service.update({ mode: 1, endpoint: 'ftp://hote/modele' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.update({ mode: 1, endpoint: 'pas une url' }, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuse un endpoint contenant des identifiants', async () => {
      const { service, prisma } = setup(row());
      for (const endpoint of ['http://user:pw@ollama:11434', 'https://user@api.exemple.com/v1']) {
        await expect(service.update({ mode: 1, endpoint }, actor)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(prisma.gedAiSetting.upsert).not.toHaveBeenCalled();
    });

    it('en cloud, https est obligatoire sauf localhost / 127.0.0.1', async () => {
      const { service } = setup(row());
      await expect(
        service.update({ mode: 2, endpoint: 'http://api.exemple.com/v1' }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update({ mode: 2, endpoint: 'http://localhost:4000/v1' }, actor),
      ).resolves.toBeDefined();
      await expect(
        service.update({ mode: 2, endpoint: 'http://127.0.0.1:4000/v1' }, actor),
      ).resolves.toBeDefined();
    });
  });

  describe('update() — écriture', () => {
    it('cloud : renseigne provider / modèle / embedding / endpoint par défaut si absents', async () => {
      const { service, prisma } = setup(row());
      const view = await service.update({ mode: 2 }, actor);

      expect(view).toMatchObject({
        mode: 2,
        provider: 'openai',
        model: 'gpt-5.6-terra',
        embeddingModel: 'text-embedding-3-large',
        endpoint: 'https://api.openai.com/v1',
        maskingEnabled: true,
      });
      expect(prisma.gedAiSetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { gedAiSettingId: 1 },
          create: expect.objectContaining({ gedAiSettingId: 1, updatedBy: 7 }),
          update: expect.objectContaining({ updatedBy: 7 }),
        }),
      );
    });

    it('cloud : ne remplace pas un provider déjà choisi', async () => {
      const { service } = setup(row({ provider: 'mistral', model: 'mistral-large' }));
      const view = await service.update({ mode: 2 }, actor);
      expect(view).toMatchObject({ provider: 'mistral', model: 'mistral-large' });
    });

    it('un champ absent ne touche pas la valeur enregistrée, null l’efface', async () => {
      const { service } = setup(row({ mode: 1, endpoint: 'http://ollama:11434', model: 'llama3' }));
      const kept = await service.update({ timeoutSeconds: 120 }, actor);
      expect(kept).toMatchObject({ model: 'llama3', endpoint: 'http://ollama:11434', timeoutSeconds: 120 });

      const cleared = await service.update({ model: null }, actor);
      expect(cleared.model).toBeNull();
    });
  });

  describe('getEffective() / getView()', () => {
    it('ligne absente : IA désactivée, seuil null', async () => {
      const { service } = setup(null);
      await expect(service.getEffective()).resolves.toMatchObject({
        mode: 0,
        autoApplyThreshold: null,
        embeddingDimension: 1024,
      });
    });

    it('mode 0 + OPENAI_API_KEY => IA désactivée, aucun repli (ligne présente ou absente)', async () => {
      for (const initial of [row(), null]) {
        const { service } = setup(initial, { OPENAI_API_KEY: 'sk-secret-value' });
        const eff = await service.getEffective();
        expect(eff).toMatchObject({ mode: 0, provider: null, apiKeyRef: null, endpoint: null });
        expect(eff).not.toHaveProperty('legacyEnvFallback');
      }
    });

    it('enregistrer « désactivée » n’inscrit plus de marqueur de fournisseur', async () => {
      const { service, prisma } = setup(row(), { OPENAI_API_KEY: 'sk-secret-value' });
      await service.update({ mode: 0 }, actor);
      const call = prisma.gedAiSetting.upsert.mock.calls[0][0] as unknown as { update: { provider?: string } };
      expect(call.update.provider).toBeUndefined();
      await expect(service.getEffective()).resolves.toMatchObject({ mode: 0, provider: null });
    });

    it('un mode choisi ne dépend pas de OPENAI_API_KEY', async () => {
      const { service } = setup(row({ mode: 1, endpoint: 'http://ollama:11434' }), {
        OPENAI_API_KEY: 'sk-secret-value',
      });
      await expect(service.getEffective()).resolves.toMatchObject({ mode: 1 });
    });

    it('seuil d’auto-application : null en mode 0 même si une valeur est stockée', async () => {
      const { service } = setup(row({ mode: 0, autoApplyThreshold: new Prisma.Decimal('0.9') }));
      await expect(service.getEffective()).resolves.toMatchObject({ autoApplyThreshold: null });
      // la vue, elle, montre la valeur stockée
      await expect(service.getView()).resolves.toMatchObject({ autoApplyThreshold: 0.9 });
    });

    describe('apiKeyConfigured (même règle que la fabrique)', () => {
      const keyOf = async (r: GedAiSetting | null, env: Record<string, string>) =>
        (await setup(r, env).service.getView()).apiKeyConfigured;

      it('OPENAI_API_KEY : cloud + openai + api.openai.com seulement', async () => {
        const env = { OPENAI_API_KEY: 'sk-x' };
        expect(await keyOf(row({ mode: 2, provider: 'openai' }), env)).toBe(true);
        expect(await keyOf(row({ mode: 2 }), env)).toBe(true);
        expect(await keyOf(row({ mode: 2, provider: 'openai', endpoint: 'https://api.openai.com/v1' }), env)).toBe(true);
        expect(await keyOf(row({ mode: 2, provider: 'openai', apiKeyRef: 'OPENAI_API_KEY' }), env)).toBe(true);
      });

      it('OPENAI_API_KEY refusée : mode local, mode 0, fournisseur ou hôte tiers', async () => {
        const env = { OPENAI_API_KEY: 'sk-x' };
        expect(await keyOf(row({ mode: 1, endpoint: 'http://x' }), env)).toBe(false);
        expect(await keyOf(row(), env)).toBe(false);
        expect(await keyOf(null, env)).toBe(false);
        expect(await keyOf(row({ mode: 2, provider: 'mistral' }), env)).toBe(false);
        expect(await keyOf(row({ mode: 2, provider: 'openai', endpoint: 'https://api.mistral.ai/v1' }), env)).toBe(false);
        expect(await keyOf(row({ mode: 2, provider: 'openai', endpoint: 'http://api.openai.com/v1' }), env)).toBe(false);
        expect(
          await keyOf(row({ mode: 1, endpoint: 'http://x', apiKeyRef: 'OPENAI_API_KEY' }), env),
        ).toBe(false);
      });

      it('référence GED_AI_* présente ou GED_AI_API_KEY : valable partout', async () => {
        expect(await keyOf(row({ mode: 1, endpoint: 'http://x', apiKeyRef: 'GED_AI_K' }), { GED_AI_K: 'v' })).toBe(true);
        expect(await keyOf(row({ mode: 2, provider: 'mistral' }), { GED_AI_API_KEY: 'v' })).toBe(true);
        expect(await keyOf(row({ mode: 2, apiKeyRef: 'GED_AI_K' }), {})).toBe(false);
      });

      it('apiKeyRef OPENAI_API_KEY hors cloud openai / api.openai.com : false même avec GED_AI_API_KEY', async () => {
        const env = { OPENAI_API_KEY: 'sk-x', GED_AI_API_KEY: 'k' };
        const ref = 'OPENAI_API_KEY';
        expect(await keyOf(row({ mode: 1, endpoint: 'http://x', apiKeyRef: ref }), env)).toBe(false);
        expect(await keyOf(row({ mode: 2, provider: 'mistral', apiKeyRef: ref }), env)).toBe(false);
        expect(
          await keyOf(row({ mode: 2, provider: 'openai', endpoint: 'https://api.mistral.ai/v1', apiKeyRef: ref }), env),
        ).toBe(false);
        expect(
          await keyOf(row({ mode: 2, provider: 'openai', endpoint: 'http://api.openai.com', apiKeyRef: ref }), env),
        ).toBe(false);
      });

      it('cloud openai https://api.openai.com + OPENAI_API_KEY : true', async () => {
        const r = row({ mode: 2, provider: 'openai', endpoint: 'https://api.openai.com', apiKeyRef: 'OPENAI_API_KEY' });
        expect(await keyOf(r, { OPENAI_API_KEY: 'sk-x' })).toBe(true);
      });

      it('OPENAI_API_KEY vide : non configurée', async () => {
        expect(await keyOf(row({ mode: 2 }), { OPENAI_API_KEY: '  ' })).toBe(false);
      });
    });

    it('convertit le seuil Decimal en number', async () => {
      const { service } = setup(row({ mode: 1, endpoint: 'http://x', autoApplyThreshold: new Prisma.Decimal('0.85') }));
      const eff = await service.getEffective();
      expect(eff.autoApplyThreshold).toBe(0.85);
      expect(typeof eff.autoApplyThreshold).toBe('number');
    });

    it('endpoint local : repli sur GED_AI_LOCAL_ENDPOINT quand la base n’en porte pas', async () => {
      const { service } = setup(row({ mode: 1 }), { GED_AI_LOCAL_ENDPOINT: 'http://ollama:11434' });
      await expect(service.getEffective()).resolves.toMatchObject({ endpoint: 'http://ollama:11434' });
    });

    it('la vue signale la clé configurée sans jamais en exposer la valeur', async () => {
      const secret = 'sk-ultra-secret-1234567890';
      const { service } = setup(row({ mode: 2, apiKeyRef: 'GED_AI_API_KEY' }), {
        GED_AI_API_KEY: secret,
      });
      const view = await service.getView();
      expect(view.apiKeyConfigured).toBe(true);
      expect(view.apiKeyRef).toBe('GED_AI_API_KEY');
      expect(JSON.stringify(view)).not.toContain(secret);
    });

    it('la vue : clé non configurée si la variable référencée est absente ou vide', async () => {
      const { service } = setup(row({ mode: 2, apiKeyRef: 'GED_AI_API_KEY' }), { GED_AI_API_KEY: '' });
      await expect(service.getView()).resolves.toMatchObject({ apiKeyConfigured: false });
    });

    it('la vue : sans référence, GED_AI_API_KEY sert de repli', async () => {
      const { service } = setup(row(), { GED_AI_API_KEY: 'valeur' });
      await expect(service.getView()).resolves.toMatchObject({ apiKeyRef: null, apiKeyConfigured: true });
    });
  });
});
