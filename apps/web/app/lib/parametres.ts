import { apiJson, apiUpload, API_BASE } from './api';

/**
 * Paramétrage de l'identité des e-mails de notification.
 *
 * Toutes les valeurs sont `string | null` : côté serveur, un champ vidé est normalisé en `null`
 * (« non renseigné ») et le gabarit l'omet. Le formulaire renvoie donc ses champs vides tels quels,
 * sans avoir à distinguer « effacé » de « jamais rempli ».
 */
export interface EmailTemplateSetting {
  orgName: string | null;
  logoFileName: string | null;
  logoOriginalName: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
  updatedAt: string | null;
}

/** Champs éditables au formulaire — le logo passe par ses propres endpoints (multipart). */
export type EmailTemplatePayload = Partial<
  Pick<EmailTemplateSetting, 'orgName' | 'contactEmail' | 'websiteUrl'>
>;

const BASE = '/parametres/email-template';

/**
 * URL du site : absolue, en http(s) — MIROIR de `optionalUrl` dans `email-template.dto.ts`. La règle
 * `type: 'url'` d'AntD acceptait `ftp://…`, `//…` ou `www.…`, que l'API refuse ensuite : la saisie
 * passait le formulaire et échouait à l'enregistrement sans message utile.
 */
export const WEBSITE_URL_PATTERN = /^https?:\/\/\S+$/i;

/** Formats de logo acceptés — miroir de `ACCEPTED_LOGO` dans `email-template.service.ts`. */
export const LOGO_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;

/** Poids maximal du logo — miroir de `MAX_LOGO_BYTES` côté API (1 Mo). */
export const LOGO_MAX_BYTES = 1024 * 1024;

/**
 * Contrôle local du logo AVANT l'envoi, avec les messages exacts de l'API. Le serveur reste
 * l'autorité ; ce contrôle évite seulement un aller-retour dont l'erreur se lirait « HTTP 400 »
 * (`apiUpload` ne relaie pas le message de l'API). Renvoie `null` si le fichier est acceptable.
 */
export function checkLogoFile(file: { name: string; size: number }): string | null {
  if (!file.size) return 'Aucun fichier reçu';
  if (file.size > LOGO_MAX_BYTES) return 'Logo trop volumineux (1 Mo maximum)';
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot).toLowerCase() : '';
  if (!(LOGO_EXTENSIONS as readonly string[]).includes(ext)) {
    return `Format non accepté (${ext || 'inconnu'}) — attendu : ${LOGO_EXTENSIONS.join(', ')}`;
  }
  return null;
}

export const getEmailTemplate = (): Promise<EmailTemplateSetting> =>
  apiJson<EmailTemplateSetting>(BASE);

export const saveEmailTemplate = (body: EmailTemplatePayload): Promise<EmailTemplateSetting> =>
  apiJson<EmailTemplateSetting>(BASE, { method: 'PUT', body: JSON.stringify(body) });

export function uploadEmailLogo(file: File): Promise<EmailTemplateSetting> {
  const form = new FormData();
  form.append('file', file);
  return apiUpload<EmailTemplateSetting>(`${BASE}/logo`, form);
}

export const deleteEmailLogo = (): Promise<EmailTemplateSetting> =>
  apiJson<EmailTemplateSetting>(`${BASE}/logo`, { method: 'DELETE' });

/**
 * URL d'aperçu du logo pour l'écran de paramétrage (l'admin qui visualise sa config). Les e-mails,
 * eux, embarquent le logo et n'utilisent pas cette route. Le paramètre anti-cache force le
 * rafraîchissement après un remplacement, la route étant mise en cache une heure.
 */
export const emailLogoPreviewUrl = (cacheBuster: string | number): string =>
  `${API_BASE}${BASE}/logo?v=${encodeURIComponent(String(cacheBuster))}`;
