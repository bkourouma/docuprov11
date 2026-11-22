import type { WfAgentSource } from '../../workflow-agents/agent.contracts';

/** Bornes de sortie : le texte renvoyé est de la donnée non fiable, jamais illimité. */
export const SOURCE_EXCERPT_MAX = 300;
export const TEXT_MAX = 4000;
export const LABEL_MAX = 200;
export const DRAFT_EXCERPT_MAX = 600;

/** Même message pour « inexistant » et « interdit » : jamais de distinction. */
export const MAIL_NOT_FOUND_MESSAGE = 'Courrier introuvable ou non accessible.';
export const DOCUMENT_NOT_FOUND_MESSAGE = 'Document introuvable ou non accessible.';
export const PIECES_NOT_FOUND_MESSAGE = 'Objet introuvable ou non accessible.';
export const INPUTATION_NOT_FOUND_MESSAGE = 'Courrier ou imputation introuvable ou non accessible.';

/** Tronque par points de code (jamais au milieu d'un caractère) ; `undefined` si vide. */
export function cut(text: string | null | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const chars = Array.from(text.trim());
  if (chars.length === 0) return undefined;
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/** Comme `cut`, mais renvoie toujours une chaîne. */
export function cutOrEmpty(text: string | null | undefined, max: number): string {
  return cut(text, max) ?? '';
}

export function mailSource(id: number, reference: string | null, title: string | null): WfAgentSource {
  return { kind: 'mail', id, label: cut(reference || title || `Courrier ${id}`, LABEL_MAX) };
}

export function documentSource(id: number, label: string | null, excerpt?: string | null): WfAgentSource {
  const source: WfAgentSource = { kind: 'document', id, label: cut(label, LABEL_MAX) ?? `Document ${id}` };
  const e = cut(excerpt, SOURCE_EXCERPT_MAX);
  if (e) source.excerpt = e;
  return source;
}

/** Texte brut approximatif d'un HTML (pour un extrait court, jamais pour affichage riche). */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Date AAAA-MM-JJ (UTC) d'une date, ou `null`. */
export function isoDay(date: Date | null | undefined): string | null {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
