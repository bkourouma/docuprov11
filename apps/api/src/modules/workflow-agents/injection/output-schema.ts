import { z } from 'zod';

/**
 * Contrat STRICT d'un tour du modèle (sortie NON FIABLE). Deux formes seulement :
 *  - `{ type: "tool_call", tool, arguments }` : demande d'appel d'un outil (le runner vérifie ensuite la
 *    liste blanche de l'étape et le schéma d'arguments de l'outil) ;
 *  - `{ type: "final", result, explanation, confidence, sources?, suspicion? }` : conclusion.
 *
 * Contrôles AVANT `JSON.parse` : taille brute bornée, profondeur d'imbrication bornée. Après : clés
 * dangereuses (`__proto__`, `constructor`, `prototype`) refusées à toute profondeur, puis schéma zod strict
 * (aucune clé inconnue). Les messages d'erreur ne citent JAMAIS la sortie du modèle.
 */

/** Taille brute maximale acceptée (octets UTF-8). */
export const MODEL_TURN_RAW_MAX_BYTES = 64 * 1024;
/** Profondeur d'imbrication maximale (objets et tableaux, racine comprise). */
export const MODEL_TURN_MAX_DEPTH = 12;
export const MODEL_EXPLANATION_MAX_CHARS = 2000;
export const MODEL_TOOL_KEY_MAX_CHARS = 128;
export const MODEL_SOURCES_MAX = 50;
const SOURCE_LABEL_MAX = 300;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export type ModelTurnErrorCode = 'absent' | 'too_long' | 'too_deep' | 'not_json' | 'forbidden_key' | 'schema';

const ERROR_MESSAGES: Record<ModelTurnErrorCode, string> = {
  absent: 'Sortie du modèle absente.',
  too_long: 'Sortie du modèle trop longue.',
  too_deep: 'Sortie du modèle trop imbriquée.',
  not_json: 'Sortie du modèle illisible : JSON invalide.',
  forbidden_key: 'Sortie du modèle refusée : clé interdite.',
  schema: 'Sortie du modèle non conforme au contrat attendu.',
};

/** Sortie du modèle refusée. Le message est générique : il ne reprend jamais le contenu du modèle. */
export class ModelTurnError extends Error {
  constructor(readonly code: ModelTurnErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ModelTurnError';
  }
}

/** Objet JSON (jamais un tableau, jamais `null`). */
const jsonObject = z.record(z.unknown());

const modelSourceSchema = z
  .object({
    kind: z.enum(['document', 'mail', 'passage']),
    id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    label: z.string().max(SOURCE_LABEL_MAX).optional(),
    excerpt: z.string().max(SOURCE_LABEL_MAX).optional(),
  })
  .strict();

const toolCallSchema = z
  .object({
    type: z.literal('tool_call'),
    tool: z.string().min(1).max(MODEL_TOOL_KEY_MAX_CHARS),
    arguments: jsonObject,
  })
  .strict();

const finalSchema = z
  .object({
    type: z.literal('final'),
    result: jsonObject,
    explanation: z.string().max(MODEL_EXPLANATION_MAX_CHARS),
    // Nombre quelconque accepté ici puis ramené à `null` hors [0, 1] : une confiance aberrante ne rejette
    // pas la conclusion, elle la place sous tout seuil (retour à l'humain).
    confidence: z.number().nullable().optional(),
    sources: z.array(modelSourceSchema).max(MODEL_SOURCES_MAX).optional(),
    suspicion: z.boolean().optional(),
  })
  .strict();

export const modelTurnSchema = z.discriminatedUnion('type', [toolCallSchema, finalSchema]);

export type ModelSource = z.infer<typeof modelSourceSchema>;

export interface ModelToolCall {
  type: 'tool_call';
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ModelFinal {
  type: 'final';
  result: Record<string, unknown>;
  explanation: string;
  /** 0..1, ou `null` si absente, non finie ou hors bornes. */
  confidence: number | null;
  sources: ModelSource[];
  suspicion: boolean;
}

export type ModelTurn = ModelToolCall | ModelFinal;

/** JSON Schema transmis à `AiService.run` (`request.jsonSchema`). La validation qui fait foi reste zod. */
export const WF_AGENT_TURN_JSON_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: 'wf_agent_turn',
  schema: {
    type: 'object',
    anyOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'tool', 'arguments'],
        properties: {
          type: { type: 'string', const: 'tool_call' },
          tool: { type: 'string', minLength: 1, maxLength: MODEL_TOOL_KEY_MAX_CHARS },
          arguments: { type: 'object' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'result', 'explanation', 'confidence'],
        properties: {
          type: { type: 'string', const: 'final' },
          result: { type: 'object' },
          explanation: { type: 'string', maxLength: MODEL_EXPLANATION_MAX_CHARS },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          sources: {
            type: 'array',
            maxItems: MODEL_SOURCES_MAX,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'id'],
              properties: {
                kind: { type: 'string', enum: ['document', 'mail', 'passage'] },
                id: { type: 'integer', minimum: 0 },
                label: { type: 'string', maxLength: SOURCE_LABEL_MAX },
                excerpt: { type: 'string', maxLength: SOURCE_LABEL_MAX },
              },
            },
          },
          suspicion: { type: 'boolean' },
        },
      },
    ],
  },
};

/** Vrai si l'imbrication (objets/tableaux hors chaînes) dépasse `limit`. Balayage linéaire, sans récursion. */
export function exceedsNesting(raw: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > limit) return true;
    } else if (c === 0x7d || c === 0x5d) depth--;
  }
  return false;
}

/** Recherche itérative d'une clé interdite ou d'une profondeur excessive dans une valeur JSON analysée. */
function findForbidden(value: unknown, limit: number): ModelTurnErrorCode | null {
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 1 }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { v, d } = top;
    if (v === null || typeof v !== 'object') continue;
    if (d > limit) return 'too_deep';
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

/** Confiance utilisable : nombre fini dans [0, 1], sinon `null`. */
export function normalizeConfidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * Analyse la sortie brute d'un tour du modèle. Lève `ModelTurnError` (code typé, message générique) si la
 * sortie est absente, trop longue, trop imbriquée, illisible, porteuse d'une clé interdite ou non conforme.
 */
export function parseModelTurn(raw: string): ModelTurn {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new ModelTurnError('absent');
  // Une unité UTF-16 vaut au moins un octet : premier filtre sans calcul, puis mesure exacte.
  if (raw.length > MODEL_TURN_RAW_MAX_BYTES || Buffer.byteLength(raw, 'utf8') > MODEL_TURN_RAW_MAX_BYTES) {
    throw new ModelTurnError('too_long');
  }
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (exceedsNesting(text, MODEL_TURN_MAX_DEPTH)) throw new ModelTurnError('too_deep');

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ModelTurnError('not_json');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ModelTurnError('schema');
  const forbidden = findForbidden(data, MODEL_TURN_MAX_DEPTH);
  if (forbidden) throw new ModelTurnError(forbidden);

  const parsed = modelTurnSchema.safeParse(data);
  if (!parsed.success) throw new ModelTurnError('schema');
  const turn = parsed.data;
  if (turn.type === 'tool_call') {
    return { type: 'tool_call', tool: turn.tool, arguments: turn.arguments };
  }
  return {
    type: 'final',
    result: turn.result,
    explanation: turn.explanation,
    confidence: normalizeConfidence(turn.confidence),
    sources: turn.sources ?? [],
    suspicion: turn.suspicion === true,
  };
}
