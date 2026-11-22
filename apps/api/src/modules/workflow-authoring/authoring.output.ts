import { sanitizeText, replaceAngles, truncateSafe } from '../workflow-agents/injection/untrusted';
import { exceedsNesting } from '../workflow-agents/injection/output-schema';
import { AuthoringOutputError, type AuthoringModelOutput } from './authoring.contracts';

// Docu-Flow W5 — analyse BORNÉE de la sortie texte du modèle générateur (donnée non fiable).
// Fonction pure : taille, clôtures Markdown, JSON, profondeur, clés dangereuses, forme de l'enveloppe.
// Le graphe n'est PAS validé ici (garde-fous puis `validateWorkflowGraph`). Les messages d'erreur sont FIXES :
// ils ne reprennent jamais le contenu du modèle.

export const AUTHORING_OUTPUT_MAX_BYTES = 128 * 1024;
export const AUTHORING_OUTPUT_MAX_DEPTH = 12;
export const AUTHORING_OUTPUT_NAME_MAX = 200;
export const AUTHORING_OUTPUT_NAME_FALLBACK = 'Workflow sans titre';
export const AUTHORING_OUTPUT_DESCRIPTION_MAX = 4000;
export const AUTHORING_OUTPUT_MAX_ASSUMPTIONS = 50;
export const AUTHORING_OUTPUT_ASSUMPTION_MAX = 600;
export const AUTHORING_OUTPUT_REASON_MAX = 300;
const EVENT_TYPE_MAX = 80;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const AUTHORING_OUTPUT_ERRORS = {
  absent: 'Réponse du générateur absente.',
  too_long: 'Réponse du générateur trop volumineuse.',
  too_deep: 'Réponse du générateur trop imbriquée.',
  not_json: 'Réponse du générateur illisible : JSON invalide.',
  not_object: 'Réponse du générateur non conforme : un objet JSON est attendu.',
  forbidden_key: 'Réponse du générateur refusée : clé interdite.',
  no_graph: 'Réponse du générateur non conforme : le graphe est absent.',
} as const;

function fail(code: keyof typeof AUTHORING_OUTPUT_ERRORS): never {
  throw new AuthoringOutputError(AUTHORING_OUTPUT_ERRORS[code]);
}

/** Retire un habillage Markdown ```json … ``` (ou ``` … ```). */
function stripFences(text: string): string {
  if (!text.startsWith('```')) return text;
  const closed = /^```[^\n`]*\n?([\s\S]*?)\n?```\s*$/.exec(text);
  if (closed) return (closed[1] ?? '').trim();
  // Clôture ouvrante seule (réponse tronquée) : on retire la première ligne.
  return text.replace(/^```[^\n]*\n?/, '').trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Recherche itérative d'une clé interdite ou d'une profondeur excessive. */
function findProblem(value: unknown): 'too_deep' | 'forbidden_key' | null {
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 1 }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { v, d } = top;
    if (v === null || typeof v !== 'object') continue;
    if (d > AUTHORING_OUTPUT_MAX_DEPTH) return 'too_deep';
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, d: d + 1 });
      continue;
    }
    for (const key of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(key)) return 'forbidden_key';
      stack.push({ v: (v as Record<string, unknown>)[key], d: d + 1 });
    }
  }
  return null;
}

function cleanLine(value: string, max: number): string {
  return truncateSafe(replaceAngles(sanitizeText(value)).replace(/\s+/g, ' ').trim(), max);
}

function parseTrigger(value: unknown): AuthoringModelOutput['trigger'] {
  if (!isPlainRecord(value) || typeof value.eventType !== 'string') return null;
  const eventType = value.eventType.trim();
  if (eventType.length === 0 || eventType.length > EVENT_TYPE_MAX) return null;
  const trigger: NonNullable<AuthoringModelOutput['trigger']> = { eventType };
  if (value.conditions !== undefined) trigger.conditions = value.conditions;
  if (typeof value.reason === 'string') {
    const reason = cleanLine(value.reason, AUTHORING_OUTPUT_REASON_MAX);
    if (reason.length > 0) trigger.reason = reason;
  }
  return trigger;
}

/**
 * Analyse la sortie brute du modèle. Lève `AuthoringOutputError` (message fixe) si elle est absente, trop longue,
 * trop imbriquée, illisible, porteuse d'une clé interdite, qui n'est pas un objet ou sans graphe.
 * Les champs facultatifs mal formés sont ramenés à une valeur sûre (jamais recopiés tels quels).
 */
export function parseAuthoringOutput(raw: string): AuthoringModelOutput {
  if (typeof raw !== 'string' || raw.trim().length === 0) fail('absent');
  if (raw.length > AUTHORING_OUTPUT_MAX_BYTES || Buffer.byteLength(raw, 'utf8') > AUTHORING_OUTPUT_MAX_BYTES) {
    fail('too_long');
  }
  const text = stripFences(raw.replace(/^\uFEFF/, '').trim());
  if (text.length === 0) fail('absent');
  if (exceedsNesting(text, AUTHORING_OUTPUT_MAX_DEPTH)) fail('too_deep');

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('not_json');
  }
  if (!isPlainRecord(data)) fail('not_object');
  const problem = findProblem(data);
  if (problem) fail(problem);
  const obj = data as Record<string, unknown>;

  if (!isPlainRecord(obj.graph)) fail('no_graph');

  const name =
    typeof obj.name === 'string' ? cleanLine(obj.name, AUTHORING_OUTPUT_NAME_MAX) : '';
  let description: string | null = null;
  if (typeof obj.description === 'string') {
    const d = truncateSafe(replaceAngles(sanitizeText(obj.description)).trim(), AUTHORING_OUTPUT_DESCRIPTION_MAX);
    description = d.length > 0 ? d : null;
  }
  const assumptions: string[] = [];
  if (Array.isArray(obj.assumptions)) {
    for (const item of obj.assumptions) {
      if (typeof item !== 'string') continue;
      const line = cleanLine(item, AUTHORING_OUTPUT_ASSUMPTION_MAX);
      if (line.length === 0) continue;
      assumptions.push(line);
      if (assumptions.length >= AUTHORING_OUTPUT_MAX_ASSUMPTIONS) break;
    }
  }

  return {
    name: name.length > 0 ? name : AUTHORING_OUTPUT_NAME_FALLBACK,
    description,
    graph: obj.graph,
    assumptions,
    trigger: parseTrigger(obj.trigger),
  };
}
