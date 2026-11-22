import { isWfTriggerEventType, type WfAuthoringTriggerSuggestion, type WfTriggerEventType } from '@archivage/types';
import { sanitizeText, replaceAngles, truncateSafe } from '../workflow-agents/injection/untrusted';
import { WF_EVENT_CATALOG } from '../workflow-triggers/domain/event-catalog';
import { parseTriggerConditions } from '../workflow-triggers/domain/conditions';
import type { SuggestTriggerInput } from './authoring.contracts';
import { findMoneyAmounts, parseFrenchNumber } from './authoring.assumptions';

// Docu-Flow W5 — suggestion de déclencheur (fonction pure). La suggestion n'est JAMAIS créée : c'est une proposition.
// Règles : jamais d'identifiant de référentiel inventé (métadonnée, nature, type de document…), conditions toujours
// revalidées par `parseTriggerConditions` (catalogue fermé), aucun texte du modèle recopié hors `reason` nettoyé.

export const TRIGGER_REASON_MAX = 300;
const DESCRIPTION_SCAN_MAX = 8000;
const MAX_MATCH_CONDITIONS = 20;
const MAX_LEAD_HOURS = 8760;
const THRESHOLD_ABS_MAX = 1_000_000_000_000;

const REASONS: Record<WfTriggerEventType, string> = {
  'mail.arrived': "La description évoque l'arrivée d'un courrier.",
  'document.deposited': "La description évoque le dépôt d'un document.",
  'deadline.reached': "La description évoque l'approche ou le dépassement d'une échéance.",
  'threshold.crossed': "La description évoque le dépassement d'un seuil sur un document.",
};

const REASON_FROM_HINT = 'Le déclencheur indiqué dans la demande a été retenu.';

/** Champs de référentiel (identifiants) : on ne les invente jamais, l'utilisateur les choisit. */
function isReferenceField(name: string): boolean {
  return /Id$/.test(name) || name === 'createdBy';
}

// ---------------------------------------------------------------------------
// Détection déterministe par mots-clés
// ---------------------------------------------------------------------------

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`´]/g, "'");
}

const CONJ = String.raw`(?:quand|lorsque|lorsqu'|des\s+que|des\s+qu'|chaque\s+fois\s+que|a\s+chaque\s+fois\s+que)`;
const ARRIVAL_WORDS = String.raw`(?:arrive|arrivent|depose|deposee|recu|recue|ajoute|enregistre)`;
// Intervalle sans ponctuation forte ni verbe d'arrivée : un « quand une facture arrive, si le montant dépasse »
// reste un dépôt de document, pas un franchissement de seuil.
const GAP = String.raw`(?:(?!\b${ARRIVAL_WORDS}\b)[^.;,\n]){0,60}?`;

interface Pattern {
  re: RegExp;
  weight: number;
}

const PATTERNS: Record<WfTriggerEventType, Pattern[]> = {
  'mail.arrived': [
    {
      re: /\bcourriers?\b[^.;\n]{0,25}?\b(?:arrive|arrivent|arrivees?|recus?|recues?|enregistres?|enregistrees?|parvient|parviennent|parvenus?|parvenues?)\b/,
      weight: 3,
    },
    {
      re: /\b(?:reception|arrivee|enregistrement)\s+(?:d'|de\s+|du\s+|des\s+)?(?:un\s+|une\s+|le\s+|ce\s+)?courriers?\b/,
      weight: 3,
    },
    { re: new RegExp(String.raw`\b${CONJ}\s*(?:un|une|le|ce|des)?\s*courriers?\b`), weight: 3 },
    { re: /\bcourriers?\s+entrants?\b/, weight: 3 },
  ],
  'document.deposited': [
    {
      re: /\b(?:documents?|factures?)\b[^.;\n]{0,30}?\b(?:depose[es]?|ajoute[es]?|televerse[es]?|importe[es]?|numerise[es]?|scanne[es]?|arrive|arrivent|arrivee|arrivees|recu|recue|recus|recues)\b/,
      weight: 3,
    },
    {
      re: /\b(?:depot|ajout|numerisation|import|televersement)\s+(?:d'|de\s+|du\s+)?(?:un\s+|une\s+|le\s+)?(?:nouveau\s+|nouvelle\s+)?(?:documents?|factures?|pieces?|justificatifs?)\b/,
      weight: 3,
    },
    {
      re: new RegExp(
        String.raw`\b${CONJ}\s*(?:un|une|le|la|ce)?\s*(?:nouveau\s+|nouvelle\s+)?pieces?\b[^.;\n]{0,20}?\b(?:depose[es]?|ajoute[es]?|arrive|recu[es]?)\b`,
      ),
      weight: 3,
    },
  ],
  'deadline.reached': [
    { re: /\b(?:arrive|arrivent|arrivee|arrivees)\s+a\s+echeance\b/, weight: 3 },
    { re: /\ba\s+l'approche\s+(?:de\s+l'|de\s+la\s+|des\s+|du\s+)?(?:echeance|date\s+butoir)/, weight: 3 },
    { re: /\bapproche\s+de\s+l'echeance/, weight: 3 },
    { re: /\bdelais?\b[^.;\n]{0,15}?\b(?:depasse|depasses|expire|expires|echu|echus)\b/, weight: 3 },
    { re: /\b(?:echeance|date\s+butoir)\s+(?:est\s+|sont\s+)?(?:atteinte|depassee|arrivee|echue|proche)\b/, weight: 3 },
    { re: /\b(?:dossiers?|courriers?|documents?)\s+echus?\b/, weight: 3 },
  ],
  'threshold.crossed': [
    {
      re: new RegExp(
        String.raw`\b${CONJ}\s*${GAP}\b(?:montant|valeur|total|somme|metadonnee|champ)\b[^.;,\n]{0,50}?\b(?:depasse|depassent|excede|excedent|superieure?|au[- ]dessus|atteint|franchit)`,
      ),
      weight: 4,
    },
    { re: /\bdepassement\s+(?:du\s+|d'un\s+|de\s+|le\s+)?seuil/, weight: 3 },
    { re: /\b(?:depasse|excede|franchit|franchissement)\s+(?:du\s+|le\s+|un\s+|ce\s+)?seuil/, weight: 3 },
    { re: /\bseuil\b[^.;\n]{0,30}?\b(?:depasse|franchi|atteint)\b/, weight: 3 },
  ],
};

const EVENT_ORDER: readonly WfTriggerEventType[] = [
  'threshold.crossed',
  'document.deposited',
  'mail.arrived',
  'deadline.reached',
];

/**
 * Événement évoqué par la description, ou `null`. Chaque événement marque des points avec ses tournures
 * d'amorce (le plus fort l'emporte) ; à égalité, la tournure la plus tôt dans le texte décide
 * (« quand un courrier arrive avec une facture » donne le courrier). Un simple mot (« courrier », « seuil »,
 * « échéance ») sans verbe d'événement ne suffit jamais : un workflow lancé à la main n'a pas de déclencheur.
 */
export function detectTriggerEvent(description: string): WfTriggerEventType | null {
  if (typeof description !== 'string') return null;
  const text = fold(sanitizeText(description, DESCRIPTION_SCAN_MAX));
  let best: { event: WfTriggerEventType; score: number; index: number } | null = null;
  for (const event of EVENT_ORDER) {
    let score = 0;
    let index = Number.POSITIVE_INFINITY;
    for (const p of PATTERNS[event]) {
      const m = p.re.exec(text);
      if (!m) continue;
      score = Math.max(score, p.weight);
      index = Math.min(index, m.index);
    }
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && index < best.index)) {
      best = { event, score, index };
    }
  }
  return best ? best.event : null;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function readLeadHoursFromDescription(folded: string): number | null {
  const m = /(\d{1,4})\s*(jours?|heures?|semaines?)\s+avant\s+(?:l'|la\s+|le\s+)?(?:echeance|date\s+butoir)/.exec(folded);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? '';
  const hours = unit.startsWith('jour') ? n * 24 : unit.startsWith('semaine') ? n * 168 : n;
  return hours >= 0 && hours <= MAX_LEAD_HOURS ? hours : null;
}

function readThresholdValueFromDescription(description: string, folded: string): number | null {
  const money = findMoneyAmounts(description)[0];
  if (money && Math.abs(money.value) <= THRESHOLD_ABS_MAX) return money.value;
  const m =
    /(?:seuil\s+(?:de\s+)?|depasse\w*\s+|superieur\w*\s+a\s+|au[- ]dessus\s+de\s+|plus\s+de\s+|atteint\s+)(\d{1,3}(?:[ .]\d{3})+|\d+)(?!\d|,\d)/.exec(
      folded,
    );
  if (!m) return null;
  const n = parseFrenchNumber(m[1] ?? '');
  return n !== null && Number.isInteger(n) && Math.abs(n) <= THRESHOLD_ABS_MAX ? n : null;
}

interface BuiltConditions {
  conditions: Record<string, unknown>;
  incomplete: string[];
}

function buildConditions(event: WfTriggerEventType, rawModel: unknown, description: string): BuiltConditions {
  const spec = WF_EVENT_CATALOG[event];
  const incomplete: string[] = [];
  const folded = fold(sanitizeText(description, DESCRIPTION_SCAN_MAX));
  const raw = isPlainRecord(rawModel) ? rawModel : {};
  const probeThreshold = event === 'threshold.crossed' ? { metaDataId: 1, op: 'gt', value: 0 } : undefined;

  // 1) Conditions `match` : champs du catalogue, jamais d'identifiant de référentiel.
  const match: unknown[] = [];
  let ignored = 0;
  const items = Array.isArray(raw.match) ? raw.match.slice(0, MAX_MATCH_CONDITIONS) : [];
  if (Array.isArray(raw.match) && raw.match.length > MAX_MATCH_CONDITIONS) {
    ignored += raw.match.length - MAX_MATCH_CONDITIONS;
  }
  for (const item of items) {
    if (!isPlainRecord(item) || typeof item.field !== 'string' || !item.field.startsWith('subject.')) {
      ignored++;
      continue;
    }
    const name = item.field.slice('subject.'.length);
    if (!/^[A-Za-z][A-Za-z0-9]{0,60}$/.test(name) || !hasOwn(spec.fields, name)) {
      ignored++;
      continue;
    }
    if (isReferenceField(name)) {
      const line = `subject.${name} : à choisir`;
      if (!incomplete.includes(line)) incomplete.push(line);
      continue;
    }
    const probe: Record<string, unknown> = { match: [item] };
    if (probeThreshold) probe.threshold = probeThreshold;
    const parsed = parseTriggerConditions(event, probe);
    if (parsed.ok && parsed.value.match[0]) match.push(parsed.value.match[0]);
    else ignored++;
  }
  if (ignored > 0) {
    incomplete.push(
      ignored === 1
        ? 'Une condition proposée ne respecte pas le catalogue : elle a été ignorée.'
        : `${ignored} conditions proposées ne respectent pas le catalogue : elles ont été ignorées.`,
    );
  }

  const out: Record<string, unknown> = {};
  if (match.length > 0) out.match = match;
  const probeAll: Record<string, unknown> = { match: [...match] };

  // 2) Échéance : délai d'anticipation entier de 0 à 8760 heures.
  if (event === 'deadline.reached') {
    const modelLead = isPlainRecord(raw.deadline) ? raw.deadline.leadHours : undefined;
    const lead =
      typeof modelLead === 'number' && Number.isInteger(modelLead) && modelLead >= 0 && modelLead <= MAX_LEAD_HOURS
        ? modelLead
        : (readLeadHoursFromDescription(folded) ?? 0);
    out.deadline = { leadHours: lead };
    probeAll.deadline = { leadHours: lead };
  }

  // 3) Seuil : la métadonnée est un identifiant de référentiel, jamais inventé ni repris du modèle.
  if (event === 'threshold.crossed') {
    const t = isPlainRecord(raw.threshold) ? raw.threshold : {};
    const op: 'gt' | 'gte' =
      t.op === 'gt' || t.op === 'gte'
        ? t.op
        : /\b(?:atteint|atteignent|au\s+moins|egal\w*\s+ou\s+superieur\w*|superieur\w*\s+ou\s+egal\w*)\b/.test(folded)
          ? 'gte'
          : 'gt';
    let value: number | null = null;
    if (typeof t.value === 'number' && Number.isFinite(t.value) && Math.abs(t.value) <= THRESHOLD_ABS_MAX) {
      value = Math.round(t.value);
    } else {
      value = readThresholdValueFromDescription(description, folded);
    }
    const threshold: Record<string, unknown> = { op };
    if (value !== null) threshold.value = value;
    out.threshold = threshold;
    probeAll.threshold = { metaDataId: 1, op, value: value ?? 0 };
    incomplete.push('threshold.metaDataId : à choisir');
    if (value === null) incomplete.push('threshold.value : à renseigner');
  }

  // 4) Dernière barrière : le catalogue a le dernier mot.
  const final = parseTriggerConditions(event, probeAll);
  if (!final.ok) {
    incomplete.push('Les conditions proposées ne respectent pas le catalogue : elles ont été écartées.');
    const fallback: Record<string, unknown> = {};
    if (event === 'deadline.reached') fallback.deadline = { leadHours: 0 };
    if (event === 'threshold.crossed') fallback.threshold = { op: 'gt' };
    return { conditions: fallback, incomplete };
  }
  return { conditions: out, incomplete };
}

// ---------------------------------------------------------------------------
// Suggestion
// ---------------------------------------------------------------------------

function cleanReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  return truncateSafe(replaceAngles(sanitizeText(value)).replace(/\s+/g, ' ').trim(), TRIGGER_REASON_MAX);
}

/**
 * Propose un déclencheur (jamais créé). Ordre : indice explicite, événement du modèle s'il est au catalogue,
 * puis détection par mots-clés. `null` si rien n'évoque d'événement.
 */
export function suggestTrigger(input: SuggestTriggerInput): WfAuthoringTriggerSuggestion | null {
  const description = typeof input.description === 'string' ? input.description : '';
  const modelEvent = input.modelTrigger?.eventType;

  let event: WfTriggerEventType | null = null;
  let origin: 'hint' | 'model' | 'description' = 'description';
  if (isWfTriggerEventType(input.triggerHint)) {
    event = input.triggerHint;
    origin = 'hint';
  } else if (isWfTriggerEventType(modelEvent)) {
    event = modelEvent;
    origin = 'model';
  } else {
    event = detectTriggerEvent(description);
  }
  if (!event) return null;

  // Les conditions du modèle n'ont de sens que pour l'événement qu'il a lui-même choisi.
  const rawConditions = modelEvent === event ? input.modelTrigger?.conditions : undefined;
  const { conditions, incomplete } = buildConditions(event, rawConditions, description);

  const modelReason = modelEvent === event ? cleanReason(input.modelTrigger?.reason) : '';
  const reason = modelReason || (origin === 'hint' ? REASON_FROM_HINT : REASONS[event]);

  return {
    eventType: event,
    label: WF_EVENT_CATALOG[event].label,
    conditions,
    reason,
    incomplete,
  };
}
