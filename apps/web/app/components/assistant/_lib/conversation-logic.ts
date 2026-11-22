// Logique pure des conversations de l'assistant (tri, fusion de réponses, propositions, précisions).
import { AsstMessageRole, AsstProposalStatus } from '@archivage/types';
import type {
  AsstConversationDto,
  AsstMessageDto,
  AsstPostMessageResponse,
  AsstProposalDto,
} from '@archivage/types';

const DAY_MS = 86_400_000;

function ms(iso: string): number {
  return Date.parse(iso);
}

/** Tri par dernier message décroissant (dates invalides en dernier) ; ne mute pas l'entrée. */
export function sortConversations(items: AsstConversationDto[]): AsstConversationDto[] {
  return [...items].sort((a, b) => {
    const ta = ms(a.lastMessageAt);
    const tb = ms(b.lastMessageAt);
    const va = !Number.isNaN(ta);
    const vb = !Number.isNaN(tb);
    if (va && vb) return tb - ta;
    if (va) return -1;
    if (vb) return 1;
    return 0;
  });
}

function formatParts(iso: string, withDate: boolean, withTime: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const options: Intl.DateTimeFormatOptions = {};
  if (withDate) Object.assign(options, { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (withTime) Object.assign(options, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = new Intl.DateTimeFormat('fr-FR', options).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('day')}/${get('month')}/${get('year')}`;
  const time = `${get('hour')}:${get('minute')}`;
  if (withDate && withTime) return `${date} ${time}`;
  return withDate ? date : time;
}

/** « jj/mm/aaaa HH:mm » dans le fuseau local ; « — » si la date est invalide. */
export function formatDateTimeFr(iso: string): string {
  return formatParts(iso, true, true);
}

/** « HH:mm » dans le fuseau local ; « — » si la date est invalide. */
export function formatTimeFr(iso: string): string {
  return formatParts(iso, false, true);
}

/** Titre affiché : le titre s'il est renseigné, sinon « Échange du <date> ». */
export function conversationTitle(c: AsstConversationDto): string {
  const t = c.title?.trim();
  if (t) return t;
  return `Échange du ${formatDateTimeFr(c.createdAt)}`;
}

/** Libellé de la purge automatique (en jours entiers, arrondis au-dessus). */
export function relativePurgeLabel(purgeAtIso: string, nowMs: number): string {
  const t = ms(purgeAtIso);
  if (Number.isNaN(t)) return 'Suppression automatique programmée';
  const days = Math.ceil((t - nowMs) / DAY_MS);
  if (days <= 0) return 'Suppression imminente';
  if (days === 1) return 'Supprimé automatiquement dans 1 jour';
  return `Supprimé automatiquement dans ${days} jours`;
}

/** Ajoute message utilisateur puis réponse assistant, sans doublon (le plus récent l'emporte), trié par position. */
export function mergePostMessageResponse(
  messages: AsstMessageDto[],
  res: AsstPostMessageResponse,
): AsstMessageDto[] {
  const byId = new Map<string, AsstMessageDto>();
  for (const m of [...messages, res.userMessage, res.assistantMessage]) byId.set(m.messageId, m);
  return [...byId.values()].sort((a, b) => a.position - b.position);
}

/** Remplace la proposition de même identifiant (immutable) ; tableau inchangé (même référence) si introuvable. */
export function replaceProposal(messages: AsstMessageDto[], proposal: AsstProposalDto): AsstMessageDto[] {
  const idx = messages.findIndex((m) => m.proposals.some((p) => p.proposalId === proposal.proposalId));
  if (idx < 0) return messages;
  return messages.map((m, i) =>
    i === idx
      ? { ...m, proposals: m.proposals.map((p) => (p.proposalId === proposal.proposalId ? proposal : p)) }
      : m,
  );
}

/** Retire la proposition (le message reste) ; même référence si introuvable. */
export function removeProposal(messages: AsstMessageDto[], proposalId: string): AsstMessageDto[] {
  if (!findProposal(messages, proposalId)) return messages;
  return messages.map((m) =>
    m.proposals.some((p) => p.proposalId === proposalId)
      ? { ...m, proposals: m.proposals.filter((p) => p.proposalId !== proposalId) }
      : m,
  );
}

export function findProposal(messages: AsstMessageDto[], proposalId: string): AsstProposalDto | null {
  for (const m of messages) {
    const p = m.proposals.find((x) => x.proposalId === proposalId);
    if (p) return p;
  }
  return null;
}

/** Au moins une proposition « proposée » non expirée. */
export function hasPendingProposal(messages: AsstMessageDto[], nowMs: number): boolean {
  return messages.some((m) =>
    m.proposals.some((p) => p.status === AsstProposalStatus.Proposed && ms(p.expiresAt) > nowMs),
  );
}

/**
 * Questions de précision.
 * HYPOTHÈSE À CONFIRMER : ce champ n'existe PAS au contrat actuel. On lit défensivement une propriété
 * optionnelle non contractuelle `clarification: { question?, choices }` portée par un message assistant.
 */
export function readClarification(
  message: AsstMessageDto,
): { question: string | null; choices: string[] } | null {
  if (message.role !== AsstMessageRole.Assistant) return null;
  const raw = (message as unknown as { clarification?: unknown }).clarification;
  if (typeof raw !== 'object' || raw === null) return null;
  const { question, choices } = raw as { question?: unknown; choices?: unknown };
  if (!Array.isArray(choices)) return null;
  const seen = new Set<string>();
  for (const c of choices) {
    if (typeof c !== 'string') continue;
    const t = c.trim();
    if (t.length >= 1 && t.length <= 80) seen.add(t);
  }
  const list = [...seen].slice(0, 6);
  if (list.length < 2) return null;
  const q = typeof question === 'string' && question.trim() ? question.trim() : null;
  return { question: q, choices: list };
}
