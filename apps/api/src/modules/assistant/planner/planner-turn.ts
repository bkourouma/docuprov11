import { ASST_PROPOSAL_ACTIONS_MAX } from '@archivage/types';
import { z } from 'zod';
import {
  MODEL_TOOL_KEY_MAX_CHARS,
  MODEL_TURN_MAX_DEPTH,
  MODEL_TURN_RAW_MAX_BYTES,
  exceedsNesting,
} from '../../workflow-agents/injection/output-schema';
import { charLength, sanitizeText } from '../../workflow-agents/injection/untrusted';
import {
  PLANNER_CHOICES_MAX,
  PLANNER_CHOICES_MIN,
  PLANNER_CHOICE_LABEL_MAX_CHARS,
  PLANNER_QUESTION_MAX_CHARS,
  PLANNER_REPLY_MAX_CHARS,
  type PlannerRawAction,
} from './planner.types';

/**
 * Analyse STRICTE d'un tour du modèle de l'assistant (sortie NON FIABLE). Quatre formes :
 *  - `tool_call` : appel d'un outil de lecture ;
 *  - `clarify` : question de précision avec 2 à 6 choix ;
 *  - `answer` : réponse en texte ;
 *  - `propose` : actions à proposer (validées ensuite par le validateur d'actions).
 * Contrôles AVANT `JSON.parse` (taille, profondeur), puis clés interdites, puis schéma zod strict. Les messages
 * d'erreur ne citent JAMAIS la sortie du modèle.
 */

export type AsstTurnErrorCode = 'absent' | 'too_long' | 'too_deep' | 'not_json' | 'forbidden_key' | 'schema';

const ERROR_MESSAGES: Record<AsstTurnErrorCode, string> = {
  absent: 'Sortie du modèle absente.',
  too_long: 'Sortie du modèle trop longue.',
  too_deep: 'Sortie du modèle trop imbriquée.',
  not_json: 'Sortie du modèle illisible : JSON invalide.',
  forbidden_key: 'Sortie du modèle refusée : clé interdite.',
  schema: 'Sortie du modèle non conforme au contrat attendu.',
};

export class AsstTurnError extends Error {
  constructor(readonly code: AsstTurnErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AsstTurnError';
  }
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const ASST_INTENT_SOURCES = ['message_utilisateur', 'donnee_externe'] as const;
export type AsstIntentSource = (typeof ASST_INTENT_SOURCES)[number];

export type AsstTurn =
  | { type: 'tool_call'; tool: string; arguments: Record<string, unknown> }
  | { type: 'clarify'; question: string; choices: string[] }
  | { type: 'answer'; text: string }
  | { type: 'propose'; actions: PlannerRawAction[]; intentSource: AsstIntentSource; suspicion: boolean };

const jsonObject = z.record(z.unknown());

const toolCallSchema = z
  .object({
    type: z.literal('tool_call'),
    tool: z.string().min(1).max(MODEL_TOOL_KEY_MAX_CHARS),
    arguments: jsonObject,
  })
  .strict();

const clarifySchema = z
  .object({
    type: z.literal('clarify'),
    question: z.string().min(1).max(PLANNER_QUESTION_MAX_CHARS),
    choices: z
      .array(z.object({ label: z.string().min(1).max(PLANNER_CHOICE_LABEL_MAX_CHARS) }).strict())
      .min(PLANNER_CHOICES_MIN)
      .max(PLANNER_CHOICES_MAX),
  })
  .strict();

const answerSchema = z
  .object({
    type: z.literal('answer'),
    text: z.string().min(1).max(PLANNER_REPLY_MAX_CHARS),
  })
  .strict();

const proposeSchema = z
  .object({
    type: z.literal('propose'),
    actions: z
      .array(z.object({ tool: z.string().min(1).max(MODEL_TOOL_KEY_MAX_CHARS), args: jsonObject }).strict())
      .min(1)
      .max(ASST_PROPOSAL_ACTIONS_MAX),
    intent_source: z.enum(ASST_INTENT_SOURCES),
    suspicion: z.boolean(),
  })
  .strict();

const turnSchema = z.discriminatedUnion('type', [toolCallSchema, clarifySchema, answerSchema, proposeSchema]);

/** Recherche itérative d'une clé interdite ou d'une profondeur excessive. */
function findForbidden(value: unknown, limit: number): AsstTurnErrorCode | null {
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

/** Texte du modèle nettoyé (contrôles et invisibles retirés, espaces de bord ôtés) ; vide ou trop long = `schema`. */
function cleanText(value: string, max: number): string {
  const out = sanitizeText(value).trim();
  if (out.length === 0 || charLength(out) > max) throw new AsstTurnError('schema');
  return out;
}

/**
 * Analyse la sortie brute d'un tour. Lève `AsstTurnError` (code typé, message générique) si la sortie est absente,
 * trop longue, trop imbriquée, illisible, porteuse d'une clé interdite ou non conforme.
 */
export function parseAsstTurn(raw: string): AsstTurn {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new AsstTurnError('absent');
  if (raw.length > MODEL_TURN_RAW_MAX_BYTES || Buffer.byteLength(raw, 'utf8') > MODEL_TURN_RAW_MAX_BYTES) {
    throw new AsstTurnError('too_long');
  }
  const text = raw.replace(new RegExp(`^${String.fromCharCode(0xfeff)}`), '').trim();
  if (exceedsNesting(text, MODEL_TURN_MAX_DEPTH)) throw new AsstTurnError('too_deep');

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AsstTurnError('not_json');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new AsstTurnError('schema');
  const forbidden = findForbidden(data, MODEL_TURN_MAX_DEPTH);
  if (forbidden) throw new AsstTurnError(forbidden);

  const parsed = turnSchema.safeParse(data);
  if (!parsed.success) throw new AsstTurnError('schema');
  const turn = parsed.data;
  switch (turn.type) {
    case 'tool_call':
      return { type: 'tool_call', tool: turn.tool, arguments: turn.arguments };
    case 'clarify':
      return {
        type: 'clarify',
        question: cleanText(turn.question, PLANNER_QUESTION_MAX_CHARS),
        choices: turn.choices.map((c) => cleanText(c.label, PLANNER_CHOICE_LABEL_MAX_CHARS)),
      };
    case 'answer':
      return { type: 'answer', text: cleanText(turn.text, PLANNER_REPLY_MAX_CHARS) };
    case 'propose':
      return {
        type: 'propose',
        actions: turn.actions.map((a) => ({ tool: a.tool, args: a.args })),
        intentSource: turn.intent_source,
        suspicion: turn.suspicion,
      };
  }
}

/** JSON Schema transmis à `AiService.run` (`request.jsonSchema`). La validation qui fait foi reste zod. */
export const ASST_TURN_JSON_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: 'asst_planner_turn',
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
        required: ['type', 'question', 'choices'],
        properties: {
          type: { type: 'string', const: 'clarify' },
          question: { type: 'string', minLength: 1, maxLength: PLANNER_QUESTION_MAX_CHARS },
          choices: {
            type: 'array',
            minItems: PLANNER_CHOICES_MIN,
            maxItems: PLANNER_CHOICES_MAX,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label'],
              properties: { label: { type: 'string', minLength: 1, maxLength: PLANNER_CHOICE_LABEL_MAX_CHARS } },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'text'],
        properties: {
          type: { type: 'string', const: 'answer' },
          text: { type: 'string', minLength: 1, maxLength: PLANNER_REPLY_MAX_CHARS },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'actions', 'intent_source', 'suspicion'],
        properties: {
          type: { type: 'string', const: 'propose' },
          actions: {
            type: 'array',
            minItems: 1,
            maxItems: ASST_PROPOSAL_ACTIONS_MAX,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['tool', 'args'],
              properties: {
                tool: { type: 'string', minLength: 1, maxLength: MODEL_TOOL_KEY_MAX_CHARS },
                args: { type: 'object' },
              },
            },
          },
          intent_source: { type: 'string', enum: [...ASST_INTENT_SOURCES] },
          suspicion: { type: 'boolean' },
        },
      },
    ],
  },
};
