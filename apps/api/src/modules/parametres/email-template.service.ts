import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  brandFromRow,
  loadInlineLogo,
  type BrandConfig,
  type EmailBrandRow,
  type InlineLogo,
} from '@archivage/mailer';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { UpdateEmailTemplateDto } from './email-template.dto';

/** Fichier déposé (multipart) — forme fournie par multer via @UploadedFile. */
export interface UploadedLogo {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Sous-dossier des ressources de marque sous ARCHIVES (à côté de `_courriers-scans`). */
const BRANDING_DIR = '_branding';

/** Nom de fichier FIXE : un seul logo à la fois, on écrase toujours le même. */
const LOGO_BASENAME = 'email-logo';

/**
 * Formats acceptés. Le SVG est refusé sciemment : il peut contenir du script, il serait servi
 * publiquement, et la plupart des clients mail ne l'affichent pas de toute façon.
 */
const ACCEPTED_LOGO: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** 1 Mo : un logo d'e-mail est affiché en 72 px de large, au-delà c'est un fichier mal préparé. */
const MAX_LOGO_BYTES = 1024 * 1024;

/** Champs lus pour construire l'identité — miroir de `EmailBrandRow` côté mailer. */
const BRAND_SELECT = {
  orgName: true,
  logoFileName: true,
  contactEmail: true,
  websiteUrl: true,
} as const;

export interface EmailTemplateSettingResponse extends EmailBrandRow {
  logoOriginalName: string | null;
  updatedAt: Date | null;
}

/**
 * Paramétrage de l'identité des e-mails de notification (§03.5).
 *
 * Auparavant portée par les variables `MAIL_ORG_NAME` / `MAIL_LOGO_URL`, ce
 * qui imposait un accès au serveur et un redémarrage pour corriger un simple libellé. Le
 * paramétrage vit désormais en base, sur une LIGNE UNIQUE (CHECK `= 1`), et les variables
 * d'environnement subsistent comme REPLI : un déploiement existant garde son identité tant que
 * personne n'a rien saisi.
 *
 * Aucune valeur n'est inventée. Un champ vide est stocké `null` et le gabarit l'omet — ce qui rend
 * l'écran de paramétrage sûr à laisser incomplet.
 */
@Injectable()
export class EmailTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get brandingDir(): string {
    return join(this.config.getOrThrow<string>('ARCHIVES_PATH'), BRANDING_DIR);
  }

  /**
   * Identité de repli, issue des variables `MAIL_*`. Ne porte que les champs qui existaient avant la
   * table ; `MAIL_LOGO_URL` sert de logo de repli — mais uniquement s'il est PUBLIC (ex. un CDN),
   * car il reste référencé par URL, contrairement au logo local qui est embarqué.
   */
  private get envFallback(): BrandConfig {
    return {
      orgName: this.config.get<string>('MAIL_ORG_NAME') ?? null,
      logoUrl: this.config.get<string>('MAIL_LOGO_URL') ?? null,
      productName: 'DocuPro',
    };
  }

  /** Ligne de paramétrage, ou `null` si personne n'a encore rien saisi. */
  private findRow() {
    return this.prisma.emailTemplateSetting.findFirst({
      select: { ...BRAND_SELECT, logoOriginalName: true, updatedAt: true },
    });
  }

  /** Vue de l'écran de paramétrage : la ligne telle quelle. */
  async get(): Promise<EmailTemplateSettingResponse> {
    const row = await this.findRow();
    return {
      orgName: row?.orgName ?? null,
      logoFileName: row?.logoFileName ?? null,
      logoOriginalName: row?.logoOriginalName ?? null,
      contactEmail: row?.contactEmail ?? null,
      websiteUrl: row?.websiteUrl ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** Identité TEXTE prête pour le gabarit — repli d'environnement fusionné champ par champ. */
  async brand(): Promise<BrandConfig> {
    const row = await this.prisma.emailTemplateSetting.findFirst({ select: BRAND_SELECT });
    return brandFromRow(row, this.envFallback);
  }

  /**
   * Logo à embarquer dans l'e-mail (pièce jointe CID). Lit le fichier déposé sous ARCHIVES. `null`
   * si aucun logo local : l'e-mail retombe alors sur le logo d'environnement s'il y en a un.
   */
  async inlineLogo(): Promise<InlineLogo | null> {
    const row = await this.prisma.emailTemplateSetting.findFirst({ select: { logoFileName: true } });
    return loadInlineLogo(this.brandingDir, row?.logoFileName ?? null);
  }

  /**
   * Enregistre le paramétrage. `upsert` sur l'identifiant constant 1 : la ligne peut ne pas exister
   * (base vierge), et le CHECK garantit qu'il n'y en aura jamais d'autre.
   *
   * Seules les clés PRÉSENTES dans la requête sont écrites — un formulaire partiel (l'onglet
   * « Coordonnées » seul, par exemple) ne doit pas effacer les champs qu'il n'affiche pas.
   */
  async update(dto: UpdateEmailTemplateDto, user: AuthUser): Promise<EmailTemplateSettingResponse> {
    const data = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));

    await this.prisma.emailTemplateSetting.upsert({
      where: { emailTemplateSettingId: 1 },
      create: { emailTemplateSettingId: 1, ...data, updatedBy: user.userGroupId },
      update: { ...data, updatedBy: user.userGroupId },
    });
    return this.get();
  }

  /**
   * Dépôt du logo. Le fichier porte un nom FIXE (`email-logo.<ext>`) : un seul logo à la fois, on
   * écrase toujours le même. L'ancien binaire est supprimé lorsque l'extension change, pour ne pas
   * laisser deux logos concurrents dans le dossier. Le logo est ensuite EMBARQUÉ dans chaque e-mail
   * (pièce jointe CID) — il n'a besoin d'aucune URL publique pour s'afficher.
   */
  async uploadLogo(
    file: UploadedLogo | undefined,
    user: AuthUser,
  ): Promise<EmailTemplateSettingResponse> {
    if (!file?.buffer?.length) throw new BadRequestException('Aucun fichier reçu');
    if (file.buffer.byteLength > MAX_LOGO_BYTES) {
      throw new BadRequestException('Logo trop volumineux (1 Mo maximum)');
    }

    const ext = extname(file.originalname ?? '').toLowerCase();
    if (!ACCEPTED_LOGO[ext]) {
      throw new BadRequestException(
        `Format non accepté (${ext || 'inconnu'}) — attendu : ${Object.keys(ACCEPTED_LOGO).join(', ')}`,
      );
    }

    const previous = await this.prisma.emailTemplateSetting.findFirst({
      select: { logoFileName: true },
    });

    const fileName = `${LOGO_BASENAME}${ext}`;
    await mkdir(this.brandingDir, { recursive: true });
    await writeFile(join(this.brandingDir, fileName), file.buffer);

    if (previous?.logoFileName && previous.logoFileName !== fileName) {
      await unlink(join(this.brandingDir, previous.logoFileName)).catch(() => undefined);
    }

    await this.prisma.emailTemplateSetting.upsert({
      where: { emailTemplateSettingId: 1 },
      create: {
        emailTemplateSettingId: 1,
        logoFileName: fileName,
        logoOriginalName: file.originalname?.slice(0, 260) ?? null,
        updatedBy: user.userGroupId,
      },
      update: {
        logoFileName: fileName,
        logoOriginalName: file.originalname?.slice(0, 260) ?? null,
        updatedBy: user.userGroupId,
      },
    });

    return this.get();
  }

  /** Retire le logo local. Le logo d'environnement éventuel reprend alors le relais dans les e-mails. */
  async deleteLogo(user: AuthUser): Promise<EmailTemplateSettingResponse> {
    const row = await this.prisma.emailTemplateSetting.findFirst({
      select: { logoFileName: true },
    });
    if (row?.logoFileName) {
      await unlink(join(this.brandingDir, row.logoFileName)).catch(() => undefined);
      await this.prisma.emailTemplateSetting.update({
        where: { emailTemplateSettingId: 1 },
        data: { logoFileName: null, logoOriginalName: null, updatedBy: user.userGroupId },
      });
    }
    return this.get();
  }

  /**
   * Cible du service du logo, pour l'APERÇU de l'écran de paramétrage. Les e-mails, eux, embarquent
   * le logo (CID) et ne passent pas par cette route ; elle ne sert donc plus qu'à l'admin qui
   * visualise sa configuration.
   */
  async getLogoTarget(): Promise<{ filePath: string; contentType: string }> {
    const row = await this.prisma.emailTemplateSetting.findFirst({
      select: { logoFileName: true },
    });
    if (!row?.logoFileName) throw new NotFoundException('Aucun logo paramétré');

    const filePath = join(this.brandingDir, row.logoFileName);
    // Le binaire a pu disparaître du disque (restauration partielle, purge) : un 404 est plus juste
    // qu'une erreur de lecture, et le client mail se contentera d'omettre l'image.
    await access(filePath).catch(() => {
      throw new NotFoundException('Logo introuvable sur le disque');
    });

    const ext = extname(row.logoFileName).toLowerCase();
    return { filePath, contentType: ACCEPTED_LOGO[ext] ?? 'application/octet-stream' };
  }
}
