import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createMailer,
  type BrandConfig,
  type InlineLogo,
  type Mailer,
  type MailDetailRow,
  type MailSeverity,
  type SendMailInput,
} from '@archivage/mailer';
import { EmailTemplateService } from '../parametres/email-template.service';

export type { MailDetailRow, MailSeverity, SendMailInput };

/** Durée de cache de l'identité et du logo. Voir `brandNow` pour le raisonnement. */
const BRAND_TTL_MS = 60_000;

/**
 * Canal e-mail des notifications (§03.5) — adaptateur Nest par-dessus `@archivage/mailer`, partagé
 * avec le worker (rappels planifiés) pour n'avoir qu'un seul gabarit et une seule politique
 * d'échec. Toute la logique vit dans le package ; ici on ne fait que câbler la configuration.
 *
 * Deux sources, deux durées de vie : le TRANSPORT (SMTP) vient de l'environnement et ne change pas
 * sans redémarrage ; l'IDENTITÉ (logo, nom, coordonnées) vient de la base et peut changer à tout
 * moment depuis l'écran de paramétrage. D'où une identité résolue à l'envoi, et non à la
 * construction du transport.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private mailer: Mailer | null = null;
  private cachedBrand: BrandConfig | null = null;
  private cachedLogo: InlineLogo | null = null;
  private brandExpiresAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: EmailTemplateService,
  ) {}

  private get instance(): Mailer {
    if (!this.mailer) {
      const host = this.config.get<string>('SMTP_HOST');
      this.mailer = createMailer(
        {
          host,
          port: this.config.get<number>('SMTP_PORT'),
          user: this.config.get<string>('SMTP_USER'),
          password: this.config.get<string>('SMTP_PASSWORD'),
          from: this.config.get<string>('SMTP_FROM'),
          appBaseUrl: this.config.get<string>('APP_BASE_URL'),
          // Identité de repli seulement : la valeur affichée vient du paramétrage en base, résolu
          // à chaque envoi (cf. `brandNow`). Ces variables couvrent les déploiements antérieurs à
          // l'écran de paramétrage, où rien n'a encore été saisi.
          orgName: this.config.get<string>('MAIL_ORG_NAME'),
          logoUrl: this.config.get<string>('MAIL_LOGO_URL'),
          productName: 'DocuPro',
        },
        (msg) => this.logger.warn(msg),
      );
      this.logger.log(
        host
          ? `Canal e-mail actif via ${host}:${this.config.get<number>('SMTP_PORT') ?? 465}`
          : 'SMTP_HOST absent : canal e-mail désactivé (notifications in-app seules).',
      );
    }
    return this.mailer;
  }

  get enabled(): boolean {
    return this.instance.enabled;
  }

  /**
   * Identité du moment (texte + logo embarqué), avec un cache d'une minute. Un envoi groupé touche
   * la même ligne autant de fois qu'il y a de destinataires : une imputation à quinze personnes
   * déclencherait quinze lectures identiques (base + fichier logo). Le TTL reste court pour qu'une
   * correction se voie sans redémarrage.
   *
   * Une lecture en échec ne fait pas échouer l'envoi : on retombe sur l'identité d'environnement.
   * Un e-mail moins personnalisé vaut mieux qu'une notification perdue.
   */
  private async brandNow(): Promise<{ brand?: BrandConfig; inlineLogo?: InlineLogo }> {
    const now = Date.now();
    if (this.cachedBrand && now < this.brandExpiresAt) {
      return { brand: this.cachedBrand, inlineLogo: this.cachedLogo ?? undefined };
    }
    try {
      const [brand, logo] = await Promise.all([this.settings.brand(), this.settings.inlineLogo()]);
      this.cachedBrand = brand;
      this.cachedLogo = logo;
      this.brandExpiresAt = now + BRAND_TTL_MS;
    } catch (e) {
      this.logger.warn(
        `Identité e-mail illisible, repli sur la configuration : ${e instanceof Error ? e.message : String(e)}`,
      );
      return {};
    }
    return { brand: this.cachedBrand, inlineLogo: this.cachedLogo ?? undefined };
  }

  /** Envoie un e-mail. Ne rejette JAMAIS : `false` en cas d'échec ou de canal désactivé. */
  async send(input: SendMailInput): Promise<boolean> {
    const { brand, inlineLogo } = await this.brandNow();
    return this.instance.send({
      ...input,
      ...(brand ? { brand } : {}),
      ...(inlineLogo ? { inlineLogo } : {}),
    });
  }
}
