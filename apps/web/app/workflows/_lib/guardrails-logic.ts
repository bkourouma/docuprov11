// Docu-Flow — garde-fous des agents : autorisation des outils d'un workflow et bandeau d'autonomie.
// Logique PURE (sans React, sans réseau). Les formes d'entrée sont structurelles : elles acceptent les DTO de
// l'API sans les importer.
import {
  WF_TOOL_SIDE_EFFECT_LABELS,
  WfToolSideEffect,
  isWfToolSideEffect,
  type WfAutonomyKey,
} from '@archivage/types';

// ---------------------------------------------------------------------------
// Bandeau pédagogique du niveau d'autonomie
// ---------------------------------------------------------------------------

export type BannerTone = 'warning' | 'info' | 'success';

export interface AutonomyBannerInfo {
  tone: BannerTone;
  title: string;
  text: string;
}

const BANNERS: Record<WfAutonomyKey, AutonomyBannerInfo> = {
  suggere: {
    tone: 'warning',
    title: 'Rien n\'est appliqué',
    text:
      'Niveau « suggère » : rien n\'est appliqué. L\'agent propose, la personne qui valide lit la proposition, ' +
      'mais aucun effet (imputation, relance, brouillon…) n\'est exécuté. ' +
      'Passez à « agit avec validation » pour que la validation applique l\'effet.',
  },
  agit_avec_validation: {
    tone: 'info',
    title: 'L\'agent prépare, une personne applique',
    text:
      'Niveau « agit avec validation » : l\'agent prépare l\'effet (imputation, relance, brouillon…) et la ' +
      'validation humaine l\'applique. Rien n\'est exécuté sans accord d\'une personne.',
  },
  autonome: {
    tone: 'success',
    title: 'Autonomie réservée au faible risque',
    text:
      'Niveau « autonome » : réservé aux workflows à faible risque dont l\'évaluation a réussi. ' +
      'Aucun effet irréversible n\'est appliqué sans validation humaine.',
  },
};

/** Bandeau du niveau d'autonomie ; une clé inconnue retombe sur le niveau le plus prudent (« suggère »). */
export function autonomyBanner(level: WfAutonomyKey): AutonomyBannerInfo {
  const found = Object.prototype.hasOwnProperty.call(BANNERS, level) ? BANNERS[level] : BANNERS.suggere;
  return { ...found };
}

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

/** Libellé de l'effet de bord (0 lecture, 1 écriture réversible, 2 externe ou irréversible). */
export function sideEffectLabel(sideEffect: number): string {
  return isWfToolSideEffect(sideEffect) ? WF_TOOL_SIDE_EFFECT_LABELS[sideEffect] : 'Effet inconnu';
}

export interface ToolRiskInput {
  sideEffect: number;
  requiresValidation: boolean;
}

/** Note courte sur le risque d'un outil. Un effet inconnu est traité comme irréversible. */
export function toolRiskNote(entry: ToolRiskInput): string {
  switch (entry.sideEffect) {
    case WfToolSideEffect.Read:
      return 'lecture seule';
    case WfToolSideEffect.ReversibleWrite:
      return entry.requiresValidation ? 'prépare une écriture, une personne valide' : 'écriture réversible';
    case WfToolSideEffect.ExternalIrreversible:
      return 'irréversible, validation obligatoire';
    default:
      return 'effet inconnu, traité comme irréversible, validation obligatoire';
  }
}

export interface ToolCatalogEntryInput {
  toolKey: string;
  label: string;
  description: string | null;
  sideEffect: number;
  requiresValidation: boolean;
  isEnabled: boolean;
}

export interface ToolGrantInput {
  toolKey: string;
  maxCallsPerInstance: number | null;
}

export interface GrantRow {
  toolKey: string;
  label: string;
  description: string | null;
  sideEffect: number;
  requiresValidation: boolean;
  isEnabled: boolean;
  granted: boolean;
  /** Plafond d'appels par instance ; null = illimité. */
  maxCalls: number | null;
  /** Autorisé mais absent du catalogue (outil retiré) : à décocher. */
  orphan: boolean;
}

/**
 * Fusionne le catalogue et les autorisations actuelles. Un outil autorisé mais absent du catalogue devient une
 * ligne « orpheline » (désactivée, traitée comme irréversible par prudence). Tri : outils activés d'abord, puis clé.
 */
export function buildGrantRows(
  catalog: readonly ToolCatalogEntryInput[],
  grants: readonly ToolGrantInput[],
): GrantRow[] {
  const byKey = new Map<string, ToolGrantInput>();
  for (const g of grants) if (!byKey.has(g.toolKey)) byKey.set(g.toolKey, g);

  const rows: GrantRow[] = [];
  const seen = new Set<string>();
  for (const t of catalog) {
    if (seen.has(t.toolKey)) continue;
    seen.add(t.toolKey);
    const g = byKey.get(t.toolKey);
    rows.push({
      toolKey: t.toolKey,
      label: t.label,
      description: t.description,
      sideEffect: t.sideEffect,
      requiresValidation: t.requiresValidation,
      isEnabled: t.isEnabled,
      granted: g !== undefined,
      maxCalls: g ? g.maxCallsPerInstance : null,
      orphan: false,
    });
  }
  for (const [toolKey, g] of byKey) {
    if (seen.has(toolKey)) continue;
    rows.push({
      toolKey,
      label: toolKey,
      description: null,
      sideEffect: WfToolSideEffect.ExternalIrreversible,
      requiresValidation: true,
      isEnabled: false,
      granted: true,
      maxCalls: g.maxCallsPerInstance,
      orphan: true,
    });
  }
  return rows.sort((a, b) => {
    if (a.isEnabled !== b.isEnabled) return a.isEnabled ? -1 : 1;
    return a.toolKey < b.toolKey ? -1 : a.toolKey > b.toolKey ? 1 : 0;
  });
}

export const MAX_CALLS_LIMIT = 2_147_483_647;
const TOOL_KEY_PATTERN = /^[a-z0-9_.]+$/;

export interface MaxCallsResult {
  ok: boolean;
  /** null = illimité (champ vide) ou saisie invalide. */
  value: number | null;
  error?: string;
}

/** Plafond d'appels par instance : vide = illimité ; sinon entier de 1 à 2 147 483 647. */
export function validateMaxCalls(raw: string): MaxCallsResult {
  const s = (raw ?? '').trim();
  if (s === '') return { ok: true, value: null };
  if (!/^\d+$/.test(s)) {
    return { ok: false, value: null, error: 'Saisissez un nombre entier positif, ou laissez vide pour ne pas limiter.' };
  }
  const n = Number(s);
  if (n < 1) return { ok: false, value: null, error: 'La limite doit être au moins 1 (laissez vide pour ne pas limiter).' };
  if (n > MAX_CALLS_LIMIT) {
    return { ok: false, value: null, error: `La limite ne peut pas dépasser ${MAX_CALLS_LIMIT.toLocaleString('fr-FR')}.` };
  }
  return { ok: true, value: n };
}

export interface GrantPayloadItem {
  toolKey: string;
  maxCallsPerInstance: number | null;
}

/**
 * Corps du PUT : uniquement les lignes cochées, sans doublon, à clé valide. Par prudence (échec fermé), une ligne
 * dont la limite est invalide (non entière, hors bornes) n'est pas autorisée : l'écran doit valider avant.
 */
export function grantsToPayload(
  rows: ReadonlyArray<{ toolKey: string; granted: boolean; maxCalls: number | null }>,
): GrantPayloadItem[] {
  const out: GrantPayloadItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.granted || seen.has(r.toolKey) || r.toolKey.length > 100 || !TOOL_KEY_PATTERN.test(r.toolKey)) continue;
    const m = r.maxCalls;
    if (m !== null && !(Number.isInteger(m) && m >= 1 && m <= MAX_CALLS_LIMIT)) continue;
    seen.add(r.toolKey);
    out.push({ toolKey: r.toolKey, maxCallsPerInstance: m });
  }
  return out;
}

export interface GrantsDiff {
  added: string[];
  removed: string[];
  changedLimit: string[];
}

/** Différence entre deux ensembles d'autorisations (clés triées). */
export function diffGrants(before: readonly ToolGrantInput[], after: readonly ToolGrantInput[]): GrantsDiff {
  const b = new Map(before.map((g) => [g.toolKey, g.maxCallsPerInstance]));
  const a = new Map(after.map((g) => [g.toolKey, g.maxCallsPerInstance]));
  const added = [...a.keys()].filter((k) => !b.has(k)).sort();
  const removed = [...b.keys()].filter((k) => !a.has(k)).sort();
  const changedLimit = [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k)).sort();
  return { added, removed, changedLimit };
}

/** Phrase française décrivant le changement. */
export function describeGrantsDiff(diff: GrantsDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`${diff.added.length === 1 ? 'Outil ajouté' : 'Outils ajoutés'} : ${diff.added.join(', ')}.`);
  if (diff.removed.length > 0) parts.push(`${diff.removed.length === 1 ? 'Outil retiré' : 'Outils retirés'} : ${diff.removed.join(', ')}.`);
  if (diff.changedLimit.length > 0) {
    parts.push(`${diff.changedLimit.length === 1 ? 'Limite modifiée pour' : 'Limites modifiées pour'} : ${diff.changedLimit.join(', ')}.`);
  }
  return parts.length === 0 ? 'Aucun changement.' : parts.join(' ');
}

// ---------------------------------------------------------------------------
// Outils utilisés par le graphe
// ---------------------------------------------------------------------------

/** Forme minimale d'un graphe (compatible avec WfGraph). */
export interface GraphLike {
  steps: ReadonlyArray<{
    key: string;
    name: string;
    type: string;
    agent?: { tools: readonly string[] } | undefined;
  }>;
}

export interface StepTools {
  stepKey: string;
  stepName: string;
  toolKeys: string[];
}

/** Étapes agent du graphe avec leurs outils (sans doublon, dans l'ordre déclaré). Graphe absent => []. */
export function usedToolsByStep(graph: GraphLike | null | undefined): StepTools[] {
  const steps = graph && Array.isArray(graph.steps) ? graph.steps : [];
  const out: StepTools[] = [];
  for (const s of steps) {
    if (s.type !== 'agent' || !s.agent) continue;
    out.push({ stepKey: s.key, stepName: s.name, toolKeys: [...new Set<string>(s.agent.tools ?? [])] });
  }
  return out;
}

export interface MissingGrant {
  stepKey: string;
  stepName: string;
  toolKey: string;
}

/** Outils utilisés par le graphe mais non autorisés : situation qui provoque AGENT_TOOL_NOT_GRANTED à la publication. */
export function missingGrants(graph: GraphLike | null | undefined, grantedKeys: Iterable<string>): MissingGrant[] {
  const granted = new Set(grantedKeys);
  const out: MissingGrant[] = [];
  for (const s of usedToolsByStep(graph)) {
    for (const toolKey of s.toolKeys) {
      if (!granted.has(toolKey)) out.push({ stepKey: s.stepKey, stepName: s.stepName, toolKey });
    }
  }
  return out;
}

/** Explication courte de la liste blanche d'outils. */
export function grantsExplanation(): string {
  return (
    'Chaque workflow dispose d\'une liste blanche d\'outils : sans autorisation, un outil n\'est pas utilisable ' +
    'par les agents de ce workflow. ' +
    'Si une étape agent utilise un outil non autorisé, la publication est refusée avec le code ' +
    'AGENT_TOOL_NOT_GRANTED : autorisez l\'outil ou retirez-le de l\'étape. ' +
    'Un outil retiré de la liste après la publication devient indisponible à l\'exécution.'
  );
}
