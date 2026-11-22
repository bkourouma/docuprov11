// Docu-Flow — explication des problèmes de validation d'un workflow pour un non-développeur.
// Logique pure : aucun React. Les codes viennent du validateur partagé (@archivage/types) et du serveur.
import { validateWorkflowGraph, wfEscalationConfigSchema, type WfGraph } from '@archivage/types';
import type { WfDefinitionIssue, WfDefinitionIssueCode } from '../../lib/workflows-api';
import { evaluationHref, toolGrantsHref } from './guardrails-links';

/**
 * Les 21 codes : les 14 du graphe + l'escalade invalide + l'exécuteur d'agent manquant + l'affectation à compléter (W5)
 * + les 4 contrôles des étapes agent émis à la publication (configuration, outil inconnu, outil non autorisé, autonomie).
 */
export const ALL_ISSUE_CODES: readonly WfDefinitionIssueCode[] = [
  'SCHEMA_INVALID',
  'DUPLICATE_STEP_KEY',
  'START_NOT_FOUND',
  'EDGE_TARGET_NOT_FOUND',
  'SELF_LOOP',
  'UNREACHABLE_STEP',
  'NO_TERMINAL_STEP',
  'STEP_CANNOT_REACH_TERMINAL',
  'AMBIGUOUS_BRANCHING',
  'AGENT_SPEC_MISSING',
  'AGENT_SPEC_ON_NON_AGENT',
  'DUPLICATE_EDGE_TARGET',
  'AUTONOMY_REQUIRES_LOW_RISK',
  'DECISION_NEEDS_BRANCHES',
  'ESCALATION_INVALID',
  'EXECUTOR_MISSING',
  'AUTHORING_TO_COMPLETE',
  'AGENT_CONFIG_INVALID',
  'AGENT_TOOL_UNKNOWN',
  'AGENT_TOOL_NOT_GRANTED',
  'AGENT_AUTONOMY_NOT_ELIGIBLE',
];

export interface IssueExplanation {
  code: WfDefinitionIssueCode;
  title: string;
  explain: string;
  fix: string;
  stepKey?: string;
  /** Message d'origine (technique), à n'afficher que dans un détail repliable. */
  detail?: string;
  /** Lien vers l'écran qui permet de résoudre le problème (présent seulement si l'identifiant du workflow est connu). */
  action?: IssueAction;
}

export interface IssueAction {
  label: string;
  href: string;
}

export interface ExplainOptions {
  /** Identifiant du workflow : permet de fournir les liens vers « Outils autorisés » et l'évaluation. */
  definitionId?: number;
}

// ---------------------------------------------------------------------------
// Aides
// ---------------------------------------------------------------------------

/** Les textes entre « » du message d'origine (clés d'étape cibles, etc.). */
function quoted(message: string): string[] {
  return [...message.matchAll(/«\s*([^»]*?)\s*»/g)].map((m) => m[1] ?? '');
}

function stepName(graph: WfGraph | undefined, key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  return graph?.steps.find((s) => s.key === key)?.name;
}

/** « Valider » si le nom est connu, sinon la clé. */
function stepRef(graph: WfGraph | undefined, key: string | undefined): string {
  if (key === undefined) return 'cette étape';
  return `« ${stepName(graph, key) ?? key} »`;
}

// ---------------------------------------------------------------------------
// SCHEMA_INVALID : traduction du chemin et du message de validation
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  key: "l'identifiant de l'étape",
  name: 'le nom',
  type: "le type d'étape",
  description: 'la description',
  assignee: "l'affectation",
  dueInHours: "le délai d'échéance",
  reminderAfterHours: 'le délai de relance',
  config: 'la configuration',
  agent: "la configuration de l'agent",
  next: 'les étapes suivantes',
  objective: "l'objectif de l'agent",
  tools: "la liste d'outils",
  confidenceThreshold: 'le seuil de confiance',
  autonomy: "le niveau d'autonomie",
  model: 'le modèle',
  maxSteps: "le nombre maximal d'actions",
  maxCostPerRun: 'le coût maximal par exécution',
  to: 'la destination',
  label: "le libellé de la transition",
  condition: 'la condition',
  isDefault: 'le choix « par défaut »',
  field: 'le champ de la condition',
  op: "l'opérateur de la condition",
  value: 'la valeur de la condition',
  kind: "le type d'affectation",
  id: "l'identifiant de l'affectation",
  start: "l'étape de départ",
  steps: 'la liste des étapes',
  schemaVersion: 'la version du format',
};

/** Précisions de valeurs attendues, plus parlantes que le message de validation. */
const FIELD_EXPECTATIONS: Record<string, string> = {
  dueInHours: "doit être un nombre entier d'heures compris entre 1 et 8760",
  reminderAfterHours: "doit être un nombre entier d'heures strictement positif",
  confidenceThreshold: 'doit être un nombre compris entre 0 et 1',
  maxSteps: 'doit être un nombre entier compris entre 1 et 50',
  maxCostPerRun: 'doit être un nombre positif ou nul',
  schemaVersion: 'doit être la version 1',
};

/** Traduit un message de validation anglais en fin de phrase (« est obligatoire »). */
function translateRule(raw: string, field: string | undefined): string {
  const expectation = field !== undefined ? FIELD_EXPECTATIONS[field] : undefined;
  const text = raw.trim();
  if (/^required$/i.test(text) || /received undefined/i.test(text)) return 'est obligatoire';
  if (expectation !== undefined && /number|integer|greater|less|invalid/i.test(text)) return expectation;
  let m = /at least (\d+) character/i.exec(text);
  if (m) return m[1] === '1' ? 'ne peut pas être vide' : `doit contenir au moins ${m[1]} caractères`;
  m = /at most (\d+) character/i.exec(text);
  if (m) return `ne peut pas dépasser ${m[1]} caractères`;
  m = /at least (\d+) element/i.exec(text);
  if (m) return `doit contenir au moins ${m[1]} élément${m[1] === '1' ? '' : 's'}`;
  m = /at most (\d+) element/i.exec(text);
  if (m) return `ne peut pas contenir plus de ${m[1]} éléments`;
  if (/expected integer|must be an integer/i.test(text)) return 'doit être un nombre entier';
  if (/expected number/i.test(text)) return 'doit être un nombre';
  if (/expected string/i.test(text)) return 'doit être un texte';
  if (/expected boolean/i.test(text)) return 'doit être « oui » ou « non »';
  if (/expected array/i.test(text)) return 'doit être une liste';
  if (/expected object/i.test(text)) return 'est mal renseigné';
  if (/greater than 0|positive/i.test(text)) return 'doit être strictement positif';
  m = /less than or equal to (\d+)/i.exec(text);
  if (m) return `ne peut pas dépasser ${m[1]}`;
  m = /greater than or equal to (\d+)/i.exec(text);
  if (m) return `doit être au moins égal à ${m[1]}`;
  if (/invalid enum value|invalid literal|invalid option/i.test(text)) return 'a une valeur non reconnue';
  if (/unrecognized key/i.test(text)) return 'contient un élément inconnu';
  // Message déjà rédigé en français par le validateur (« clé d'étape invalide… », « l'identifiant est obligatoire… »).
  if (/[àâçéèêëîïôûùüÿœ]|^(l'|la |le |les |clé )/i.test(text)) return `est invalide (${text})`;
  return 'est invalide';
}

function parseSchemaPath(issue: WfDefinitionIssue): (string | number)[] {
  if (issue.path && issue.path.length > 0) return issue.path;
  // Repli : « Forme du graphe invalide (steps.2.name) : … »
  const m = /\(([^)]+)\)\s*:/.exec(issue.message);
  if (!m || m[1] === undefined) return [];
  return m[1].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function parseSchemaMessage(message: string): string {
  const i = message.indexOf(' : ');
  return i >= 0 ? message.slice(i + 3) : message;
}

function explainSchema(issue: WfDefinitionIssue, graph: WfGraph | undefined): string {
  const path = parseSchemaPath(issue);
  const raw = parseSchemaMessage(issue.message);

  if (path.length === 0) return 'Le contenu du workflow est incomplet ou mal formé.';
  const [head, second, third, fourth, ...rest] = path;

  if (head === 'start') return `L'étape de départ ${translateRule(raw, 'start')}.`;
  if (head === 'schemaVersion') return `La version du format ${translateRule(raw, 'schemaVersion')}.`;
  if (head === 'steps' && second === undefined) {
    return `La liste des étapes ${/at most/i.test(raw) ? 'ne peut pas dépasser 200 étapes' : 'doit contenir au moins une étape'}.`;
  }
  if (head !== 'steps' || typeof second !== 'number') {
    return `Une information du workflow ${translateRule(raw, undefined)}.`;
  }

  const step = graph?.steps[second];
  const where = step ? `L'étape « ${step.name} »` : `L'étape n° ${second + 1}`;
  if (third === undefined) return `${where} est mal renseignée.`;

  // Transition : steps.i.next.j.<champ>
  if (third === 'next' && typeof fourth === 'number') {
    const edgeField = rest[0];
    const edgePrefix = `${where}, transition n° ${fourth + 1}`;
    if (edgeField === undefined) return `${edgePrefix} : elle est mal renseignée.`;
    const fieldKey = typeof edgeField === 'string' ? edgeField : undefined;
    const label = (fieldKey && FIELD_LABELS[fieldKey]) ?? 'une information';
    return `${edgePrefix} : ${label} ${translateRule(raw, fieldKey)}.`;
  }

  const field = typeof third === 'string' ? third : undefined;
  // Sous-champ (agent.objective, assignee.id…) : on nomme le plus précis.
  const sub = typeof fourth === 'string' ? fourth : undefined;
  const key = sub ?? field;
  const label = (key && FIELD_LABELS[key]) ?? 'une information';
  const context = sub && field === 'agent' ? " (configuration de l'agent)" : sub && field === 'assignee' ? " (affectation)" : '';
  return `${where} : ${label}${context} ${translateRule(raw, key)}.`;
}

// ---------------------------------------------------------------------------
// explainIssue
// ---------------------------------------------------------------------------

/**
 * Explication d'un code, sans étape ni message : titre, ce que cela signifie et pourquoi c'est bloquant, comment corriger.
 * Fonction pure pour les écrans qui n'ont que le code (aide, légende).
 */
export function explainDefinitionIssue(code: WfDefinitionIssueCode): { code: WfDefinitionIssueCode; title: string; explain: string; fix: string } {
  const { title, explain, fix } = explainIssue({ code, message: '' });
  return { code, title, explain, fix };
}

export function explainIssue(issue: WfDefinitionIssue, graph?: WfGraph, opts?: ExplainOptions): IssueExplanation {
  const ref = stepRef(graph, issue.stepKey);
  const base = { code: issue.code, stepKey: issue.stepKey, detail: issue.message || undefined };
  const make = (title: string, explain: string, fix: string, action?: IssueAction | null): IssueExplanation =>
    withoutUndefined({ ...base, title, explain, fix, action: action ?? undefined });
  const definitionId = opts?.definitionId;
  const toolGrantsLink = definitionId === undefined ? null : toolGrantsHref(definitionId);
  const evaluationLink = definitionId === undefined ? null : evaluationHref(definitionId, issue.stepKey);

  switch (issue.code) {
    case 'SCHEMA_INVALID':
      return make(
        'Information manquante ou incorrecte',
        explainSchema(issue, graph),
        'Corrigez le champ indiqué dans le panneau de l’étape concernée, puis relancez la vérification.',
      );
    case 'DUPLICATE_STEP_KEY':
      return make(
        'Deux étapes portent le même identifiant',
        `L'étape ${ref} partage son identifiant interne avec une autre étape : le moteur ne saurait pas les distinguer.`,
        "Ouvrez l'étape et donnez-lui un identifiant unique (par exemple en ajoutant un numéro à la fin).",
      );
    case 'START_NOT_FOUND':
      return make(
        "L'étape de départ est introuvable",
        "Le workflow doit commencer par une étape, mais celle qui est désignée comme départ n'existe plus (elle a sans doute été supprimée ou renommée).",
        'Choisissez une étape existante et utilisez « Définir comme étape de départ ».',
      );
    case 'EDGE_TARGET_NOT_FOUND': {
      const target = quoted(issue.message)[1];
      return make(
        'Une transition mène nulle part',
        `Une transition de l'étape ${ref} pointe vers ${target ? `« ${stepName(graph, target) ?? target} »` : 'une étape'} qui n'existe pas.`,
        'Supprimez cette transition ou redirigez-la vers une étape existante.',
      );
    }
    case 'SELF_LOOP':
      return make(
        'Une étape renvoie vers elle-même',
        `L'étape ${ref} est suivie directement par elle-même : elle ne se terminerait jamais.`,
        "Supprimez cette transition. Pour un retour en arrière, passez par une autre étape (par exemple une correction).",
      );
    case 'UNREACHABLE_STEP':
      return make(
        'Étape jamais utilisée',
        `Aucun chemin ne mène à l'étape ${ref} depuis l'étape de départ : elle ne sera jamais exécutée.`,
        "Reliez-la à une étape qui précède, ou supprimez-la si elle est inutile.",
      );
    case 'NO_TERMINAL_STEP':
      return make(
        'Aucune étape finale',
        'Le workflow ne peut jamais se terminer : chaque étape a une suite. Il faut au moins une étape sans « étape suivante » pour clore le dossier.',
        "Retirez les transitions sortantes de la dernière étape du parcours, ou ajoutez une étape de clôture.",
      );
    case 'STEP_CANNOT_REACH_TERMINAL':
      return make(
        'Une boucle sans issue',
        `À partir de l'étape ${ref}, le workflow tourne en rond et n'atteint jamais une étape finale.`,
        "Ajoutez depuis cette boucle une transition vers une étape qui termine le workflow (avec une condition de sortie).",
      );
    case 'AMBIGUOUS_BRANCHING':
      return make(
        'Plusieurs chemins par défaut',
        `L'étape ${ref} a plusieurs transitions sans condition : le moteur ne sait pas laquelle prendre.`,
        'Gardez une seule transition « de repli » (sans condition) et donnez une condition à chacune des autres.',
      );
    case 'AGENT_SPEC_MISSING':
      return make(
        "L'agent n'est pas configuré",
        `L'étape ${ref} est de type « Agent » mais on n'a pas indiqué ce que l'agent doit faire.`,
        "Ouvrez l'étape et renseignez l'objectif de l'agent, ses outils et son niveau d'autonomie, ou changez le type de l'étape.",
      );
    case 'AGENT_SPEC_ON_NON_AGENT':
      return make(
        "Réglages d'agent sur une étape qui n'en est pas une",
        `L'étape ${ref} n'est pas de type « Agent » mais contient des réglages d'agent.`,
        "Repassez l'étape au type « Agent », ou retirez la configuration d'agent.",
      );
    case 'DUPLICATE_EDGE_TARGET':
      return make(
        'Transition en double',
        `L'étape ${ref} a deux transitions vers la même étape.`,
        'Supprimez la transition en trop, ou fusionnez leurs conditions en une seule.',
      );
    case 'AUTONOMY_REQUIRES_LOW_RISK':
      return make(
        'Autonomie non autorisée',
        `L'agent de l'étape ${ref} est réglé sur « autonome », ce qui n'est permis que pour un workflow marqué « à faible risque ».`,
        "Choisissez un niveau moins autonome (« suggère » ou « agit avec validation »), ou demandez à un administrateur de marquer ce workflow à faible risque.",
      );
    case 'DECISION_NEEDS_BRANCHES':
      return make(
        'Décision sans choix',
        `L'étape de décision ${ref} doit mener à au moins deux suites différentes, sinon il n'y a rien à décider.`,
        'Ajoutez une seconde transition (avec une condition ou un repli), ou changez le type de l’étape.',
      );
    case 'ESCALATION_INVALID':
      return make(
        'Escalade mal réglée',
        `L'escalade de l'étape ${ref} est incomplète : ${escalationHint(issue.message)}`,
        "Ouvrez l'étape, section « Escalade », et renseignez un délai (en heures), un destinataire et, si besoin, le nombre de relances.",
      );
    case 'EXECUTOR_MISSING':
      return make(
        "Agent indisponible sur le serveur",
        `L'étape ${ref} utilise un agent, mais le serveur n'a pas de moteur d'exécution d'agent disponible pour l'instant.`,
        "Contactez l'administrateur, ou remplacez cette étape par une étape humaine (validation, formulaire…).",
      );
    case 'AUTHORING_TO_COMPLETE':
      return make(
        'Affectation à compléter',
        `L'étape ${ref} a été proposée par l'IA sans responsable : « Affectation à compléter ». Le workflow ne peut pas être publié tant que personne n'est désigné.`,
        "Ouvrez l'étape, section « Affectation », et choisissez un utilisateur, un groupe, un rôle, le lanceur ou le propriétaire de l'objet.",
      );
    case 'AGENT_CONFIG_INVALID':
      return make(
        "Réglages de l'agent invalides",
        `Les réglages de l'agent de l'étape ${ref} contiennent une valeur impossible : objectif vide, seuil de confiance hors de l'intervalle de 0 à 1, nombre d'actions ou délai hors des limites, ou coût négatif. Un agent mal réglé se comporterait de façon imprévisible : la publication est donc bloquée.`,
        "Ouvrez l'étape, section « Agent », et corrigez les valeurs signalées. Le détail ci-dessous précise celles qui posent problème.",
      );
    case 'AGENT_TOOL_UNKNOWN':
      return make(
        'Outil inconnu ou désactivé',
        `L'agent de l'étape ${ref} utilise un outil qui n'existe pas dans le catalogue ou qu'un administrateur a désactivé. L'agent ne pourrait pas s'en servir au moment de l'exécution : la publication est donc bloquée.`,
        "Retirez cet outil de l'étape ou remplacez-le par un outil du catalogue. S'il a été désactivé volontairement, demandez à un administrateur de le réactiver.",
      );
    case 'AGENT_TOOL_NOT_GRANTED':
      return make(
        'Outil non autorisé pour ce workflow',
        `L'agent de l'étape ${ref} utilise un outil qui n'est pas autorisé pour CE workflow. Chaque workflow ne peut employer que les outils qu'un administrateur lui a explicitement accordés : c'est une règle de sécurité (liste d'outils autorisés par workflow), et non une erreur dans les étapes ou les transitions.`,
        "Demandez à un administrateur d'autoriser cet outil pour ce workflow dans l'écran « Outils autorisés », ou retirez l'outil de l'étape.",
        toolGrantsLink === null ? null : { label: 'Ouvrir « Outils autorisés »', href: toolGrantsLink },
      );
    case 'AGENT_AUTONOMY_NOT_ELIGIBLE':
      return make(
        'Niveau autonome non éligible',
        `L'agent de l'étape ${ref} est réglé sur « autonome », mais ce niveau n'est accordé qu'à un workflow marqué « à faible risque » et dont l'agent a réussi son évaluation avec les réglages actuels. Ici, au moins une de ces conditions n'est pas remplie (évaluation absente, échouée, ou réglages modifiés depuis). La publication est bloquée pour éviter qu'un agent agisse seul sans avoir été contrôlé.`,
        "Lancez ou relancez l'évaluation de l'agent jusqu'à sa réussite, et vérifiez qu'un administrateur a marqué le workflow « à faible risque ». À défaut, choisissez un niveau moins autonome (« suggère » ou « agit avec validation »).",
        evaluationLink === null ? null : { label: "Ouvrir l'évaluation", href: evaluationLink },
      );
    default:
      return make(
        'Problème de validation',
        'Le workflow contient une erreur que cet écran ne sait pas expliquer.',
        'Relisez les étapes concernées. Si le problème persiste, contactez un administrateur en lui transmettant le détail ci-dessous.',
      );
  }
}

/** Partie utile du message d'escalade (déjà en français) sans le préfixe « Escalade de l'étape … invalide : ». */
function escalationHint(message: string): string {
  const i = message.indexOf(' : ');
  const hint = i >= 0 ? message.slice(i + 3).trim() : '';
  return hint === '' ? "délai et destinataire à vérifier." : hint;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Validation « en direct »
// ---------------------------------------------------------------------------

const ESCALATION_FIELD_HINTS: Record<string, string> = {
  dueInHours: 'le délai est obligatoire (nombre entier d’heures, de 1 à 8760)',
  maxEscalations: 'le nombre de relances doit être un entier de 1 à 5',
  assignee: 'le destinataire doit être un utilisateur, un groupe ou un rôle, avec son identifiant',
  message: 'le message est limité à 500 caractères',
};

/**
 * Validation côté client : le validateur partagé (identique à celui du serveur) + le contrôle d'escalade.
 *
 * EXECUTOR_MISSING n'est PAS calculable ici : seul le serveur sait si l'exécuteur d'agent existe (il dépend
 * de la configuration du déploiement). Ce code n'apparaît donc que dans les réponses du serveur et se
 * combine aux problèmes locaux avec `mergeIssues`.
 */
export function validateLive(
  graph: unknown,
  opts: { isLowRisk: boolean },
): { ok: boolean; issues: WfDefinitionIssue[] } {
  const result = validateWorkflowGraph(graph, { isLowRisk: opts.isLowRisk });
  const issues: WfDefinitionIssue[] = result.issues.map((i) => ({ ...i }));

  const steps = (graph as { steps?: unknown } | null)?.steps;
  if (Array.isArray(steps)) {
    steps.forEach((raw: unknown, index) => {
      const step = raw as { key?: unknown; config?: unknown } | null;
      const config = step?.config;
      if (typeof config !== 'object' || config === null) return;
      const escalation = (config as { escalation?: unknown }).escalation;
      if (escalation === undefined) return;
      const parsed = wfEscalationConfigSchema.safeParse(escalation);
      if (parsed.success) return;
      const stepKey = typeof step?.key === 'string' ? step.key : undefined;
      const hints = new Set<string>();
      for (const zodIssue of parsed.error.issues) {
        const field = zodIssue.path[0];
        hints.add(
          (typeof field === 'string' ? ESCALATION_FIELD_HINTS[field] : undefined) ??
            'il faut un délai et un destinataire',
        );
      }
      issues.push(
        withoutUndefined({
          code: 'ESCALATION_INVALID' as const,
          message: `Escalade de l'étape « ${stepKey ?? `n° ${index + 1}`} » invalide : ${[...hints].join(' ; ')}.`,
          stepKey,
          path: ['steps', index, 'config', 'escalation'],
        }),
      );
    });
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Regroupement, résumé, fusion
// ---------------------------------------------------------------------------

export function groupIssuesByStep(issues: WfDefinitionIssue[]): {
  global: WfDefinitionIssue[];
  byStep: Record<string, WfDefinitionIssue[]>;
} {
  const global: WfDefinitionIssue[] = [];
  const byStep: Record<string, WfDefinitionIssue[]> = {};
  for (const issue of issues) {
    if (issue.stepKey === undefined) {
      global.push(issue);
    } else {
      const list = Object.hasOwn(byStep, issue.stepKey) ? (byStep[issue.stepKey] as WfDefinitionIssue[]) : [];
      list.push(issue);
      byStep[issue.stepKey] = list;
    }
  }
  return { global, byStep };
}

/** « Aucun problème », « 1 problème », « 3 problèmes sur 2 étapes ». */
export function summarizeIssues(issues: WfDefinitionIssue[]): string {
  const n = issues.length;
  if (n === 0) return 'Aucun problème';
  if (n === 1) return '1 problème';
  const steps = new Set(issues.map((i) => i.stepKey).filter((k): k is string => k !== undefined)).size;
  const base = `${n} problèmes`;
  return steps === 0 ? base : `${base} sur ${steps} étape${steps > 1 ? 's' : ''}`;
}

/** Codes qui peuvent légitimement apparaître plusieurs fois pour une même étape (une par arête, une par champ). */
const PER_LOCATION_CODES: ReadonlySet<string> = new Set([
  'SCHEMA_INVALID',
  'SELF_LOOP',
  'DUPLICATE_EDGE_TARGET',
  'EDGE_TARGET_NOT_FOUND',
]);

/**
 * Clé de dédoublonnage : code + étape ; le message ne s'y ajoute que pour les codes qui se répètent par emplacement.
 * Pour les autres, le serveur et le client formulent le message différemment (ex. ESCALATION_INVALID) : le garder
 * dans la clé affichait le même problème deux fois.
 */
function issueKey(issue: WfDefinitionIssue): string {
  const base = `${issue.code}\u0000${issue.stepKey ?? ''}`;
  return PER_LOCATION_CODES.has(issue.code) ? `${base}\u0000${issue.message}` : base;
}

/** Fusionne problèmes locaux et problèmes du serveur, sans doublon (voir issueKey), locaux d'abord. */
export function mergeIssues(live: WfDefinitionIssue[], server: WfDefinitionIssue[]): WfDefinitionIssue[] {
  const seen = new Set<string>();
  const out: WfDefinitionIssue[] = [];
  for (const issue of [...live, ...server]) {
    const id = issueKey(issue);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(issue);
  }
  return out;
}
