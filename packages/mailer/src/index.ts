import { createTransport, type Transporter } from 'nodemailer';
import {
  renderNotificationEmail,
  type BrandConfig,
  type EmailContent,
  type MailDetailRow,
  type MailSeverity,
} from './template';

export {
  renderNotificationEmail,
  type BrandConfig,
  type EmailContent,
  type MailDetailRow,
  type MailSeverity,
};

export {
  brandFromRow,
  createBrandLoader,
  type BrandLoaderOptions,
  type EmailBrandRow,
  type EmailBrandSource,
} from './brand';

export { loadInlineLogo, type InlineLogo } from './logo';
import type { InlineLogo } from './logo';

/** Content-ID de référence du logo embarqué, partagé entre la pièce jointe et le `<img src>`. */
const LOGO_CID = 'emaillogo';

export interface MailerConfig extends BrandConfig {
  /** Absent ⟹ canal désactivé (`send` devient un no-op). */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** Expéditeur affiché ; à défaut `user`. */
  from?: string;
  /** Base des liens d'action (le bouton du gabarit exige une URL absolue). */
  appBaseUrl?: string;
}

export interface SendMailInput extends EmailContent {
  to: string;
  /** Objet du message ; à défaut le titre du bandeau. */
  subject?: string;
  /** Chemin relatif vers l'écran concerné (ex. `/courriers/suivi/12`), préfixé par `appBaseUrl`. */
  link?: string | null;
  /**
   * Identité à appliquer à CE message, par-dessus celle de la configuration. C'est par là que
   * passe le paramétrage en base : le transport est construit une fois au démarrage, alors que
   * l'identité peut changer entre deux envois sans redémarrage.
   */
  brand?: BrandConfig;
  /**
   * Logo à EMBARQUER dans le message (pièce jointe « inline » CID). Prioritaire sur `brand.logoUrl` :
   * un logo déposé sur le serveur n'est pas joignable par URL depuis une boîte mail, il doit voyager
   * dans le message. Quand il est présent, le gabarit référence l'image par `cid:` au lieu d'une URL.
   */
  inlineLogo?: InlineLogo;
}

export interface Mailer {
  /** Le canal est-il configuré ? Permet d'éviter tout travail inutile en amont. */
  readonly enabled: boolean;
  /** Envoie un e-mail. Ne rejette JAMAIS : `false` en cas d'échec ou de canal désactivé. */
  send(input: SendMailInput): Promise<boolean>;
  close(): Promise<void>;
}

/** Version texte, pour les clients qui refusent le HTML (et pour l'anti-spam, qui l'attend). */
function toPlainText(input: SendMailInput, actionUrl: string | null): string {
  const lines = [input.title, '', input.body];
  if (input.details?.length) {
    lines.push('', 'Détails du courrier :');
    for (const d of input.details) lines.push(`  ${d.label} : ${d.value}`);
  }
  if (actionUrl) lines.push('', `${input.actionLabel ?? 'Consulter le courrier'} : ${actionUrl}`);
  if (input.footerNote) lines.push('', input.footerNote);
  return lines.join('\n');
}

/**
 * Canal e-mail des notifications (§03.5), partagé par l'API (actions utilisateur) et le worker
 * (rappels planifiés) — un seul gabarit, une seule politique d'échec.
 *
 * JAMAIS bloquant : toute erreur (SMTP injoignable, identifiants refusés, adresse invalide) est
 * remontée à `onError` puis avalée. Une notification qui échoue ne doit pas faire échouer l'action
 * métier qui l'a déclenchée, ni faire tomber un job de rappel.
 *
 * Sans `host`, le canal est désactivé : un environnement sans messagerie (dev, CI) tourne
 * normalement, seules les notifications in-app subsistent.
 */
export function createMailer(
  config: MailerConfig,
  onError: (message: string) => void = () => {},
): Mailer {
  let transporter: Transporter | null = null;
  let initialised = false;
  const enabled = !!config.host;

  // Construit à la première utilisation : inutile d'ouvrir un pool si rien n'est jamais envoyé.
  const getTransporter = (): Transporter | null => {
    if (initialised) return transporter;
    initialised = true;
    if (!config.host) return null;
    const port = config.port ?? 465;
    transporter = createTransport({
      host: config.host,
      port,
      // 465 = TLS implicite (chiffrement avant tout échange) ; 587 = STARTTLS.
      secure: port === 465,
      ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}),
      pool: true,
      maxConnections: 3,
    });
    return transporter;
  };

  return {
    enabled,

    async send(input: SendMailInput): Promise<boolean> {
      const t = getTransporter();
      if (!t || !input.to?.trim()) return false;

      // Le bouton du gabarit exige une URL absolue : un chemin relatif ne mène nulle part depuis
      // une boîte mail.
      const actionUrl =
        input.actionUrl ??
        (input.link ? `${(config.appBaseUrl ?? '').replace(/\/$/, '')}${input.link}` : null);

      // `input.brand` (paramétrage en base) écrase la configuration d'environnement, champ par
      // champ : un champ non renseigné en base laisse la valeur d'environnement en place. Toujours
      // un objet neuf, jamais `config` lui-même, qui va être muté juste après pour le logo inline.
      const brand: BrandConfig = { ...config, ...(input.brand ?? {}) };

      // Logo embarqué : le gabarit doit pointer sur la pièce jointe (`cid:`) et non sur une URL.
      // C'est le seul rendu fiable pour un logo déposé sur le serveur (cf. `InlineLogo`).
      const attachments = input.inlineLogo
        ? [
            {
              filename: input.inlineLogo.filename,
              content: input.inlineLogo.content,
              contentType: input.inlineLogo.contentType,
              cid: LOGO_CID,
              contentDisposition: 'inline' as const,
            },
          ]
        : undefined;
      if (input.inlineLogo) brand.logoUrl = `cid:${LOGO_CID}`;

      try {
        await t.sendMail({
          from: config.from || config.user || 'no-reply',
          to: input.to,
          subject: input.subject ?? input.title,
          html: renderNotificationEmail({ ...input, actionUrl }, brand),
          text: toPlainText(input, actionUrl),
          attachments,
        });
        return true;
      } catch (e) {
        onError(
          `Envoi e-mail échoué vers ${input.to} : ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
    },

    async close(): Promise<void> {
      transporter?.close();
      transporter = null;
      initialised = false;
    },
  };
}
