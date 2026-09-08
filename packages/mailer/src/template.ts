/**
 * Gabarit HTML des notifications (§03.5), habillé aux couleurs « Plus Admin » (relook 002).
 *
 * Contraintes propres à l'e-mail, qui expliquent les choix « datés » d'ici : tables imbriquées et
 * CSS **inline** (Outlook ignore `<style>`, flex et grid), largeur fixe 600 px, images en absolu.
 * Une feuille de style moderne casserait le rendu sur la moitié des clients.
 *
 * ─── POURQUOI DES HEX EN DUR ICI (et nulle part ailleurs dans le projet) ───────────────────────
 * Les clients de messagerie — Outlook desktop en tête, dont le moteur de rendu est celui de Word —
 * ne comprennent NI les variables CSS (`var(--x)`), NI la plupart des sélecteurs modernes, NI les
 * feuilles de style externes. Un e-mail ne peut donc pas consommer `apps/web/app/theme/tokens.ts`
 * (qui est de toute façon un module du front, hors de portée de ce paquet Node). Les valeurs
 * ci-dessous sont donc RECOPIÉES à la main depuis ce fichier de tokens ; toute évolution des tokens
 * doit être répercutée ici manuellement. C'est la seule surface du projet où l'hex littéral est
 * légitime : la compatibilité client prime sur la règle « aucun hex hors tokens » (pensée pour le
 * navigateur). Même raison pour les tables de mise en page, conservées telles quelles.
 *
 * Correspondance token → valeur recopiée (specs/002-relook/design-tokens.md) :
 *   primary            #0033c4  en-tête, bouton d'action (blanc dessus : 9,25:1)
 *   primaryActive      #00279a  pastille d'organisation posée sur l'en-tête bleu
 *   bgLayout           #f8f9fb  fond de page, bandeau de tableau, pied de page
 *   bgContainer        #ffffff  carte
 *   border             #e4e9f0  bordures et filets (décoratif, §11 des tokens)
 *   text               #030303  corps (20,62:1 sur blanc)
 *   textSecondary      #687480  libellés, mentions de pied de page (4,77:1 sur blanc)
 *   success/info/warning (dérivés AA) #008453 / #007e95 / #dd2a00
 * Rondeurs : carte 3 px, bouton 4 px, pastille en pilule (grille §4.2 : 2/3/4/5/pilule).
 * Typographie : pile commençant par Open Sans — la police du produit — mais AUCUN @font-face ni
 * police distante (les clients mail ne les chargent pas) : repli Segoe UI / Roboto / Helvetica /
 * Arial / sans-serif.
 *
 * Le gabarit ne porte aucune couleur PROPRE À L'ORGANISATION destinataire (l'ancien bandeau
 * tricolore avait été retiré pour cette raison) : le bleu roi est la couleur du PRODUIT, comme la
 * top bar de l'application. En revanche la DIFFÉRENCIATION PAR SÉVÉRITÉ est intentionnelle et reste
 * active par défaut — un rappel d'échéance dépassée (`warn`) doit rester visuellement distinct
 * d'une notification ordinaire (`info`), sans quoi le destinataire perd le signal d'urgence.
 */

export type MailSeverity = 'info' | 'success' | 'warn';

/**
 * Palette par sévérité : filet d'accent du chapeau, fond du chapeau et valeurs mises en évidence.
 * `info` sert aussi de valeur par défaut quand `severity` est absent — c'est délibérément le cas
 * « neutre » de cette palette.
 *
 * Les accents sont les DÉRIVÉS AA des tokens (design-tokens.md §3.1) et non les teintes vives :
 * un e-mail se lit le plus souvent sur fond blanc, et le texte coloré (valeurs en évidence) doit
 * y rester lisible — chaque dérivé tient 4,75:1 sur blanc. Le `danger` #e50047 existe côté tokens
 * mais aucune notification ne l'émet aujourd'hui : ne pas l'ajouter ici sans un émetteur réel.
 * Les `soft` sont les fonds discrets correspondants (`*Soft` de tokens.ts).
 */
const THEME: Record<MailSeverity, { accent: string; soft: string }> = {
  info: { accent: '#007e95', soft: '#dff5fa' },
  success: { accent: '#008453', soft: '#e0f7ec' },
  warn: { accent: '#dd2a00', soft: '#ffeae4' },
};

/** Pile typographique de l'e-mail (cf. en-tête de fichier : pas de police distante possible). */
const FONT_STACK = "'Open Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Ligne du tableau de détails du courrier. */
export interface MailDetailRow {
  label: string;
  value: string;
  /** Met la valeur en évidence (référence, échéance dépassée…). */
  strong?: boolean;
}

export interface EmailContent {
  /** Bandeau de titre (ex. « Enregistrement de courrier »). */
  title: string;
  /** Phrase d'accroche sous la civilité. */
  body: string;
  /** Destinataire, pour la civilité (« À l'attention de … »). */
  recipientName?: string | null;
  /** Pilote la couleur (bandeau, bouton, valeurs en évidence) : `info` par défaut. */
  severity?: MailSeverity;
  details?: MailDetailRow[];
  /** URL absolue du bouton d'action ; absent = pas de bouton. */
  actionUrl?: string | null;
  actionLabel?: string;
  /** Bas de page propre au message (ex. « Enregistré par X »). */
  footerNote?: string | null;
}

/**
 * Identité de l'organisation. Alimentée par la table `email_template_setting` (écran « Paramétrage
 * e-mail »), avec repli sur les variables `MAIL_*` tant que rien n'est saisi.
 *
 * TOUT est facultatif et un champ vide est OMIS du rendu — jamais affiché vide, jamais remplacé par
 * une valeur par défaut inventée. Un déploiement qui ne renseigne rien obtient un e-mail sobre et
 * sans marque, ce qui est le comportement correct : mieux vaut pas de logo qu'un logo étranger.
 */
export interface BrandConfig {
  /** Nom de l'organisation affiché dans l'en-tête et le pied de page. */
  orgName?: string | null;
  /** URL absolue du logo (les images relatives ne s'affichent pas en e-mail). */
  logoUrl?: string | null;
  /** Nom du produit, en pied de page. Vient uniquement de l'environnement. */
  productName?: string | null;
  /** Coordonnées de pied de page, toutes facultatives. */
  contactEmail?: string | null;
  websiteUrl?: string | null;
}

export const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Normalise un champ de paramétrage : `null`, `undefined` et chaîne blanche valent « absent ». */
const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** Une ligne du tableau de détails. `last` supprime la bordure basse. */
function detailRow(row: MailDetailRow, accent: string, last: boolean): string {
  const border = last ? '' : 'border-bottom:1px solid #e4e9f0;';
  const valueStyle = row.strong
    ? `color:${accent};font-weight:700;`
    : 'color:#030303;font-weight:600;';
  return `<tr>
    <td style="padding:11px 16px;${border}color:#687480;font-size:12px;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;vertical-align:top;font-family:${FONT_STACK}">${escapeHtml(row.label)}</td>
    <td style="padding:11px 16px;${border}${valueStyle}font-size:14px;line-height:1.5;vertical-align:top;font-family:${FONT_STACK}">${escapeHtml(row.value)}</td>
  </tr>`;
}

/**
 * Bloc coordonnées du pied de page. Rendu à partir des seuls champs renseignés, séparés par des
 * puces : un déploiement qui n'a saisi qu'un e-mail de contact n'obtient pas une ligne vide.
 */
function contactLine(brand: BrandConfig): string {
  const parts = [clean(brand.contactEmail)].filter((v): v is string => v !== null).map(escapeHtml);
  const site = clean(brand.websiteUrl);
  if (site) {
    // Le site reste cliquable ; `href` et libellé sont échappés séparément.
    parts.push(
      `<a href="${escapeHtml(site)}" style="color:#0033c4;text-decoration:underline">${escapeHtml(
        site.replace(/^https?:\/\//, ''),
      )}</a>`,
    );
  }
  if (parts.length === 0) return '';
  return `<p style="margin:0 0 8px;color:#687480;font-size:11px;line-height:1.7;font-family:${FONT_STACK}">${parts.join(
    ' &middot; ',
  )}</p>`;
}

/**
 * Rend l'e-mail complet. Le `preheader` (texte masqué en tête) est l'extrait affiché par les
 * clients à côté de l'objet : sans lui, ils y mettent le premier texte trouvé — ici le nom de
 * l'organisation, identique sur tous les messages et donc inutile.
 */
export function renderNotificationEmail(content: EmailContent, brand: BrandConfig = {}): string {
  const theme = THEME[content.severity ?? 'info'];
  const accent = theme.accent;

  const org = clean(brand.orgName);
  const product = clean(brand.productName);
  const title = escapeHtml(content.title);
  const preheader = escapeHtml(content.body).slice(0, 140);

  const logoSrc = clean(brand.logoUrl);
  // Le logo est posé sur une plaque BLANCHE : l'en-tête est désormais bleu roi, et la plupart des
  // logos d'organisation sont sombres sur fond transparent — ils disparaîtraient sur le bleu.
  const logo = logoSrc
    ? `<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 14px"><tr>
        <td align="center" style="background:#ffffff;border-radius:3px;padding:8px 10px"><img src="${escapeHtml(logoSrc)}" alt="${escapeHtml(org ?? '')}" width="72" style="display:block;border:0;outline:none;max-width:72px;height:auto"></td>
      </tr></table>`
    : '';

  // Pastille du nom d'organisation, posée sur l'en-tête bleu : bleu pressé (#00279a = primaryActive)
  // + texte blanc, plus contrasté encore que le blanc sur #0033c4 (9,25:1). Les fonds `soft` de
  // sévérité ne conviennent plus ici : ils sont quasi blancs et disparaîtraient dans la plaque.
  const orgPill = org
    ? `<div style="display:inline-block;padding:5px 12px;border-radius:999px;background:#00279a;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-family:${FONT_STACK}">${escapeHtml(org)}</div>`
    : '';

  const details = content.details?.length
    ? `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:22px;border:1px solid #e4e9f0;border-radius:3px;border-collapse:separate;overflow:hidden">
        <tr><td colspan="2" style="padding:11px 16px;background:#f8f9fb;border-bottom:1px solid #e4e9f0;color:#030303;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-family:${FONT_STACK}">Détails du courrier</td></tr>
        ${content.details.map((r, i) => detailRow(r, accent, i === content.details!.length - 1)).join('')}
      </table>`
    : '';

  // Bouton d'action : bleu roi du produit, rayon 4 px (grille §4.2), quelle que soit la sévérité —
  // c'est l'action « aller dans l'application », pas un signal d'état.
  const cta = content.actionUrl
    ? `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" style="padding:28px 0 4px">
        <a href="${escapeHtml(content.actionUrl)}" style="display:inline-block;background:#0033c4;color:#ffffff;text-decoration:none;padding:13px 30px;border-radius:4px;font-size:14px;font-weight:600;letter-spacing:.02em;font-family:${FONT_STACK}">${escapeHtml(content.actionLabel ?? 'Consulter le courrier')}</a>
      </td></tr></table>`
    : '';

  const civility = content.recipientName
    ? `<p style="margin:0 0 10px;font-size:15px;color:#030303;font-family:${FONT_STACK}">À l'attention de <strong>${escapeHtml(content.recipientName)}</strong>,</p>`
    : '';

  // Mention propre au message (ex. « Enregistré par X »), au-dessus des coordonnées.
  const messageNote = content.footerNote
    ? `<p style="margin:0 0 12px;color:#687480;font-size:12px;font-family:${FONT_STACK}">${escapeHtml(content.footerNote)}</p>`
    : '';

  const orgFooter = org ? `<strong style="color:#030303">${escapeHtml(org)}</strong><br>` : '';
  const productFooter = product
    ? `Notification automatique ${escapeHtml(product)} — merci de ne pas répondre à ce message.`
    : 'Notification automatique — merci de ne pas répondre à ce message.';

  // En-tête bleu roi (marqueur d'identité n°1 du produit, comme la top bar). Il ne disparaît plus
  // quand rien n'est paramétré : sans logo ni nom d'organisation, il ne reste que le titre blanc
  // sur le bandeau — l'ancienne variante « zone blanche vide » n'a plus lieu d'être.
  const hasBrand = !!(logo || orgPill);
  const header = `<tr><td align="center" style="background:#0033c4;padding:${hasBrand ? '28px' : '26px'} 32px ${hasBrand ? '24px' : '26px'}">
      ${logo}
      ${orgPill}
      <h1 style="margin:${hasBrand ? '16px' : '0'} 0 0;color:#ffffff;font-size:21px;line-height:1.3;font-weight:700;font-family:${FONT_STACK}">${title}</h1>
    </td></tr>`;

  return `<!doctype html>
<html lang="fr" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f8f9fb;-webkit-font-smoothing:antialiased;font-family:${FONT_STACK}">
<div style="display:none;font-size:1px;color:#f8f9fb;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${preheader}</div>
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background:#f8f9fb">
<tr><td align="center" style="padding:28px 12px">

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e4e9f0;border-radius:3px;overflow:hidden;font-family:${FONT_STACK}">
    ${header}

    <tr><td style="padding:24px 32px 32px">
      <div style="padding:18px 20px;background:${theme.soft};border-left:3px solid ${accent};border-radius:3px">
        ${civility}
        <p style="margin:0;font-size:14px;line-height:1.6;color:#030303;font-family:${FONT_STACK}">${escapeHtml(content.body)}</p>
      </div>
      ${details}
      ${cta}
    </td></tr>

    <tr><td style="padding:18px 32px 24px;background:#f8f9fb;border-top:1px solid #e4e9f0" align="center">
      ${messageNote}
      ${contactLine(brand)}
      <p style="margin:0;color:#687480;font-size:11px;line-height:1.6;font-family:${FONT_STACK}">
        ${orgFooter}${productFooter}
      </p>
    </td></tr>
  </table>

</td></tr></table>
</body></html>`;
}
