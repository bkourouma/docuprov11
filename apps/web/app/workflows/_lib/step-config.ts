// Docu-Flow — lecture/écriture TOLÉRANTES de `step.config` (record libre côté graphe).
// Règles : jamais d'écrasement des clés inconnues, jamais de mutation de l'entrée, un objet vide devient `undefined`
// (le graphe publié ne garde pas de `config: {}` inutile).
import { wfEscalationConfigSchema, type WfEscalationConfig } from '@archivage/types';

export type StepConfig = Record<string, unknown> | undefined;

export interface ConfigListItem {
  key: string;
  label?: string;
  required: boolean;
}

export type PriorityValue = 0 | 1 | 2;

export const STEP_KEY_RE = /^[a-z][a-z0-9_]*$/;
export const HOURS_MIN = 1;
export const HOURS_MAX = 8760;
export const MAX_ATTEMPTS_MIN = 1;
export const MAX_ATTEMPTS_MAX = 100;

// ---------------------------------------------------------------------------
// Écriture générique
// ---------------------------------------------------------------------------

/** Copie de `config` avec `name` posé (ou retiré si `value` est `undefined`). Objet vide => `undefined`. */
function setEntry(config: StepConfig, name: string, value: unknown): StepConfig {
  const next: Record<string, unknown> = { ...(config ?? {}) };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return Object.keys(next).length === 0 ? undefined : next;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Champs de formulaire / éléments de checklist
// ---------------------------------------------------------------------------

function readList(raw: unknown): ConfigListItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigListItem[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') out.push({ key: entry, required: false });
    } else if (isRecord(entry) && typeof entry.key === 'string' && entry.key !== '') {
      const item: ConfigListItem = { key: entry.key, required: entry.required === true };
      if (typeof entry.label === 'string' && entry.label !== '') item.label = entry.label;
      out.push(item);
    }
  }
  return out;
}

function writeList(config: StepConfig, name: string, list: readonly ConfigListItem[]): StepConfig {
  if (list.length === 0) return setEntry(config, name, undefined);
  const serial = list.map((it) => {
    const o: Record<string, unknown> = { key: it.key };
    if (it.label !== undefined && it.label.trim() !== '') o.label = it.label;
    if (it.required) o.required = true;
    return o;
  });
  return setEntry(config, name, serial);
}

export const readFields = (config: StepConfig): ConfigListItem[] => readList(config?.fields);
export const writeFields = (config: StepConfig, list: readonly ConfigListItem[]): StepConfig =>
  writeList(config, 'fields', list);
export const readItems = (config: StepConfig): ConfigListItem[] => readList(config?.items);
export const writeItems = (config: StepConfig, list: readonly ConfigListItem[]): StepConfig =>
  writeList(config, 'items', list);

/** Message d'erreur FR si la clé de champ est refusée, sinon null. `others` = les AUTRES clés de la liste. */
export function validateFieldKey(key: string, others: readonly string[]): string | null {
  if (key.trim() === '') return 'La clé est obligatoire.';
  if (key.length > 100) return 'La clé ne peut pas dépasser 100 caractères.';
  if (!STEP_KEY_RE.test(key)) {
    return 'Clé invalide : minuscules, chiffres et _, en commençant par une lettre.';
  }
  if (others.includes(key)) return 'Cette clé est déjà utilisée dans la liste.';
  return null;
}

// ---------------------------------------------------------------------------
// Décision manuelle
// ---------------------------------------------------------------------------

export function readChoices(config: StepConfig): string[] {
  const raw = config?.choices;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
}
export function writeChoices(config: StepConfig, choices: readonly string[]): StepConfig {
  const clean = choices.filter((c) => c.trim() !== '');
  return setEntry(config, 'choices', clean.length === 0 ? undefined : clean);
}

export const readManual = (config: StepConfig): boolean => config?.manual === true;
export const writeManual = (config: StepConfig, manual: boolean): StepConfig =>
  setEntry(config, 'manual', manual ? true : undefined);

// ---------------------------------------------------------------------------
// Priorité, passages maximum
// ---------------------------------------------------------------------------

const PRIORITY_WORDS: Record<string, PriorityValue> = { basse: 0, normale: 1, haute: 2 };

export function readPriority(config: StepConfig): PriorityValue | undefined {
  const raw = config?.priority;
  if (raw === 0 || raw === 1 || raw === 2) return raw;
  if (typeof raw === 'string') return PRIORITY_WORDS[raw.trim().toLowerCase()];
  return undefined;
}
export const writePriority = (config: StepConfig, priority: PriorityValue | undefined): StepConfig =>
  setEntry(config, 'priority', priority);

export function readMaxAttempts(config: StepConfig): number | undefined {
  const raw = config?.maxAttempts;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= MAX_ATTEMPTS_MIN && raw <= MAX_ATTEMPTS_MAX
    ? raw
    : undefined;
}
/** Valeur hors 1..100 ou non entière : le champ est retiré (jamais d'écriture d'une valeur refusée). */
export function writeMaxAttempts(config: StepConfig, value: number | undefined): StepConfig {
  const ok =
    typeof value === 'number' && Number.isInteger(value) && value >= MAX_ATTEMPTS_MIN && value <= MAX_ATTEMPTS_MAX;
  return setEntry(config, 'maxAttempts', ok ? value : undefined);
}

// ---------------------------------------------------------------------------
// Escalade
// ---------------------------------------------------------------------------

export function readEscalation(config: StepConfig): WfEscalationConfig | undefined {
  if (config?.escalation === undefined) return undefined;
  const parsed = wfEscalationConfigSchema.safeParse(config.escalation);
  return parsed.success ? parsed.data : undefined;
}
export const writeEscalation = (config: StepConfig, escalation: WfEscalationConfig | undefined): StepConfig =>
  setEntry(config, 'escalation', escalation);

/** Vrai si `hours` est un entier dans 1..8760 (échéance, relance, délai d'escalade). */
export function isValidHours(hours: unknown): hours is number {
  return typeof hours === 'number' && Number.isInteger(hours) && hours >= HOURS_MIN && hours <= HOURS_MAX;
}

// ---------------------------------------------------------------------------
// Valeur d'une condition d'arête
// ---------------------------------------------------------------------------

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const QUOTED_RE = /^"(.*)"$/s;

/** Interprète un texte saisi : true/false/null/nombre, sinon texte. Des guillemets forcent le texte (`"true"`). */
function parseScalar(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (NUMBER_RE.test(t)) return Number(t);
  const quoted = QUOTED_RE.exec(t);
  if (quoted) return quoted[1];
  return t;
}

/**
 * Texte saisi -> valeur de condition. `in` : liste séparée par des virgules (éléments vides ignorés).
 * `exists` : aucune valeur. Une saisie vide donne explicitement la chaîne vide (comparaison à « rien »).
 */
export function parseConditionValue(text: string, op: string): unknown {
  if (op === 'exists') return undefined;
  if (op === 'in') {
    return text
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map(parseScalar);
  }
  return parseScalar(text);
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') {
    // Une chaîne qui serait relue comme autre chose est protégée par des guillemets.
    const ambiguous =
      value === 'true' || value === 'false' || value === 'null' || NUMBER_RE.test(value) || QUOTED_RE.test(value);
    return ambiguous ? `"${value}"` : value;
  }
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === undefined) return '';
  return JSON.stringify(value);
}

/** Valeur de condition -> texte affichable (inverse de `parseConditionValue`). */
export function formatConditionValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatScalar).join(', ');
  return formatScalar(value);
}
