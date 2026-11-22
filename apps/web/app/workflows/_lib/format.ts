// Docu-Flow — formats d'affichage (dates en français, échéances, confiance, clé d'idempotence).
// Fonctions pures, sans dépendance au navigateur hors `Intl`.

/** Date et heure locales en français ; « — » si absente ou invalide. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export type DueState = 'none' | 'overdue' | 'soon' | 'ok';

export interface DueInfo {
  state: DueState;
  /** Texte court : « En retard de 2 h », « Dans 3 j », « Sans échéance ». */
  label: string;
  /** Millisecondes jusqu'à l'échéance (négatif si dépassée) ; null sans échéance. */
  msLeft: number | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function span(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < HOUR) return `${Math.max(1, Math.round(abs / 60_000))} min`;
  if (abs < DAY) return `${Math.round(abs / HOUR)} h`;
  return `${Math.round(abs / DAY)} j`;
}

/** État d'une échéance : en retard (dépassée), proche (moins de `soonHours`), correcte. */
export function dueInfo(dueAt: string | null | undefined, now: Date = new Date(), soonHours = 24): DueInfo {
  if (!dueAt) return { state: 'none', label: 'Sans échéance', msLeft: null };
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return { state: 'none', label: 'Sans échéance', msLeft: null };
  const msLeft = due - now.getTime();
  if (msLeft < 0) return { state: 'overdue', label: `En retard de ${span(msLeft)}`, msLeft };
  return { state: msLeft <= soonHours * HOUR ? 'soon' : 'ok', label: `Dans ${span(msLeft)}`, msLeft };
}

/** Confiance décimale (« 0.8500 ») en pourcentage entier (« 85 % ») ; null si absente ou invalide. */
export function formatConfidence(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(1, Math.max(0, n));
  return `${Math.round(clamped * 100)} %`;
}

/** Clé d'idempotence d'un lancement manuel : unique par ouverture du dialogue, 200 caractères au plus. */
export function newIdempotencyKey(prefix = 'manuel'): string {
  const c = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  const rand =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${rand}`.slice(0, 200);
}

/** Texte d'un champ de journal ou de boîte : chaîne non vide seulement ; jamais d'objet brut affiché. */
export function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
