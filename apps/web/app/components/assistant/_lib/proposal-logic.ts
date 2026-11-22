// Logique PURE de la carte de confirmation de l'assistant (aucun React, DOM ni fetch).
// Contrat : docs/assistant-api.md, sections 3 (carte), 4 (erreurs) et 5 (actions, sécurité).
// Limite du contrat : les actions ne portent que des IDENTIFIANTS (groupes, types, courrier), jamais de noms ;
// seul le `summary` serveur porte des noms lisibles. On affiche donc « n° X » et on s'appuie sur le résumé.
import {
  ASST_ACTION_TOOL_LABELS,
  AsstActionTool,
  AsstErrorCode,
  AsstProposalStatus,
  type AsstProposalDto,
  type AsstProposedAction,
} from '@archivage/types';

export type CardPhase = 'proposed' | 'confirming' | 'applied' | 'refused' | 'expired' | 'failed';
export type Busy = null | 'confirm' | 'refuse';

type StatusInput = Pick<AsstProposalDto, 'status' | 'expiresAt'>;

/** Statut effectif (indicatif, le serveur fait foi) : une proposition 0 dont l'échéance est passée (ou illisible) est 4. */
export function effectiveStatus(p: StatusInput, nowMs: number): AsstProposalStatus {
  if (p.status === AsstProposalStatus.Proposed) {
    const exp = Date.parse(p.expiresAt);
    if (!Number.isFinite(exp) || nowMs >= exp) return AsstProposalStatus.Expired;
  }
  return p.status;
}

export function cardPhase(p: StatusInput, nowMs: number, busy: Busy): CardPhase {
  if (busy) return 'confirming';
  switch (effectiveStatus(p, nowMs)) {
    case 0:
      return 'proposed';
    case 1:
      return 'confirming';
    case 2:
      return 'applied';
    case 3:
      return 'refused';
    case 4:
      return 'expired';
    default:
      return 'failed';
  }
}

export function canConfirm(p: StatusInput, nowMs: number, busy: Busy): boolean {
  return busy === null && effectiveStatus(p, nowMs) === AsstProposalStatus.Proposed;
}
export function canRefuse(p: StatusInput, nowMs: number, busy: Busy): boolean {
  return canConfirm(p, nowMs, busy);
}

export function remainingSeconds(expiresAt: string, nowMs: number): number {
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return 0;
  return Math.max(0, Math.ceil((exp - nowMs) / 1000));
}

/** « 14 min 32 s », « 1 min » (secondes nulles omises), « 45 s », « Expirée » à 0. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (s === 0) return 'Expirée';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${r} s`;
}

/** « 09:29 » en heure locale du navigateur ; « — » si la date est illisible. */
export function formatExpiryClock(expiresAt: string): string {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Texte brut
// ---------------------------------------------------------------------------

const BLOCK_TAGS = 'p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|blockquote|pre|hr';

/**
 * HTML -> texte brut. Le résultat est destiné à être rendu comme TEXTE (React l'échappe) : on ne produit jamais de HTML.
 * Les entités sont décodées APRÈS le retrait des balises ; « &lt;script&gt; » devient donc le texte « <script> », inoffensif.
 */
export function htmlToPlainText(html: string, max = 400): { text: string; truncated: boolean } {
  let s = typeof html === 'string' ? html : '';
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, ' ');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(script|style)\b[\s\S]*$/gi, ' '); // balise jamais refermée
  s = s.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>?`, 'gi'), ' ');
  s = s.replace(/<[a-zA-Z/!?][^>]*>?/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
  s = s.replace(/\s+/g, ' ').trim();
  const limit = Math.max(0, Math.floor(max));
  if (s.length <= limit) return { text: s, truncated: false };
  let cut = s.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), truncated: true };
}

// ---------------------------------------------------------------------------
// Description des actions
// ---------------------------------------------------------------------------

export type Row = { label: string; value: string };
export interface ActionView {
  tool: string;
  title: string;
  rows: Row[];
  items?: { title: string; rows: Row[] }[];
  reversibility: 'none' | 'deletable';
  note?: string;
}

const DASH = '—';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function text(v: unknown): string {
  if (typeof v === 'string') return v.trim() === '' ? DASH : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return DASH;
}
function num(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return `n° ${v}`;
  if (typeof v === 'string' && /^\d{1,18}$/.test(v.trim())) return `n° ${v.trim()}`;
  return DASH;
}
function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}
function days(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? `${v} jour${v === 1 ? '' : 's'}` : 'Non précisé';
}

export function describeAction(a: AsstProposedAction): ActionView {
  try {
    const tool = isRecord(a) && typeof a.tool === 'string' ? a.tool : '';
    const args: Record<string, unknown> = isRecord(a) && isRecord(a.args) ? a.args : {};
    switch (tool) {
      case AsstActionTool.ImputationCourrier: {
        const recipients = Array.isArray(args.recipients) ? args.recipients : [];
        return {
          tool,
          title: ASST_ACTION_TOOL_LABELS[tool],
          rows: [
            { label: 'Courrier', value: num(args.mailId) },
            { label: 'Motif', value: text(args.rationale) },
          ],
          items: recipients.map((r, i) => {
            const rec: Record<string, unknown> = isRecord(r) ? r : {};
            const rows: Row[] = [
              { label: 'Groupe d’utilisateurs', value: num(rec.userGroupId) },
              { label: 'Type d’imputation', value: num(rec.mailInputationTypeId) },
              { label: 'Délai', value: days(rec.delayDays) },
            ];
            if (present(rec.instructions)) rows.push({ label: 'Instructions', value: text(rec.instructions) });
            return { title: `Destinataire ${i + 1}`, rows };
          }),
          reversibility: 'none',
        };
      }
      case AsstActionTool.Relance: {
        const rows: Row[] = [
          { label: 'Courrier', value: num(args.mailId) },
          { label: 'Imputation visée', value: num(args.mailInputationId) },
          { label: 'Destinataire (groupe)', value: num(args.recipientUserGroupId) },
          { label: 'Message', value: text(args.message) },
        ];
        if (present(args.escalateToUserGroupId))
          rows.push({ label: 'Escalade vers (groupe)', value: num(args.escalateToUserGroupId) });
        return {
          tool,
          title: ASST_ACTION_TOOL_LABELS[tool],
          rows,
          reversibility: 'none',
          note: 'Notification interne : aucun e-mail n’est envoyé.',
        };
      }
      case AsstActionTool.BrouillonReponse: {
        const html = typeof args.draftHtml === 'string' ? args.draftHtml : '';
        const preview = htmlToPlainText(html, 400);
        const rows: Row[] = [
          { label: 'Intitulé', value: text(args.label) },
          { label: 'Modèle', value: text(args.templateId) },
        ];
        if (present(args.mailId)) rows.push({ label: 'Courrier', value: num(args.mailId) });
        if (present(args.spaceId)) rows.push({ label: 'Espace', value: num(args.spaceId) });
        rows.push({
          label: 'Contenu du brouillon',
          value: preview.text === '' ? DASH : preview.text + (preview.truncated ? '…' : ''),
        });
        rows.push({ label: 'Taille', value: `(${html.length} caractères)` });
        return {
          tool,
          title: ASST_ACTION_TOOL_LABELS[tool],
          rows,
          reversibility: 'deletable',
          note: 'Un document brouillon sera créé.',
        };
      }
      default:
        return unknownView(tool);
    }
  } catch {
    return unknownView('');
  }
}

function unknownView(tool: string): ActionView {
  return {
    tool,
    title: 'Action non reconnue',
    rows: [],
    reversibility: 'none',
    note: 'Cette action ne peut pas être détaillée ; refusez-la si vous avez un doute.',
  };
}

export function cardWarnings(actions: AsstProposedAction[], opts: { remainingSec: number }): string[] {
  const list = Array.isArray(actions) ? actions : [];
  const out: string[] = [];
  if (list.some((a) => describeAction(a).reversibility === 'none'))
    out.push('Cette action écrit dans l’application et ne peut pas être annulée automatiquement.');
  if (list.length > 1) out.push(`Plusieurs actions seront appliquées en une seule confirmation (${list.length}).`);
  if (opts.remainingSec > 0 && opts.remainingSec <= 60) out.push('Cette proposition expire dans moins d’une minute.');
  return out;
}

// ---------------------------------------------------------------------------
// Effets (statut Appliquée). La forme de `summary` n'est pas figée : affichage générique.
// ---------------------------------------------------------------------------

const EFFECT_LABELS: Record<string, string> = {
  mailId: 'Courrier',
  inputationsCreees: 'Imputations créées',
  notificationsCreees: 'Notifications créées',
  documentId: 'Document',
};
const EFFECT_ROWS_MAX = 12;

export function describeEffect(e: { tool: string; summary: Record<string, unknown> }): { title: string; rows: Row[] } {
  const tool = isRecord(e) && typeof e.tool === 'string' ? e.tool : '';
  const title = (ASST_ACTION_TOOL_LABELS as Record<string, string>)[tool] ?? 'Effet';
  const summary = isRecord(e) && isRecord(e.summary) ? e.summary : {};
  const rows: Row[] = [];
  for (const key of Object.keys(summary)) {
    if (rows.length >= EFFECT_ROWS_MAX) break;
    rows.push({ label: EFFECT_LABELS[key] ?? key, value: effectValue(key, summary[key]) });
  }
  return { title, rows };
}

function effectValue(key: string, v: unknown): string {
  if ((key === 'mailId' || key === 'documentId') && (typeof v === 'number' || typeof v === 'string') && String(v) !== '')
    return `n° ${String(v)}`;
  if (v === null || v === undefined) return DASH;
  if (typeof v === 'object') {
    let json: string;
    try {
      json = JSON.stringify(v) ?? DASH;
    } catch {
      json = DASH;
    }
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Erreurs (tables 3.3 et 3.4 du contrat)
// ---------------------------------------------------------------------------

export type CardNotice = { kind: 'conflict' | 'reload-needed' | 'error' | 'info'; message: string };
export type ProposalErrorOutcome =
  | { kind: 'replace'; proposal: AsstProposalDto; notice?: CardNotice }
  | { kind: 'reload'; notice: CardNotice }
  | { kind: 'remove' }
  | { kind: 'notice'; notice: CardNotice };

export function resolveProposalError(
  _action: 'confirm' | 'refuse',
  err: { status: number; errorCode: string | null; message: string; proposal?: AsstProposalDto | null },
): ProposalErrorOutcome {
  const fallback =
    err.message && err.message.trim() !== '' ? err.message : 'Une erreur est survenue. Réessayez plus tard.';
  switch (err.errorCode) {
    case AsstErrorCode.Conflict:
      return {
        kind: 'reload',
        notice: {
          kind: 'conflict',
          message: 'La proposition a changé. Relisez-la, puis confirmez à nouveau si elle vous convient.',
        },
      };
    case AsstErrorCode.ProposalExpired:
      return { kind: 'reload', notice: { kind: 'info', message: 'Cette proposition a expiré. Reformulez votre demande.' } };
    case AsstErrorCode.ProposalNotPending:
      return {
        kind: 'reload',
        notice: { kind: 'info', message: 'Cette proposition n’est plus en attente : voici son état actuel.' },
      };
    case AsstErrorCode.EffectFailed:
      if (err.proposal) return { kind: 'replace', proposal: err.proposal };
      return { kind: 'notice', notice: { kind: 'error', message: fallback } };
    case AsstErrorCode.EffectForbidden:
      if (err.proposal) return { kind: 'replace', proposal: err.proposal };
      // Sans proposition fournie, l'état serveur est incertain : on relit, Confirmer ne reste pas actif.
      return { kind: 'reload', notice: { kind: 'error', message: fallback } };
    case AsstErrorCode.NotFound:
      return { kind: 'remove' };
    case AsstErrorCode.IdentityRefused:
      return {
        kind: 'notice',
        notice: { kind: 'error', message: 'Accès refusé. Reconnectez-vous ou contactez votre administrateur.' },
      };
    case AsstErrorCode.InvalidInput:
      return {
        kind: 'notice',
        notice: {
          kind: 'error',
          message: 'La demande n’a pas pu être envoyée correctement. Rechargez la page et réessayez.',
        },
      };
    case AsstErrorCode.NotImplemented:
      return { kind: 'notice', notice: { kind: 'error', message: 'Fonction indisponible pour l’instant.' } };
    default:
      if (err.status === 501)
        return { kind: 'notice', notice: { kind: 'error', message: 'Fonction indisponible pour l’instant.' } };
      // Réseau (0) ou 5xx hors 503 : l'effet a pu être appliqué, on relit la proposition (message d'erreur conservé).
      if (err.status === 0 || (err.status >= 500 && err.status !== 503))
        return { kind: 'reload', notice: { kind: 'error', message: fallback } };
      return { kind: 'notice', notice: { kind: 'error', message: fallback } };
  }
}

// ---------------------------------------------------------------------------
// Verrou d'envoi et charge utile de confirmation
// ---------------------------------------------------------------------------

/** Verrou SYNCHRONE anti double-clic (l'état React ne suffit pas : deux clics peuvent précéder le rendu). */
export function createSubmitLock(): {
  tryAcquire(key: string): boolean;
  release(key: string): void;
  isLocked(key: string): boolean;
} {
  const held = new Set<string>();
  return {
    tryAcquire(key) {
      if (held.has(key)) return false;
      held.add(key);
      return true;
    },
    release(key) {
      held.delete(key);
    },
    isLocked(key) {
      return held.has(key);
    },
  };
}

/** Le `argsHash` est renvoyé EXACTEMENT tel que reçu (aucune normalisation de casse, aucun recalcul). */
export function confirmPayload(p: Pick<AsstProposalDto, 'proposalId' | 'argsHash'>): { proposalId: string; argsHash: string } {
  return { proposalId: p.proposalId, argsHash: p.argsHash };
}
