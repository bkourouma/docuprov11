import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmailTemplateService } from './email-template.service';
import type { AuthUser } from '../auth/auth.types';

const user: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 1 };

/** Ligne `email_template_setting`, tous champs facultatifs — miroir de `EmailBrandRow`. */
interface Row {
  orgName: string | null;
  logoFileName: string | null;
  logoOriginalName: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
  updatedAt: Date | null;
}

/** Base vierge : aucun champ renseigné. */
const EMPTY_ROW: Row = {
  orgName: null,
  logoFileName: null,
  logoOriginalName: null,
  contactEmail: null,
  websiteUrl: null,
  updatedAt: null,
};

/**
 * Faux `prisma.emailTemplateSetting`, avec un état réellement conservé entre les appels — le
 * comportement testé ici (un `update` partiel, puis relu via `get()`) dépend de cet enchaînement,
 * un simple retour figé par `mockResolvedValue` ne le vérifierait pas.
 */
function createEmailTemplateSettingStub() {
  let row: (Row & { emailTemplateSettingId: number }) | null = null;

  const project = (select?: Record<string, boolean>): Partial<Row> | null => {
    if (!row) return null;
    if (!select) return { ...row };
    const current = row;
    return Object.fromEntries(
      Object.keys(select).map((k) => [k, (current as unknown as Record<string, unknown>)[k] ?? null]),
    ) as Partial<Row>;
  };

  return {
    findFirst: jest.fn(({ select }: { select?: Record<string, boolean> } = {}) =>
      Promise.resolve(project(select)),
    ),
    upsert: jest.fn(
      ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        row = row
          ? ({ ...row, ...update, updatedAt: new Date('2026-07-22T10:00:00Z') } as Row & {
              emailTemplateSettingId: number;
            })
          : ({ ...EMPTY_ROW, ...create, updatedAt: new Date('2026-07-22T10:00:00Z') } as Row & {
              emailTemplateSettingId: number;
            });
        return Promise.resolve(row);
      },
    ),
    update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      row = { ...(row as Row & { emailTemplateSettingId: number }), ...data } as Row & {
        emailTemplateSettingId: number;
      };
      return Promise.resolve(row);
    }),
    // Accès direct pour préparer l'état d'un test sans passer par le service.
    __seed: (partial: Partial<Row>) => {
      row = { emailTemplateSettingId: 1, ...EMPTY_ROW, ...partial };
    },
  };
}

describe('EmailTemplateService', () => {
  let prisma: { emailTemplateSetting: ReturnType<typeof createEmailTemplateSettingStub> };
  let config: { get: jest.Mock; getOrThrow: jest.Mock };
  let archives: string;
  let service: EmailTemplateService;

  beforeEach(async () => {
    archives = await mkdtemp(join(tmpdir(), 'branding-test-'));
    prisma = { emailTemplateSetting: createEmailTemplateSettingStub() };
    config = {
      get: jest.fn().mockReturnValue(undefined),
      getOrThrow: jest.fn().mockReturnValue(archives),
    };
    service = new EmailTemplateService(prisma as never, config as never);
  });

  describe('get() — base vierge', () => {
    it('ne rien inventer : tous les champs sont null, aucune ligne n’a jamais été écrite', async () => {
      const res = await service.get();
      expect(res).toMatchObject({ orgName: null, contactEmail: null, websiteUrl: null });
      expect(res.updatedAt).toBeNull();
      expect(prisma.emailTemplateSetting.upsert).not.toHaveBeenCalled();
    });
  });

  describe('update()', () => {
    it('écrit une ligne à la première sauvegarde, avec l’identifiant constant 1', async () => {
      await service.update({ orgName: 'Groupe Exemple SA' }, user);

      expect(prisma.emailTemplateSetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { emailTemplateSettingId: 1 },
          create: expect.objectContaining({
            emailTemplateSettingId: 1,
            orgName: 'Groupe Exemple SA',
            updatedBy: user.userGroupId,
          }),
        }),
      );
    });

    it('un champ ABSENT de la requête ne touche pas la valeur déjà enregistrée', async () => {
      await service.update(
        { orgName: 'Groupe Exemple SA', contactEmail: 'contact@exemple.ci' },
        user,
      );

      // Second appel : seul l'e-mail de contact est fourni, orgName n'apparaît pas dans le DTO.
      await service.update({ contactEmail: 'autre@exemple.ci' }, user);

      const res = await service.get();
      expect(res.orgName).toBe('Groupe Exemple SA');
      expect(res.contactEmail).toBe('autre@exemple.ci');
    });

    it('un champ explicitement mis à null EFFACE la valeur (formulaire vidé)', async () => {
      await service.update({ orgName: 'Groupe Exemple SA' }, user);
      await service.update({ orgName: null }, user);

      expect((await service.get()).orgName).toBeNull();
    });
  });

  describe('uploadLogo()', () => {
    const png = { originalname: 'logo.png', buffer: Buffer.from('PNGDATA'), size: 7 };

    it('écrit le binaire sous un nom FIXE et enregistre le nom d’origine', async () => {
      const res = await service.uploadLogo(png, user);

      expect(res.logoFileName).toBe('email-logo.png');
      expect(res.logoOriginalName).toBe('logo.png');
      await expect(readFile(join(archives, '_branding', 'email-logo.png'), 'utf8')).resolves.toBe(
        'PNGDATA',
      );
    });

    it('remplace le binaire précédent quand l’extension change', async () => {
      await service.uploadLogo(png, user);
      const jpg = { originalname: 'nouveau.jpg', buffer: Buffer.from('JPEGDATA'), size: 8 };

      const res = await service.uploadLogo(jpg, user);

      expect(res.logoFileName).toBe('email-logo.jpg');
      // L'ancien fichier PNG doit avoir disparu — sinon deux logos concurrents restent sur disque.
      await expect(
        readFile(join(archives, '_branding', 'email-logo.png'), 'utf8'),
      ).rejects.toThrow();
      await expect(readFile(join(archives, '_branding', 'email-logo.jpg'), 'utf8')).resolves.toBe(
        'JPEGDATA',
      );
    });

    it('refuse un format non accepté (svg)', async () => {
      const svg = { originalname: 'logo.svg', buffer: Buffer.from('<svg/>'), size: 6 };
      await expect(service.uploadLogo(svg, user)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.emailTemplateSetting.upsert).not.toHaveBeenCalled();
    });

    it('refuse un fichier de plus de 1 Mo', async () => {
      const trop = { originalname: 'logo.png', buffer: Buffer.alloc(1024 * 1024 + 1), size: 0 };
      await expect(service.uploadLogo(trop, user)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuse un dépôt vide', async () => {
      await expect(service.uploadLogo(undefined, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('deleteLogo()', () => {
    it('retire le fichier et vide les champs associés, laisse le reste intact', async () => {
      await service.update({ orgName: 'Groupe Exemple SA' }, user);
      await service.uploadLogo(
        { originalname: 'logo.png', buffer: Buffer.from('X'), size: 1 },
        user,
      );

      const res = await service.deleteLogo(user);

      expect(res.logoFileName).toBeNull();
      expect(res.logoOriginalName).toBeNull();
      expect(res.orgName).toBe('Groupe Exemple SA');
      await expect(
        readFile(join(archives, '_branding', 'email-logo.png'), 'utf8'),
      ).rejects.toThrow();
    });

    it('ne fait rien si aucun logo n’est déposé', async () => {
      const res = await service.deleteLogo(user);
      expect(res.logoFileName).toBeNull();
      expect(prisma.emailTemplateSetting.update).not.toHaveBeenCalled();
    });
  });

  describe('getLogoTarget()', () => {
    it('lève NotFound quand aucun logo n’est paramétré', async () => {
      await expect(service.getLogoTarget()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lève NotFound quand le binaire a disparu du disque', async () => {
      prisma.emailTemplateSetting.__seed({ logoFileName: 'email-logo.png' });
      await expect(service.getLogoTarget()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('renvoie le chemin et le content-type déduit de l’extension', async () => {
      await service.uploadLogo(
        { originalname: 'logo.webp', buffer: Buffer.from('X'), size: 1 },
        user,
      );

      const target = await service.getLogoTarget();

      expect(target.filePath).toBe(join(archives, '_branding', 'email-logo.webp'));
      expect(target.contentType).toBe('image/webp');
    });
  });

  describe('brand()', () => {
    it('la base l’emporte sur l’environnement, champ par champ', async () => {
      config.get.mockImplementation(
        (key: string) =>
          ({ MAIL_ORG_NAME: 'ENV Org', MAIL_LOGO_URL: 'https://cdn.exemple.ci/logo.png' })[key],
      );
      await service.update({ orgName: 'Groupe Exemple SA' }, user);

      const brand = await service.brand();

      // La base l'emporte sur l'environnement quand elle a une valeur...
      expect(brand.orgName).toBe('Groupe Exemple SA');
      // ...mais l'environnement subsiste sur ce que la base ne porte pas (ici le logo public).
      expect(brand.logoUrl).toBe('https://cdn.exemple.ci/logo.png');
    });

    it('retombe sur le logo PUBLIC d’environnement, jamais sur une URL locale', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'MAIL_LOGO_URL' ? 'https://cdn.exemple.ci/logo.png' : undefined,
      );

      // Aucun logo local déposé : le repli est l'URL publique d'environnement.
      const brand = await service.brand();
      expect(brand.logoUrl).toBe('https://cdn.exemple.ci/logo.png');
    });
  });

  describe('inlineLogo()', () => {
    it('renvoie null quand aucun logo n’est déposé', async () => {
      expect(await service.inlineLogo()).toBeNull();
    });

    it('lit le binaire déposé et déduit le content-type', async () => {
      await service.uploadLogo(
        { originalname: 'logo.png', buffer: Buffer.from('PNGDATA'), size: 7 },
        user,
      );

      const logo = await service.inlineLogo();

      expect(logo?.contentType).toBe('image/png');
      expect(logo?.filename).toBe('email-logo.png');
      expect(logo?.content.toString('utf8')).toBe('PNGDATA');
    });

    it('renvoie null si le binaire a disparu du disque (envoi non bloqué)', async () => {
      prisma.emailTemplateSetting.__seed({ logoFileName: 'email-logo.png' });
      expect(await service.inlineLogo()).toBeNull();
    });
  });
});
