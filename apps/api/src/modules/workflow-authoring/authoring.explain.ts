import {
  WF_AUTHORING_MARKER_KEY,
  type WfAuthoringExplanation,
  type WfAuthoringToDoItem,
  type WfEdge,
  type WfGraph,
  type WfStep,
} from '@archivage/types';
import { sanitizeText, replaceAngles, truncateSafe } from '../workflow-agents/injection/untrusted';
import { formatFrenchInteger } from './authoring.assumptions';

// Docu-Flow W5 — explication DÉTERMINISTE d'un graphe en français (texte brut). Aucune IA, aucune E/S, aucun HTML.
// Parcours itératif (largeur pour l'ordre du récit, profondeur pour repérer les retours), protégé contre les
// cycles et borné à 200 étapes.

export const EXPLAIN_MAX_STEPS = 200;
const NAME_MAX = 120;
const TEXT_MAX = 300;
const HINT_MAX = 100;

type Meta = { definitionId: number; versionNumber: number; name: string };

function clean(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  return truncateSafe(replaceAngles(sanitizeText(text)).replace(/\s+/g, ' ').trim(), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const q = (text: string): string => `« ${text} »`;

function stepLabel(step: WfStep): string {
  return q(clean(step.name, NAME_MAX) || step.key);
}

// ---------------------------------------------------------------------------
// Marqueurs « à compléter » (config.authoring.toComplete)
// ---------------------------------------------------------------------------

/** Lit le marqueur posé par les garde-fous ; renvoie `null` si l'étape n'est pas à compléter. */
function readToDo(step: WfStep): WfAuthoringToDoItem | null {
  const marker = isRecord(step.config) ? step.config[WF_AUTHORING_MARKER_KEY] : undefined;
  if (!isRecord(marker)) return null;
  const list = marker.toComplete;
  const entries: unknown[] = Array.isArray(list) ? list : list === undefined ? [] : [list];
  let pending = false;
  let hint: string | null = null;
  for (const e of entries) {
    if (e === 'assignee' || e === true || (isRecord(e) && (e.what === 'assignee' || e.what === undefined))) {
      pending = true;
      if (isRecord(e) && typeof e.hint === 'string') hint = clean(e.hint, HINT_MAX) || null;
    }
  }
  if (!pending) return null;
  if (hint === null && typeof marker.assigneeHint === 'string') hint = clean(marker.assigneeHint, HINT_MAX) || null;
  return { stepKey: step.key, stepName: clean(step.name, NAME_MAX) || step.key, what: 'assignee', hint };
}

// ---------------------------------------------------------------------------
// Conditions en langage clair
// ---------------------------------------------------------------------------

// Noms courants féminins (premier mot du champ, sans accent) : accord de « le/la » et des adjectifs.
const FEMININE_WORDS: ReadonlySet<string> = new Set([
  'date', 'valeur', 'somme', 'duree', 'nature', 'reference', 'categorie', 'priorite', 'urgence', 'quantite',
  'note', 'piece', 'facture', 'decision', 'validation', 'signature', 'echeance', 'adresse', 'devise', 'remise',
  'taxe', 'tva', 'version', 'localisation', 'entite', 'direction', 'unite', 'qualite', 'periode', 'reponse',
  'demande', 'commande', 'situation', 'classe', 'region', 'ville', 'fonction', 'structure', 'longueur', 'distance',
  'confiance', 'conformite', 'taille', 'confidentialite',
]);

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Sujet d'une condition (« le montant », « la date »…) et son genre. */
function humanizeField(path: string): { text: string; fem: boolean } {
  const segments = path.split('.').filter((s) => s.length > 0 && s !== 'values' && !/^\d+$/.test(s));
  const last = segments[segments.length - 1] ?? path;
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
  const label = clean(words, 60) || 'valeur';
  const fem = FEMININE_WORDS.has(fold(label.split(' ')[0] ?? ''));
  const vowel = /^[aeiouyàâéèêîôûh]/i.test(label);
  return { text: vowel ? `l'${label}` : `${fem ? 'la' : 'le'} ${label}`, fem };
}

function formatValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? formatFrenchInteger(value) : String(value).replace('.', ',');
  }
  if (typeof value === 'boolean') return value ? 'oui' : 'non';
  if (typeof value === 'string') return q(clean(value, 60));
  if (Array.isArray(value)) return value.slice(0, 8).map(formatValue).join(', ');
  return '…';
}

/** Tournure de l'opérateur ; `e` est ajouté aux adjectifs pour un sujet féminin. */
function opPhrase(op: string, fem: boolean): string | null {
  const e = fem ? 'e' : '';
  switch (op) {
    case 'eq':
      return 'vaut';
    case 'neq':
      return 'ne vaut pas';
    case 'gt':
      return `est supérieur${e} à`;
    case 'gte':
      return `est supérieur${e} ou égal${e} à`;
    case 'lt':
      return `est inférieur${e} à`;
    case 'lte':
      return `est inférieur${e} ou égal${e} à`;
    case 'in':
      return 'fait partie de';
    default:
      return null;
  }
}

/** « le montant est supérieur à 5 000 000 », « la validation est refusée »… (sans « si »). */
export function describeCondition(condition: NonNullable<WfEdge['condition']>): string {
  const { field, op, value } = condition;
  const last = field.split('.').pop() ?? '';
  if ((last === 'approved' || last === 'rejected') && (op === 'eq' || op === 'neq') && typeof value === 'boolean') {
    const positive = last === 'approved' ? value : !value;
    const accepted = op === 'eq' ? positive : !positive;
    return accepted ? 'la validation est acceptée' : 'la validation est refusée';
  }
  if (last === 'choice' && (op === 'eq' || op === 'neq')) {
    return `le choix ${op === 'eq' ? 'est' : "n'est pas"} ${formatValue(value)}`;
  }
  const { text: subject, fem } = humanizeField(field);
  if (op === 'exists') return `${subject} est renseigné${fem ? 'e' : ''}`;
  const phrase = opPhrase(op, fem);
  if (!phrase) return `${subject} répond à une condition`;
  return `${subject} ${phrase} ${formatValue(value)}`;
}

// ---------------------------------------------------------------------------
// Parcours
// ---------------------------------------------------------------------------

interface Walk {
  order: number[];
  backEdges: Set<string>;
  indexByKey: Map<string, number>;
}

function walk(steps: readonly WfStep[], start: string): Walk {
  const indexByKey = new Map<string, number>();
  steps.forEach((s, i) => {
    if (!indexByKey.has(s.key)) indexByKey.set(s.key, i);
  });

  // Ordre du récit : largeur depuis le départ, puis les étapes non atteintes (déclaration).
  const order: number[] = [];
  const seen = new Uint8Array(steps.length);
  const queue: number[] = [];
  const push = (i: number): void => {
    if (!seen[i]) {
      seen[i] = 1;
      queue.push(i);
    }
  };
  const bfs = (from: number): void => {
    push(from);
    for (let head = order.length; head < queue.length; head++) {
      const i = queue[head] as number;
      order.push(i);
      for (const edge of (steps[i] as WfStep).next) {
        const t = indexByKey.get(edge.to);
        if (t !== undefined) push(t);
      }
    }
  };
  const startIndex = indexByKey.get(start);
  if (startIndex !== undefined) bfs(startIndex);
  steps.forEach((_s, i) => {
    if (!seen[i] && indexByKey.get((steps[i] as WfStep).key) === i) bfs(i);
  });

  // Arêtes de retour (vers une étape encore ouverte du chemin courant) : profondeur itérative à trois couleurs.
  const backEdges = new Set<string>();
  const color = new Uint8Array(steps.length); // 0 neuf, 1 ouvert, 2 fermé
  const dfs = (from: number): void => {
    const stack: Array<{ i: number; e: number }> = [{ i: from, e: 0 }];
    color[from] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { i: number; e: number };
      const edges = (steps[top.i] as WfStep).next;
      if (top.e >= edges.length) {
        color[top.i] = 2;
        stack.pop();
        continue;
      }
      const edge = edges[top.e++] as WfEdge;
      const t = indexByKey.get(edge.to);
      if (t === undefined) continue;
      if (color[t] === 1) backEdges.add(`${top.i}->${t}`);
      else if (color[t] === 0) {
        color[t] = 1;
        stack.push({ i: t, e: 0 });
      }
    }
  };
  if (startIndex !== undefined) dfs(startIndex);
  for (const i of order) if (color[i] === 0) dfs(i);

  return { order, backEdges, indexByKey };
}

// ---------------------------------------------------------------------------
// Phrases par étape
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  rechercher_documents: 'recherche de documents',
  lire_document: "lecture d'un document",
  lire_courrier: "lecture d'un courrier",
  proposer_imputation: "proposition d'imputation",
  proposer_reponse: 'proposition de réponse',
};

function toolsText(tools: readonly string[]): string {
  if (tools.length === 0) return 'sans outil';
  const labels = tools.slice(0, 10).map((t) => TOOL_LABELS[t] ?? clean(t, 60));
  return `avec ${tools.length > 1 ? 'les outils' : "l'outil"} ${labels.join(', ')}`;
}

function formatDelay(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return `${days} jour${days > 1 ? 's' : ''} (${hours} heures)`;
  }
  return `${hours} heure${hours > 1 ? 's' : ''}`;
}

function assigneeText(step: WfStep, todo: WfAuthoringToDoItem | null): string | null {
  if (todo) return todo.hint ? `${q(todo.hint)} (à désigner)` : 'un responsable (à désigner)';
  switch (step.assignee?.kind) {
    case 'initiator':
      return 'le lanceur du workflow';
    case 'subject_owner':
      return "le responsable de l'objet concerné";
    case 'user':
      return 'un utilisateur désigné';
    case 'group':
      return 'un groupe désigné';
    case 'role':
      return 'un rôle désigné';
    default:
      return null;
  }
}

function listKeys(value: unknown, max = 8): string {
  if (!Array.isArray(value)) return '';
  const names: string[] = [];
  for (const item of value) {
    const key = isRecord(item) ? item.key : item;
    if (typeof key === 'string') names.push(clean(key.replace(/[_-]+/g, ' '), 40));
    if (names.length >= max) break;
  }
  return names.filter((n) => n.length > 0).join(', ');
}

function mainSentence(step: WfStep, todo: WfAuthoringToDoItem | null): string {
  const label = stepLabel(step);
  const who = assigneeText(step, todo);
  const config = isRecord(step.config) ? step.config : {};
  switch (step.type) {
    case 'formulaire': {
      const fields = listKeys(config.fields);
      return `À l'étape ${label}, l'agent saisit les informations demandées${fields ? ` (${fields})` : ''}.`;
    }
    case 'generation':
      return `À l'étape ${label}, un texte est rédigé${who ? ` par ${who}` : ''} ; toute suggestion reste à relire.`;
    case 'checklist': {
      const items = listKeys(config.items);
      return `À l'étape ${label}, l'agent coche la liste de contrôle${items ? ` (${items})` : ''}.`;
    }
    case 'affectation':
      return `À l'étape ${label}, ${who ?? 'un responsable'} désigne la personne qui traitera la suite.`;
    case 'validation':
      return `Validation ${label}${who ? ` par ${who}` : ''} : la demande est acceptée ou refusée.`;
    case 'decision':
      return config.manual === true
        ? `Décision manuelle ${label}${who ? ` : ${who} choisit` : ' : un responsable choisit'} le chemin à suivre.`
        : `Décision automatique ${label} : le chemin est choisi d'après les données du dossier.`;
    case 'agent': {
      const agent = step.agent;
      const objective = clean(agent?.objective ?? '', TEXT_MAX).replace(/[.\s]+$/, '');
      const tools = toolsText(agent?.tools ?? []);
      const lead = `À l'étape ${label}, l'agent IA a pour objectif : ${q(objective || 'non précisé')}, ${tools}`;
      switch (agent?.autonomy) {
        case 'agit_avec_validation':
          return `${lead} ; il prépare l'action, mais un humain la valide avant son application.`;
        case 'autonome':
          return `${lead} ; il agit seul (niveau autonome, réservé aux workflows à faible risque).`;
        default:
          return `${lead} ; il ne fait que SUGGÉRER, un humain valide.`;
      }
    }
    default:
      return `À l'étape ${label}, une tâche est réalisée.`;
  }
}

function delaySentences(step: WfStep): string[] {
  const out: string[] = [];
  if (step.dueInHours !== undefined) out.push(`Délai prévu : ${formatDelay(step.dueInHours)}.`);
  if (step.reminderAfterHours !== undefined) out.push(`Un rappel est envoyé après ${formatDelay(step.reminderAfterHours)}.`);
  const esc = isRecord(step.config) ? step.config.escalation : undefined;
  if (isRecord(esc)) {
    const h = esc.dueInHours;
    out.push(
      typeof h === 'number' && Number.isFinite(h) && h > 0
        ? `En cas de dépassement, la tâche est escaladée vers un autre responsable avec un nouveau délai de ${formatDelay(Math.floor(h))}.`
        : 'En cas de dépassement, la tâche est escaladée vers un autre responsable.',
    );
  }
  return out;
}

function branchSentences(
  steps: readonly WfStep[],
  index: number,
  w: Walk,
  nameOf: (key: string) => string,
): string[] {
  const step = steps[index] as WfStep;
  const edges = step.next;
  if (edges.length === 0) return ['Le workflow se termine ici.'];
  const targetText = (edge: WfEdge): string => {
    const t = w.indexByKey.get(edge.to);
    const name = nameOf(edge.to);
    return t !== undefined && w.backEdges.has(`${index}->${t}`)
      ? `retour à ${name} (boucle de correction)`
      : `on passe à ${name}`;
  };
  if (edges.length === 1) {
    const edge = edges[0] as WfEdge;
    const t = w.indexByKey.get(edge.to);
    const back = t !== undefined && w.backEdges.has(`${index}->${t}`);
    const prefix = edge.condition ? `Si ${describeCondition(edge.condition)}, ` : '';
    if (prefix) return [`${prefix}${targetText(edge)}.`];
    return [back ? `Ensuite, retour à ${nameOf(edge.to)} (boucle de correction).` : `Ensuite : ${nameOf(edge.to)}.`];
  }
  const out: string[] = [];
  const conditioned = edges.filter((e) => e.condition !== undefined && e.isDefault !== true);
  const manual = step.type === 'decision' && isRecord(step.config) && step.config.manual === true;
  for (const edge of edges) {
    const label = edge.label ? clean(edge.label, 80) : '';
    if (edge.condition && edge.isDefault !== true) {
      out.push(`Si ${describeCondition(edge.condition)}, ${targetText(edge)}.`);
    } else if (conditioned.length > 0) {
      out.push(`Sinon, ${targetText(edge)}.`);
    } else {
      out.push(`${label ? `Choix ${q(label)} : ` : 'Autre cas : '}${targetText(edge)}.`);
    }
  }
  if (manual) {
    const labels = edges.map((e) => (e.label ? q(clean(e.label, 80)) : '')).filter((l) => l.length > 0);
    if (labels.length > 0) out.unshift(`Choix possibles : ${labels.join(', ')}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Explique un graphe en français : résumé, une phrase par étape, éléments à compléter. */
export function explainGraph(graph: WfGraph, meta: Meta): WfAuthoringExplanation {
  const steps = (Array.isArray(graph?.steps) ? graph.steps : []).slice(0, EXPLAIN_MAX_STEPS);
  const title = clean(meta.name, NAME_MAX) || 'Sans titre';
  if (steps.length === 0) {
    return {
      definitionId: meta.definitionId,
      versionNumber: meta.versionNumber,
      summary: `Workflow ${q(title)} (version ${meta.versionNumber}). Ce workflow ne contient aucune étape.`,
      steps: [],
      toComplete: [],
    };
  }

  const w = walk(steps, graph.start);
  const nameByKey = new Map<string, string>();
  for (const s of steps) if (!nameByKey.has(s.key)) nameByKey.set(s.key, stepLabel(s));
  const nameOf = (key: string): string => nameByKey.get(key) ?? q(clean(key, 60));

  const toComplete: WfAuthoringToDoItem[] = [];
  const explained: WfAuthoringExplanation['steps'] = [];
  for (const i of w.order) {
    const step = steps[i] as WfStep;
    const todo = readToDo(step);
    if (todo) toComplete.push(todo);
    const parts = [mainSentence(step, todo), ...delaySentences(step), ...branchSentences(steps, i, w, nameOf)];
    explained.push({ key: step.key, name: clean(step.name, NAME_MAX) || step.key, text: parts.join(' ') });
  }

  // Ouverture.
  const first = steps[w.indexByKey.get(graph.start) ?? (w.order[0] as number)] as WfStep;
  const firstTargets = first.next.map((e) => nameOf(e.to));
  let opening = `Ce workflow démarre par ${stepLabel(first)}`;
  if (firstTargets.length === 1) opening += `, puis ${firstTargets[0]}`;
  else if (firstTargets.length > 1) opening += ', puis se poursuit selon les cas';
  else opening += ' et se termine aussitôt';
  opening += '.';

  const agentCount = steps.filter((s) => s.type === 'agent').length;
  const decisionCount = steps.filter((s) => s.next.length > 1).length;
  const facts = [`Il comporte ${steps.length} étape${steps.length > 1 ? 's' : ''}`];
  if (agentCount > 0) facts.push(`dont ${agentCount} confiée${agentCount > 1 ? 's' : ''} à un agent IA`);
  if (decisionCount > 0) facts.push(`${decisionCount} point${decisionCount > 1 ? 's' : ''} de branchement`);
  if (w.backEdges.size > 0) facts.push('une boucle de correction');
  const factsText = `${facts[0]}${facts.length > 1 ? ` (${facts.slice(1).join(', ')})` : ''}.`;

  const lines: string[] = [
    `Workflow ${q(title)} (version ${meta.versionNumber}).`,
    opening,
    factsText,
    ...explained.map((s, n) => `${n + 1}. ${q(s.name)} : ${s.text}`),
  ];
  if (toComplete.length > 0) {
    const what = toComplete
      .map((t) => `affectation de ${q(t.stepName)}${t.hint ? ` (${q(t.hint)})` : ''}`)
      .join(' ; ');
    lines.push(
      `Attention : ${toComplete.length} élément${toComplete.length > 1 ? 's restent' : ' reste'} à compléter avant la publication : ${what}.`,
    );
  }

  return {
    definitionId: meta.definitionId,
    versionNumber: meta.versionNumber,
    summary: lines.join('\n'),
    steps: explained,
    toComplete,
  };
}
