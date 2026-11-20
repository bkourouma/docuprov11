// Client API des connecteurs de sources GED (lot 2a, administration). Le contrat vit dans
// @archivage/types : on réexporte types et libellés pour que les pages n'aient qu'un point d'import.
//
// Sécurité : les identifiants ne transitent que dans le CORPS des requêtes de création/modification,
// jamais dans une URL, un stockage navigateur ou un journal. Les fonctions pures de ce fichier ne
// renvoient jamais d'identifiant à l'affichage (l'API ne les renvoie d'ailleurs pas).
import {
  GedSourceConnectorStatus,
  GedSourceItemState,
  GedSourceMode,
  GedSyncRunStatus,
  GED_SOURCE_CONNECTOR_STATUS_LABELS,
  GED_SOURCE_ITEM_STATE_LABELS,
  GED_SOURCE_MODE_LABELS,
  GED_SYNC_RUN_STATUS_LABELS,
  type GedConnectorFieldDescriptor,
  type GedConnectorTypeInfo,
  type GedConnectorView,
  type GedSourceItemView,
  type GedSourceSyncRunView,
} from '@archivage/types';
import { apiJson } from './api';

export {
  GedSourceConnectorStatus,
  GedSourceItemState,
  GedSourceMode,
  GedSyncRunStatus,
  GED_SOURCE_CONNECTOR_STATUS_LABELS,
  GED_SOURCE_ITEM_STATE_LABELS,
  GED_SOURCE_MODE_LABELS,
  GED_SYNC_RUN_STATUS_LABELS,
  type GedConnectorFieldDescriptor,
  type GedConnectorTypeInfo,
  type GedConnectorView,
  type GedSourceItemView,
  type GedSourceSyncRunView,
};

export interface ConnectorTestResult {
  ok: boolean;
  message: string;
}

export interface ItemsPage {
  items: GedSourceItemView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ItemsQuery {
  state?: GedSourceItemState;
  q?: string;
  page?: number;
  pageSize?: number;
}

/** Corps de création (miroir de `createConnectorSchema`). */
export interface ConnectorCreateBody {
  label: string;
  connectorType: string;
  mode: GedSourceMode;
  config: Record<string, unknown>;
  credentials?: Record<string, string>;
  syncIntervalMinutes: number | null;
  targetDossierId: number | null;
}

/** Corps de modification (miroir de `updateConnectorSchema`) : `credentials` absent = inchangé, `null` = effacé. */
export interface ConnectorUpdateBody {
  label: string;
  mode: GedSourceMode;
  config: Record<string, unknown>;
  credentials?: Record<string, string> | null;
  syncIntervalMinutes: number | null;
  targetDossierId: number | null;
}

const base = '/ged/connectors';

export const connecteursApi = {
  types: () => apiJson<GedConnectorTypeInfo[]>(`${base}/types`),
  list: () => apiJson<GedConnectorView[]>(base),
  get: (id: number) => apiJson<GedConnectorView>(`${base}/${id}`),
  create: (body: ConnectorCreateBody) =>
    apiJson<GedConnectorView>(base, { method: 'POST', body: JSON.stringify(body) }),
  update: (id: number, body: ConnectorUpdateBody) =>
    apiJson<GedConnectorView>(`${base}/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  test: (id: number) =>
    apiJson<ConnectorTestResult>(`${base}/${id}/test`, { method: 'POST', body: '{}' }),
  sync: (id: number) =>
    apiJson<{ queued: true }>(`${base}/${id}/sync`, { method: 'POST', body: '{}' }),
  deactivate: (id: number) =>
    apiJson<GedConnectorView>(`${base}/${id}/deactivate`, { method: 'POST', body: '{}' }),
  activate: (id: number) =>
    apiJson<GedConnectorView>(`${base}/${id}/activate`, { method: 'POST', body: '{}' }),
  runs: (id: number, limit = 20) =>
    apiJson<GedSourceSyncRunView[]>(`${base}/${id}/runs?limit=${limit}`),
  items: (id: number, query: ItemsQuery = {}) => {
    const p = new URLSearchParams();
    if (query.state !== undefined) p.set('state', String(query.state));
    if (query.q?.trim()) p.set('q', query.q.trim());
    if (query.page) p.set('page', String(query.page));
    if (query.pageSize) p.set('pageSize', String(query.pageSize));
    const qs = p.toString();
    return apiJson<ItemsPage>(`${base}/${id}/items${qs ? `?${qs}` : ''}`);
  },
  item: (id: number, itemId: number) => apiJson<GedSourceItemView>(`${base}/${id}/items/${itemId}`),
};

/**
 * `apiJson` ne conserve que le message d'erreur, pas le code HTTP : on reconnaît le refus d'accès
 * à son texte (garde « Réservé aux administrateurs » / « Vous n'avez pas accès », ou repli « HTTP 403 »).
 */
export function isForbiddenError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message.toLowerCase();
  return (
    m === 'http 403' ||
    m.includes('réservé aux administrateurs') ||
    m.includes('pas accès') ||
    m.includes('forbidden')
  );
}

// ---------------------------------------------------------------------------
// Aides des modes
// ---------------------------------------------------------------------------

export const MODE_HELP: Record<GedSourceMode, string> = {
  [GedSourceMode.Copie]:
    'Le fichier est importé dans DocuPro, qui en devient dépositaire : la source n’est plus nécessaire ensuite.',
  [GedSourceMode.IndexationEnPlace]:
    'Seul le texte est conservé pour la recherche ; le fichier reste à la source.',
  [GedSourceMode.Synchro]:
    'Copie tenue à jour : les modifications et suppressions à la source sont répercutées.',
};

export const RIGHTS_HELP =
  'Un document n’est jamais plus ouvert qu’à la source. Sans correspondance, il n’est visible que des groupes de repli. Par défaut : votre groupe.';

// ---------------------------------------------------------------------------
// Conversion formulaire <-> API (fonctions pures)
// ---------------------------------------------------------------------------

/** Champs de configuration qui sont des TABLEAUX côté API, saisis en zone de texte. */
const LIST_FIELDS = new Set(['extensions']);
export const isListField = (name: string): boolean => LIST_FIELDS.has(name);

/** « .pdf, .docx\n.txt » -> ['.pdf', '.docx', '.txt'] (vides et doublons écartés). */
export function splitList(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const part of text.split(/[\n,;]+/)) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export const joinList = (values: unknown): string =>
  Array.isArray(values) ? values.map((v) => String(v)).join(', ') : '';

export interface PrincipalRow {
  principal?: string;
  userGroupId?: number | null;
}

export interface ConnectorFormValues {
  label?: string;
  connectorType?: string;
  mode?: GedSourceMode;
  /** Champs de configuration, par nom de champ. */
  config?: Record<string, unknown>;
  /** Identifiants saisis, par nom de champ (jamais pré-remplis). */
  credentials?: Record<string, string | undefined>;
  /** `null` = synchronisation manuelle. */
  syncIntervalMinutes?: number | null;
  targetDossierId?: number | null;
  principalMap?: PrincipalRow[];
  /** Identifiants de groupes de repli, saisis en liste (virgule / saut de ligne). */
  fallbackGroups?: string;
}

const RIGHTS_KEY = 'rights';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Valeurs initiales du formulaire à partir d'un connecteur existant (config non secrète seulement). */
export function toFormValues(
  view: GedConnectorView,
  info: GedConnectorTypeInfo | undefined,
): ConnectorFormValues {
  const config = isRecord(view.config) ? view.config : {};
  const fieldValues: Record<string, unknown> = {};
  for (const f of info?.configFields ?? []) {
    const raw = config[f.name];
    fieldValues[f.name] = isListField(f.name) ? joinList(raw) : (raw ?? undefined);
  }
  const rights = isRecord(config[RIGHTS_KEY]) ? config[RIGHTS_KEY] : {};
  const map = isRecord(rights.principalMap) ? rights.principalMap : {};
  const fallback = Array.isArray(rights.fallbackUserGroupIds) ? rights.fallbackUserGroupIds : [];
  return {
    label: view.label,
    connectorType: view.connectorType,
    mode: view.mode,
    config: fieldValues,
    credentials: {},
    syncIntervalMinutes: view.syncIntervalMinutes,
    targetDossierId: view.targetDossierId,
    principalMap: Object.entries(map).map(([principal, id]) => ({
      principal,
      userGroupId: typeof id === 'number' ? id : null,
    })),
    fallbackGroups: fallback.join(', '),
  };
}

/** Identifiants positifs saisis : « 3, 7\n9 » -> [3, 7, 9] ; les valeurs invalides sont écartées. */
export function parseIdList(text: string | null | undefined): number[] {
  const ids: number[] = [];
  for (const part of splitList(text)) {
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (Number.isSafeInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
    }
  }
  return ids;
}

/** Vrai si la liste saisie contient au moins un jeton qui n'est pas un identifiant valide. */
export function hasInvalidIds(text: string | null | undefined): boolean {
  return splitList(text).some((p) => !/^\d+$/.test(p) || Number(p) <= 0);
}

/**
 * Construit `config` : repart de la configuration existante (clés inconnues du formulaire
 * conservées), applique les champs du type, puis `rights`.
 * Valeur vide -> clé absente (le registre applique ses défauts).
 */
export function buildConfig(
  info: GedConnectorTypeInfo | undefined,
  values: ConnectorFormValues,
  existing?: Record<string, unknown> | null,
): Record<string, unknown> {
  const managed = new Set((info?.configFields ?? []).map((f) => f.name));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existing ?? {})) {
    if (!managed.has(k) && k !== RIGHTS_KEY) out[k] = v;
  }
  for (const f of info?.configFields ?? []) {
    const raw = values.config?.[f.name];
    if (isListField(f.name)) {
      const list = splitList(typeof raw === 'string' ? raw : joinList(raw));
      if (list.length > 0) out[f.name] = list;
      continue;
    }
    if (f.kind === 'boolean') {
      if (typeof raw === 'boolean') out[f.name] = raw;
    } else if (f.kind === 'number') {
      if (typeof raw === 'number' && Number.isFinite(raw)) out[f.name] = raw;
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      out[f.name] = f.kind === 'textarea' ? raw : raw.trim();
    }
  }

  const principalMap: Record<string, number> = {};
  for (const row of values.principalMap ?? []) {
    const p = row.principal?.trim();
    if (p && typeof row.userGroupId === 'number' && row.userGroupId > 0) {
      principalMap[p] = row.userGroupId;
    }
  }
  const fallback = parseIdList(values.fallbackGroups);
  // Repli vide : la clé est OMISE pour que l'API pose le groupe de l'administrateur (jamais « vide »,
  // qui rendrait les documents visibles de tous et est refusé).
  if (Object.keys(principalMap).length > 0 || fallback.length > 0) {
    out[RIGHTS_KEY] = {
      principalMap,
      ...(fallback.length > 0 ? { fallbackUserGroupIds: fallback } : {}),
    };
  }
  return out;
}

/** Identifiants saisis non vides, ou `undefined` si rien n'a été saisi. */
export function buildCredentials(
  info: GedConnectorTypeInfo | undefined,
  values: ConnectorFormValues,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const f of info?.credentialFields ?? []) {
    const v = values.credentials?.[f.name];
    if (typeof v === 'string' && v !== '') out[f.name] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildCreateBody(
  info: GedConnectorTypeInfo | undefined,
  values: ConnectorFormValues,
): ConnectorCreateBody {
  const credentials = buildCredentials(info, values);
  return {
    label: (values.label ?? '').trim(),
    connectorType: values.connectorType ?? info?.type ?? '',
    mode: values.mode ?? GedSourceMode.Copie,
    config: buildConfig(info, values),
    ...(credentials ? { credentials } : {}),
    syncIntervalMinutes: values.syncIntervalMinutes ?? null,
    targetDossierId: values.targetDossierId ?? null,
  };
}

/**
 * `credentials` : saisis = remplacement complet ; `clearCredentials` = `null` (effacement) ;
 * sinon la clé est ABSENTE (identifiants inchangés).
 */
export function buildUpdateBody(
  info: GedConnectorTypeInfo | undefined,
  values: ConnectorFormValues,
  existingConfig: Record<string, unknown> | null,
  clearCredentials: boolean,
): ConnectorUpdateBody {
  const credentials = buildCredentials(info, values);
  return {
    label: (values.label ?? '').trim(),
    mode: values.mode ?? GedSourceMode.Copie,
    config: buildConfig(info, values, existingConfig),
    ...(credentials ? { credentials } : clearCredentials ? { credentials: null } : {}),
    syncIntervalMinutes: values.syncIntervalMinutes ?? null,
    targetDossierId: values.targetDossierId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

/** Date et heure locales courtes ; chaîne vide si absente. */
export const formatDateTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';

/** Tronque un texte long (empreinte, erreur) en gardant le début. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Config prête à l'affichage : sans la clé `rights` (présentée à part) ; valeurs aplaties en texte. */
export function displayConfig(
  config: Record<string, unknown> | null,
): { key: string; value: string }[] {
  return Object.entries(config ?? {})
    .filter(([k]) => k !== RIGHTS_KEY)
    .map(([key, v]) => ({
      key,
      value: Array.isArray(v)
        ? v.join(', ')
        : isRecord(v)
          ? JSON.stringify(v)
          : typeof v === 'boolean'
            ? v
              ? 'Oui'
              : 'Non'
            : String(v ?? ''),
    }));
}
