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
