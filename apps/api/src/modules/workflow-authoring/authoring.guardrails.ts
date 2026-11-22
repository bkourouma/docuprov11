import {
  WF_AUTHORING_MARKER_KEY,
  WF_CONDITION_OPS,
  WF_GRAPH_SCHEMA_VERSION,
  type WfAuthoringToDoItem,
} from '@archivage/types';
import { detectInjection } from '../workflow-agents/injection/suspicion';
import { replaceAngles, sanitizeText, truncateSafe } from '../workflow-agents/injection/untrusted';
import {
  AUTHORING_MAX_STEPS,
  AUTHORING_MIN_CONFIDENCE,
  type GuardrailContext,
  type GuardrailResult,
} from './authoring.contracts';

/**
 * Garde-fous appliqués au graphe BRUT proposé par le modèle (Docu-Flow W5), AVANT `validateWorkflowGraph`.
 *
 * Le modèle est traité comme un tiers non fiable : même s'il « obéit » à une consigne cachée dans la
 * description, rien de ce qui suit ne survit au nettoyage :
 *  - autonomie autre que "suggere", marquage de faible risque, modèle ou budget imposés ;
 *  - outil absent du catalogue actif ;
 *  - affectation à un identifiant (utilisateur, groupe, rôle) : jamais inventée, laissée « à compléter » ;
 *  - clé inconnue (étape, arête, agent, config), clés de prototype, texte ressemblant à une consigne.
 * Ne lève jamais et ne modifie jamais son entrée (copie). Aucune validation de graphe ici : le service
 * appelle `validateWorkflowGraph` ensuite, ce qui déclenche au besoin la passe de réparation.
 */

/** Texte de remplacement d'une chaîne qui ressemble à une consigne détournée. */
export const GUARDRAIL_NEUTRAL_TEXT = 'À compléter : texte retiré, il ressemblait à une consigne détournée';
export const GUARDRAIL_EMPTY_OBJECTIVE = 'À compléter : objectif de l’étape';
/** Préfixe posé (une seule fois) sur la description d'une étape humaine sans affectation. */
export const GUARDRAIL_ASSIGNEE_PREFIX = 'À compléter : affectation';

export const GUARDRAIL_STEP_KEY_MAX = 100;
export const GUARDRAIL_NAME_MAX = 200;
export const GUARDRAIL_DESCRIPTION_MAX = 2000;
export const GUARDRAIL_LABEL_MAX = 200;
export const GUARDRAIL_OBJECTIVE_MAX = 4000;
export const GUARDRAIL_HINT_MAX = 120;
export const GUARDRAIL_FIELD_MAX = 200;
export const GUARDRAIL_CONDITION_STRING_MAX = 200;
export const GUARDRAIL_ARRAY_MAX = 50;
export const GUARDRAIL_EDGES_MAX = 50;
export const GUARDRAIL_TOOLS_MAX = 100;
export const GUARDRAIL_AGENT_MAX_STEPS = 10;
const TYPE_MAX = 50;
const TOOL_NOTE_NAME_MAX = 60;
const TOOL_NOTES_MAX = 20;
const CONDITION_NOTES_MAX = 20;
const CHOICE_MAX = 100;

const HUMAN_TYPES: ReadonlySet<string> = new Set(['formulaire', 'generation', 'checklist', 'affectation', 'validation']);
const KEPT_ASSIGNEE_KINDS: ReadonlySet<string> = new Set(['initiator', 'subject_owner']);
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);
const AGENT_LOW_RISK_KEYS: readonly string[] = ['isLowRisk', 'lowRisk', 'is_low_risk', 'low_risk'];
/** Clés de faible risque ou d'autonomie interdites au niveau du graphe et de l'étape. */
const LOW_RISK_KEYS: readonly string[] = [...AGENT_LOW_RISK_KEYS, 'autonomy'];
const PRIORITY_WORDS: ReadonlySet<string> = new Set(['basse', 'normale', 'haute']);
const CONFIG_FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const CONDITION_OPS: ReadonlySet<string> = new Set(WF_CONDITION_OPS);

type Json = Record<string, unknown>;

interface State {
  allowed: ReadonlySet<string>;
  notes: string[];
  toComplete: WfAuthoringToDoItem[];
  removed: GuardrailResult['removed'];
  toolNotes: number;
  conditionNotes: number;
  thresholdRaised: boolean;
  keptTools: boolean;
  escalationRemoved: boolean;
  skippedSteps: number;
}

function isPlainObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function own(obj: Json, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function hasOwn(obj: Json, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Nettoyage sans détection : NFKC, invisibles, chevrons, blancs, troncature sûre. */
function clean(raw: string, max: number, singleLine: boolean): string {
  let out = replaceAngles(sanitizeText(raw, max * 4 + 1024));
  out = singleLine ? out.replace(/\s+/g, ' ') : out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return truncateSafe(out.trim(), max);
}

/**
 * Chaîne affichée : nettoyée et bornée ; remplacée par un texte neutre si elle ressemble à une consigne.
 * Renvoie `undefined` si l'entrée n'est pas une chaîne.
 */
function cleanText(raw: unknown, max: number, st: State, singleLine = true): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (detectInjection(raw).suspicious) {
    st.removed.suspiciousText++;
    return truncateSafe(GUARDRAIL_NEUTRAL_TEXT, max);
  }
  return clean(raw, max, singleLine);
}

/** Libellé court et inerte pour une note (nom d'outil refusé). */
function noteName(raw: unknown): string {
  if (typeof raw !== 'string') return '(valeur non textuelle)';
  if (detectInjection(raw).suspicious) return '(nom retiré)';
  return clean(raw, TOOL_NOTE_NAME_MAX, true) || '(vide)';
}

function addConditionNote(st: State, stepKey: string, reason: string): void {
  st.conditionNotes++;
  if (st.conditionNotes <= CONDITION_NOTES_MAX) {
    st.notes.push(`Étape « ${stepKey} » : condition d’une arête retirée (${reason}) ; l’arête devient une arête de repli, à revoir.`);
  }
}

function detectLowRisk(obj: Json, st: State): void {
  if (LOW_RISK_KEYS.some((k) => hasOwn(obj, k))) {
    st.removed.autonomy++;
  }
}

// ---------------------------------------------------------------------------
// Arêtes
// ---------------------------------------------------------------------------

function cleanConditionValue(v: unknown, st: State): { ok: true; value: unknown } | { ok: false } {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || typeof v === 'boolean') return { ok: true, value: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, value: v } : { ok: false };
  if (typeof v === 'string') return { ok: true, value: cleanText(v, GUARDRAIL_CONDITION_STRING_MAX, st) };
  if (Array.isArray(v)) {
    if (v.length > GUARDRAIL_ARRAY_MAX) return { ok: false };
    const out: unknown[] = [];
    for (const item of v) {
      const c = cleanConditionValue(item, st);
      if (!c.ok || Array.isArray(item)) return { ok: false };
      out.push(c.value);
    }
    return { ok: true, value: out };
  }
  return { ok: false }; // objet : refusé (aucune forme libre transmise au moteur)
}

function cleanCondition(raw: unknown, stepKey: string, st: State): Json | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    addConditionNote(st, stepKey, 'forme invalide');
    return undefined;
  }
  const field = own(raw, 'field');
  if (typeof field !== 'string' || field.length === 0 || field.length > GUARDRAIL_FIELD_MAX) {
    addConditionNote(st, stepKey, 'champ absent ou trop long');
    return undefined;
  }
  const cleanField = sanitizeText(field).trim();
  if (!cleanField || cleanField.split('.').some((seg) => FORBIDDEN_SEGMENTS.has(seg))) {
    addConditionNote(st, stepKey, 'chemin interdit');
    return undefined;
  }
  if (/[\s<>]/.test(cleanField)) {
    addConditionNote(st, stepKey, 'chemin invalide');
    return undefined;
  }
  const op = own(raw, 'op');
  if (typeof op !== 'string' || !CONDITION_OPS.has(op)) {
    addConditionNote(st, stepKey, 'opérateur inconnu');
    return undefined;
  }
  const out: Json = { field: cleanField, op };
  if (op !== 'exists') {
    const value = cleanConditionValue(own(raw, 'value'), st);
    if (!value.ok) {
      addConditionNote(st, stepKey, 'valeur non admise');
      return undefined;
    }
    if (value.value !== undefined) out.value = value.value;
  }
  return out;
}

function cleanEdges(raw: unknown, stepKey: string, st: State): Json[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > GUARDRAIL_EDGES_MAX) {
    st.notes.push(`Étape « ${stepKey} » : seules les ${GUARDRAIL_EDGES_MAX} premières arêtes sont conservées.`);
  }
  const out: Json[] = [];
  for (const e of raw.slice(0, GUARDRAIL_EDGES_MAX)) {
    if (!isPlainObject(e)) continue;
    const edge: Json = {};
    const to = own(e, 'to');
    edge.to = typeof to === 'string' ? clean(to, GUARDRAIL_STEP_KEY_MAX, true) : '';
    const label = cleanText(own(e, 'label'), GUARDRAIL_LABEL_MAX, st);
    if (label) edge.label = label;
    const condition = cleanCondition(own(e, 'condition'), stepKey, st);
    if (condition) edge.condition = condition;
    if (own(e, 'isDefault') === true) edge.isDefault = true;
    out.push(edge);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Configuration d'étape
// ---------------------------------------------------------------------------

function cleanKeyedList(raw: unknown, st: State): Json[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Json[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, GUARDRAIL_ARRAY_MAX)) {
    const key = typeof entry === 'string' ? entry : isPlainObject(entry) ? own(entry, 'key') : undefined;
    if (typeof key !== 'string') continue;
    const k = sanitizeText(key).trim();
    if (!CONFIG_FIELD_KEY.test(k) || FORBIDDEN_SEGMENTS.has(k) || seen.has(k)) continue;
    seen.add(k);
    const item: Json = { key: k };
    if (isPlainObject(entry) && own(entry, 'required') === true) item.required = true;
    out.push(item);
  }
  if (raw.length > GUARDRAIL_ARRAY_MAX) st.removed.configKeys++;
  return out;
}

function cleanChoices(raw: unknown, st: State): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const c of raw.slice(0, GUARDRAIL_ARRAY_MAX)) {
    const s = cleanText(c, CHOICE_MAX, st);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function cleanConfig(raw: unknown, st: State): Json | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    st.removed.configKeys++;
    return undefined;
  }
  const out: Json = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    switch (key) {
      case 'priority':
        if (v === 0 || v === 1 || v === 2) out.priority = v;
        else if (typeof v === 'string' && PRIORITY_WORDS.has(v.trim().toLowerCase())) out.priority = v.trim().toLowerCase();
        else st.removed.configKeys++;
        break;
      case 'maxAttempts':
        if (typeof v === 'number' && Number.isInteger(v)) out.maxAttempts = Math.min(100, Math.max(1, v));
        else st.removed.configKeys++;
        break;
      case 'fields':
      case 'items': {
        const list = cleanKeyedList(v, st);
        if (list) out[key] = list;
        else st.removed.configKeys++;
        break;
      }
      case 'choices': {
        const list = cleanChoices(v, st);
        if (list) out.choices = list;
        else st.removed.configKeys++;
        break;
      }
      case 'manual':
        if (typeof v === 'boolean') out.manual = v;
        else st.removed.configKeys++;
        break;
      case 'escalation':
        // L'escalade exige un destinataire désigné par identifiant : jamais inventée par le générateur.
        st.removed.configKeys++;
        if (isPlainObject(v) && own(v, 'assignee') !== undefined) st.removed.assignees++;
        st.escalationRemoved = true;
        break;
      default:
        // Toute autre clé, dont un marqueur `authoring` forgé par le modèle.
        if (key === 'isLowRisk' || key === 'lowRisk' || key === 'autonomy') {
          st.removed.autonomy++;
        }
        st.removed.configKeys++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Étape agent
// ---------------------------------------------------------------------------

function cleanAgent(raw: unknown, stepKey: string, st: State): Json | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) return undefined; // l'étape agent sans spécification échoue à la validation
  // `autonomy` est une clé légitime ici (traitée plus bas) ; les marquages de faible risque ne le sont pas.
  if (AGENT_LOW_RISK_KEYS.some((k) => hasOwn(raw, k))) st.removed.autonomy++;

  const objective = cleanText(own(raw, 'objective'), GUARDRAIL_OBJECTIVE_MAX, st, false);

  const tools: string[] = [];
  const rawTools = own(raw, 'tools');
  const list = Array.isArray(rawTools) ? rawTools.slice(0, GUARDRAIL_TOOLS_MAX) : [];
  for (const t of list) {
    const key = typeof t === 'string' ? sanitizeText(t).trim() : '';
    if (key && st.allowed.has(key)) {
      if (!tools.includes(key)) tools.push(key);
      continue;
    }
    st.removed.tools++;
    st.toolNotes++;
    if (st.toolNotes <= TOOL_NOTES_MAX) {
      st.notes.push(`Étape « ${stepKey} » : outil « ${noteName(t)} » retiré, il n’est pas dans le catalogue des outils actifs.`);
    }
  }
  if (Array.isArray(rawTools) && rawTools.length > GUARDRAIL_TOOLS_MAX) {
    st.removed.tools += rawTools.length - GUARDRAIL_TOOLS_MAX;
  }
  if (tools.length > 0) st.keptTools = true;

  const autonomy = own(raw, 'autonomy');
  if (autonomy !== undefined && autonomy !== 'suggere') st.removed.autonomy++;

  const rawThreshold = own(raw, 'confidenceThreshold');
  let threshold = AUTHORING_MIN_CONFIDENCE;
  if (typeof rawThreshold === 'number' && Number.isFinite(rawThreshold)) {
    threshold = Math.max(AUTHORING_MIN_CONFIDENCE, Math.min(1, rawThreshold));
    if (rawThreshold < AUTHORING_MIN_CONFIDENCE) st.thresholdRaised = true;
  }

  const out: Json = {
    objective: objective && objective.length > 0 ? objective : GUARDRAIL_EMPTY_OBJECTIVE,
    tools,
    confidenceThreshold: threshold,
    autonomy: 'suggere',
  };
  const maxSteps = own(raw, 'maxSteps');
  if (typeof maxSteps === 'number' && Number.isInteger(maxSteps) && maxSteps > 0) {
    out.maxSteps = Math.min(GUARDRAIL_AGENT_MAX_STEPS, maxSteps);
  }
  // `model` et `maxCostPerRun` : jamais repris (choix réservés à l'administration).
  return out;
}

// ---------------------------------------------------------------------------
// Étape
// ---------------------------------------------------------------------------

function cleanStep(raw: Json, st: State): Json {
  detectLowRisk(raw, st);
  const step: Json = {};

  const rawKey = own(raw, 'key');
  const key = typeof rawKey === 'string' ? clean(rawKey, GUARDRAIL_STEP_KEY_MAX, true) : '';
  step.key = key;
  const name = cleanText(own(raw, 'name'), GUARDRAIL_NAME_MAX, st) ?? '';
  step.name = name;
  const rawType = own(raw, 'type');
  // Un type inconnu est laissé tel quel (nettoyé) : la validation échoue et déclenche la réparation.
  step.type = typeof rawType === 'string' ? clean(rawType, TYPE_MAX, true) : '';
  const type = step.type as string;

  let description = cleanText(own(raw, 'description'), GUARDRAIL_DESCRIPTION_MAX, st, false);

  // --- Affectation : aucun identifiant n'est jamais repris.
  const rawAssignee = own(raw, 'assignee');
  let keptAssignee: Json | undefined;
  let assigneeRemoved = false;
  if (rawAssignee !== undefined) {
    const kind = isPlainObject(rawAssignee) ? own(rawAssignee, 'kind') : undefined;
    if (typeof kind === 'string' && KEPT_ASSIGNEE_KINDS.has(kind)) {
      keptAssignee = { kind };
      if (isPlainObject(rawAssignee) && own(rawAssignee, 'id') !== undefined) st.removed.assignees++;
    } else {
      assigneeRemoved = true;
      st.removed.assignees++;
    }
  }
  let hint: string | null = null;
  let hintGiven = false;
  const rawHint = own(raw, 'assigneeHint');
  if (typeof rawHint === 'string' && rawHint.trim().length > 0) {
    hintGiven = true;
    // Un libellé suspect n'est pas repris (le marqueur reste posé, sans libellé).
    if (detectInjection(rawHint).suspicious) st.removed.suspiciousText++;
    else hint = clean(rawHint, GUARDRAIL_HINT_MAX, true) || null;
  }

  for (const k of ['dueInHours', 'reminderAfterHours'] as const) {
    const v = own(raw, k);
    if (typeof v === 'number' && Number.isFinite(v)) step[k] = v;
  }

  const config = cleanConfig(own(raw, 'config'), st) ?? {};

  const agent = cleanAgent(own(raw, 'agent'), key || '?', st);
  if (agent) step.agent = agent;

  const isHuman = HUMAN_TYPES.has(type) || (type === 'decision' && config.manual === true);
  if (keptAssignee) step.assignee = keptAssignee;
  else if (isHuman && (assigneeRemoved || hintGiven)) {
    config[WF_AUTHORING_MARKER_KEY] = { toComplete: ['assignee'], assigneeHint: hint };
    const prefix = hint ? `${GUARDRAIL_ASSIGNEE_PREFIX} (${hint}).` : `${GUARDRAIL_ASSIGNEE_PREFIX}.`;
    if (!description || !description.startsWith(GUARDRAIL_ASSIGNEE_PREFIX)) {
      description = description ? `${prefix} ${description}` : prefix;
    }
    st.toComplete.push({ stepKey: key, stepName: name, what: 'assignee', hint });
  }
  if (description !== undefined && description.length > 0) step.description = description;
  if (Object.keys(config).length > 0) step.config = config;

  step.next = cleanEdges(own(raw, 'next'), key || '?', st);
  return step;
}

function emptyResult(st: State): GuardrailResult {
  return {
    graph: { schemaVersion: WF_GRAPH_SCHEMA_VERSION, start: '', steps: [] },
    notes: st.notes,
    toComplete: st.toComplete,
    removed: st.removed,
  };
}

/**
 * Nettoie le graphe brut du modèle. Ne lève jamais ; ne modifie jamais `rawGraph`.
 */
export function applyGuardrails(rawGraph: unknown, ctx: GuardrailContext): GuardrailResult {
  const st: State = {
    allowed: typeof ctx?.allowedTools?.has === 'function' ? ctx.allowedTools : new Set<string>(),
    notes: [],
    toComplete: [],
    removed: { tools: 0, autonomy: 0, assignees: 0, configKeys: 0, suspiciousText: 0 },
    toolNotes: 0,
    conditionNotes: 0,
    thresholdRaised: false,
    keptTools: false,
    escalationRemoved: false,
    skippedSteps: 0,
  };

  let copy: unknown;
  try {
    copy = structuredClone(rawGraph);
  } catch {
    return emptyResult(st);
  }
  if (!isPlainObject(copy)) return emptyResult(st);

  try {
    detectLowRisk(copy, st);
    const rawStart = own(copy, 'start');
    const start = typeof rawStart === 'string' ? clean(rawStart, GUARDRAIL_STEP_KEY_MAX, true) : '';

    const rawSteps = own(copy, 'steps');
    const list = Array.isArray(rawSteps) ? rawSteps : [];
    if (list.length > AUTHORING_MAX_STEPS) {
      st.notes.push(
        `Le brouillon proposait ${list.length} étapes : seules les ${AUTHORING_MAX_STEPS} premières sont conservées, à relire.`,
      );
    }
    const steps: Json[] = [];
    for (const s of list.slice(0, AUTHORING_MAX_STEPS)) {
      if (!isPlainObject(s)) {
        st.skippedSteps++;
        continue;
      }
      steps.push(cleanStep(s, st));
    }

    if (st.skippedSteps > 0) st.notes.push(`${st.skippedSteps} étape(s) mal formée(s) ignorée(s).`);
    if (st.toolNotes > TOOL_NOTES_MAX) st.notes.push(`${st.toolNotes - TOOL_NOTES_MAX} autre(s) outil(s) retiré(s).`);
    if (st.conditionNotes > CONDITION_NOTES_MAX) {
      st.notes.push(`${st.conditionNotes - CONDITION_NOTES_MAX} autre(s) condition(s) retirée(s).`);
    }
    if (st.keptTools) {
      st.notes.push('Les outils retenus doivent être autorisés pour ce workflow (Administration) avant publication.');
    }
    if (st.removed.autonomy > 0) {
      st.notes.push(
        'Autonomie ramenée à « suggère » : le générateur ne peut ni rendre un agent autonome ni marquer le workflow à faible risque.',
      );
    }
    if (st.thresholdRaised) {
      st.notes.push(`Seuil de confiance des étapes agent relevé au minimum de ${AUTHORING_MIN_CONFIDENCE}.`);
    }
    if (st.removed.assignees > 0) {
      st.notes.push(
        `${st.removed.assignees} affectation(s) par identifiant retirée(s) : aucun utilisateur, groupe ou rôle n’est choisi par le générateur.`,
      );
    }
    if (st.escalationRemoved) {
      st.notes.push('Escalade retirée : elle exige un destinataire désigné, à configurer dans l’éditeur.');
    }
    if (st.removed.suspiciousText > 0) {
      st.notes.push(
        `${st.removed.suspiciousText} texte(s) retiré(s) du brouillon : ils ressemblaient à une consigne détournée.`,
      );
    }

    return {
      graph: { schemaVersion: WF_GRAPH_SCHEMA_VERSION, start, steps },
      notes: st.notes,
      toComplete: st.toComplete,
      removed: st.removed,
    };
  } catch {
    return emptyResult(st);
  }
}
