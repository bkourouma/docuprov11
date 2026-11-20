// Logique pure du connecteur WhatsApp Business (lot 2c) : normalisation des numéros, construction de
// la charge utile API et relecture d'un connecteur pour le formulaire. Aucune dépendance à React.
//
// Sécurité : les secrets (accessToken, appSecret, verifyToken) ne vivent que dans les valeurs du
// formulaire, le temps de la saisie ; ils ne sont jamais relus d'un connecteur (l'API ne les renvoie
// pas) et `readWhatsappValues` renvoie toujours des champs de secrets vides.
import {
  GED_WHATSAPP_CONNECTOR_TYPE,
  GED_WHATSAPP_CREDENTIAL_KEYS,
  GED_WHATSAPP_PRINCIPAL_PREFIX,
  GedSourceMode,
  gedWhatsappWebhookPath,
  type GedConnectorView,
  type GedWhatsappConfig,
} from '@archivage/types';

export { GED_WHATSAPP_CONNECTOR_TYPE };

export const isWhatsappType = (type: string | undefined | null): boolean =>
  type === GED_WHATSAPP_CONNECTOR_TYPE;

/** Version de l'API Graph proposée par défaut. */
export const DEFAULT_GRAPH_API_VERSION = 'v21.0';

const MIO = 1024 * 1024;
const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 15;
const RIGHTS_KEY = 'rights';
/** Clés de `config` gérées par le sous-formulaire (les autres clés existantes sont conservées). */
const MANAGED_KEYS = new Set([
  'phoneNumberId',
  'graphApiVersion',
  'maxFileBytes',
  'ackEnabled',
  'refuseUnknownSenders',
  'senders',
  RIGHTS_KEY,
]);

// ---------------------------------------------------------------------------
// Numéros
// ---------------------------------------------------------------------------

export type PhoneCheck = { ok: true; phone: string } | { ok: false; error: string };

/**
 * Même règle que le serveur : retire espaces, points, tirets, parenthèses et `+`, puis exige
 * 8 à 15 chiffres, sans 0 initial (format international, indicatif du pays en tête).
 */
export function normalizeWhatsappPhone(input: string | null | undefined): PhoneCheck {
  const raw = (input ?? '').trim();
  if (raw === '') return { ok: false, error: 'Saisissez un numéro de téléphone.' };
  const digits = raw.replace(/[\s.\-()+]/g, '');
  if (!/^\d+$/.test(digits)) {
    return {
      ok: false,
      error:
        'Le numéro ne doit contenir que des chiffres (les espaces, points, tirets, parenthèses et « + » sont ignorés).',
    };
  }
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
    return {
      ok: false,
      error: `Le numéro doit comporter de ${PHONE_MIN_DIGITS} à ${PHONE_MAX_DIGITS} chiffres, indicatif du pays compris.`,
    };
  }
  if (digits.startsWith('0')) {
    return {
      ok: false,
      error:
        'Utilisez le format international, sans 0 au début : commencez par l’indicatif du pays (ex. 221 77 123 45 67).',
    };
  }
  return { ok: true, phone: digits };
}

/**
 * Masque un numéro pour l'affichage : indicatif (3 premiers chiffres) et 2 derniers chiffres
 * visibles, le reste en puces. `221771234567` -> `+221 •• ••• •• 67`.
 */
export function maskWhatsappPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < PHONE_MIN_DIGITS) return '••••';
  const head = digits.slice(0, 3);
  const tail = digits.slice(-2);
  const hidden = digits.length - 5;
  const sizes = [2, 3];
  const groups: string[] = [];
  let left = hidden;
  for (let i = 0; left > 0; i += 1) {
    const n = Math.min(sizes[i % sizes.length] ?? 2, left);
    groups.push('•'.repeat(n));
    left -= n;
  }
  return `+${head} ${groups.join(' ')} ${tail}`;
}

// ---------------------------------------------------------------------------
// Valeurs du formulaire
// ---------------------------------------------------------------------------

export interface WhatsappSenderRow {
  /** Saisie libre ; normalisée à la validation et à la construction. */
  phone?: string;
  label?: string;
  /** `user_group_id` DocuPro, ou vide = groupes de repli. */
  userGroupId?: number | null;
}

export interface WhatsappSecrets {
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
}

export interface WhatsappFormValues {
  phoneNumberId?: string;
  graphApiVersion?: string;
  /** Taille maximale en Mio ; vide = limite du cadre. */
  maxFileMio?: number | null;
  ackEnabled?: boolean;
  refuseUnknownSenders?: boolean;
  senders?: WhatsappSenderRow[];
  /** Identifiants (ou saisie brute de nombres, si la liste des groupes est indisponible). */
  fallbackGroupIds?: (number | string)[];
  /** Édition : cochée = les trois secrets sont renvoyés et remplacent les anciens. */
  replaceSecrets?: boolean;
  secrets?: WhatsappSecrets;
}

export function defaultWhatsappValues(): WhatsappFormValues {
  return {
    phoneNumberId: '',
    graphApiVersion: '',
    maxFileMio: null,
    ackEnabled: true,
    refuseUnknownSenders: false,
    senders: [],
    fallbackGroupIds: [],
    replaceSecrets: false,
    secrets: {},
  };
}

/** `7`, `"7"` -> 7 ; sinon null. */
export function toGroupId(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function cleanGroupIds(list: (number | string)[] | undefined): number[] {
  const out: number[] = [];
  for (const v of list ?? []) {
    const id = toGroupId(v);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface WhatsappPayload {
  mode: typeof GedSourceMode.Copie;
  syncIntervalMinutes: null;
  config: Record<string, unknown>;
  /** Absent = secrets inchangés (édition sans « Remplacer les secrets »). */
  credentials?: { accessToken: string; appSecret: string; verifyToken: string };
}

export type WhatsappPayloadResult =
  | { ok: true; payload: WhatsappPayload }
  | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Construit mode, périodicité, `config` et `credentials` à envoyer à l'API.
 * - `editing` faux : création, les trois secrets sont obligatoires.
 * - `editing` vrai : `credentials` n'est envoyé que si `replaceSecrets` est coché (et alors les trois
 *   secrets sont obligatoires, le PUT remplaçant l'ensemble).
 * - `existingConfig` : clés de configuration inconnues du sous-formulaire, conservées telles quelles.
 */
export function buildWhatsappPayload(
  values: WhatsappFormValues,
  opts: { editing: boolean; existingConfig?: Record<string, unknown> | null } = { editing: false },
): WhatsappPayloadResult {
  const errors: string[] = [];

  const phoneNumberId = (values.phoneNumberId ?? '').trim();
  if (!/^\d+$/.test(phoneNumberId)) {
    errors.push(
      'Le numéro WhatsApp Business (Phone Number ID) est obligatoire et composé de chiffres.',
    );
  }

  const graphApiVersion = (values.graphApiVersion ?? '').trim();
  if (graphApiVersion !== '' && !/^v\d+\.\d+$/.test(graphApiVersion)) {
    errors.push('La version de l’API Graph doit ressembler à « v21.0 ».');
  }

  const mio = values.maxFileMio;
  if (mio != null && !(typeof mio === 'number' && Number.isFinite(mio) && mio > 0)) {
    errors.push('La taille maximale doit être un nombre positif de Mio.');
  }

  const senders: { phone: string; label?: string }[] = [];
  const principalMap: Record<string, number> = {};
  const seen = new Set<string>();
  for (const row of values.senders ?? []) {
    const check = normalizeWhatsappPhone(row.phone);
    if (!check.ok) {
      errors.push(`Expéditeur « ${row.label?.trim() || row.phone || '?'} » : ${check.error}`);
      continue;
    }
    if (seen.has(check.phone)) {
      errors.push(`Le numéro ${maskWhatsappPhone(check.phone)} figure plusieurs fois.`);
      continue;
    }
    seen.add(check.phone);
    const label = row.label?.trim();
    senders.push({ phone: check.phone, ...(label ? { label } : {}) });
    const group = toGroupId(row.userGroupId);
    if (group !== null) principalMap[`${GED_WHATSAPP_PRINCIPAL_PREFIX}${check.phone}`] = group;
  }

  const fallback = cleanGroupIds(values.fallbackGroupIds);
  if (fallback.length === 0) {
    errors.push('Choisissez au moins un groupe de repli.');
  }

  const wantCredentials = !opts.editing || values.replaceSecrets === true;
  let credentials: WhatsappPayload['credentials'];
  if (wantCredentials) {
    const s = values.secrets ?? {};
    const accessToken = s.accessToken ?? '';
    const appSecret = s.appSecret ?? '';
    const verifyToken = s.verifyToken ?? '';
    if (accessToken === '' || appSecret === '' || verifyToken === '') {
      errors.push(
        'Renseignez les trois secrets (jeton d’accès, secret de l’application, jeton de vérification).',
      );
    } else {
      credentials = { accessToken, appSecret, verifyToken };
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts.existingConfig ?? {})) {
    if (!MANAGED_KEYS.has(k)) config[k] = v;
  }
  const existingRights = isRecord(opts.existingConfig?.[RIGHTS_KEY])
    ? (opts.existingConfig[RIGHTS_KEY] as Record<string, unknown>)
    : {};
  const typed: GedWhatsappConfig = {
    phoneNumberId,
    senders,
    ackEnabled: values.ackEnabled !== false,
    refuseUnknownSenders: values.refuseUnknownSenders === true,
    ...(graphApiVersion ? { graphApiVersion } : {}),
    ...(typeof mio === 'number' ? { maxFileBytes: Math.floor(mio * MIO) } : {}),
  };
  Object.assign(config, typed, {
    [RIGHTS_KEY]: { ...existingRights, principalMap, fallbackUserGroupIds: fallback },
  });

  return {
    ok: true,
    payload: {
      mode: GedSourceMode.Copie,
      syncIntervalMinutes: null,
      config,
      ...(credentials ? { credentials } : {}),
    },
  };
}

/** Lecture tolérante de la configuration d'un connecteur `whatsapp` (jamais de secret). */
export function readWhatsappValues(view: GedConnectorView): WhatsappFormValues {
  const config = isRecord(view.config) ? view.config : {};
  const rights = isRecord(config[RIGHTS_KEY]) ? config[RIGHTS_KEY] : {};
  const map = isRecord(rights.principalMap) ? rights.principalMap : {};
  const fallback = Array.isArray(rights.fallbackUserGroupIds) ? rights.fallbackUserGroupIds : [];
  const rawSenders = Array.isArray(config.senders) ? config.senders : [];

  const senders: WhatsappSenderRow[] = [];
  for (const s of rawSenders) {
    if (!isRecord(s) || typeof s.phone !== 'string') continue;
    senders.push({
      phone: s.phone,
      label: typeof s.label === 'string' ? s.label : '',
      userGroupId: toGroupId(map[`${GED_WHATSAPP_PRINCIPAL_PREFIX}${s.phone}`]),
    });
  }

  const bytes = config.maxFileBytes;
  return {
    phoneNumberId: typeof config.phoneNumberId === 'string' ? config.phoneNumberId : '',
    graphApiVersion: typeof config.graphApiVersion === 'string' ? config.graphApiVersion : '',
    maxFileMio:
      typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
        ? Math.round((bytes / MIO) * 100) / 100
        : null,
    ackEnabled: config.ackEnabled !== false,
    refuseUnknownSenders: config.refuseUnknownSenders === true,
    senders,
    fallbackGroupIds: cleanGroupIds(
      fallback.filter((v): v is number | string => typeof v === 'number' || typeof v === 'string'),
    ),
    replaceSecrets: false,
    secrets: {},
  };
}

// ---------------------------------------------------------------------------
// Affichage (page de détail)
// ---------------------------------------------------------------------------

export interface WhatsappSenderView {
  /** Numéro masqué : seule forme affichable. */
  masked: string;
  label: string;
  userGroupId: number | null;
}

/** Expéditeurs prêts à l'affichage : numéros masqués d'emblée, le numéro complet ne sort pas d'ici. */
export function readWhatsappSendersMasked(view: GedConnectorView): WhatsappSenderView[] {
  return (readWhatsappValues(view).senders ?? []).map((s) => ({
    masked: maskWhatsappPhone(s.phone),
    label: s.label ?? '',
    userGroupId: s.userGroupId ?? null,
  }));
}

/**
 * URL du webhook à saisir dans la console Meta. Si l'adresse de l'API est absolue
 * (`NEXT_PUBLIC_API_URL=https://…/api`), on en reprend l'origine ; sinon on ne connaît pas
 * l'adresse publique : on renvoie le chemin seul (`complete: false`).
 */
export function whatsappWebhookUrl(
  connectorId: number,
  apiBase: string,
): { url: string; complete: boolean } {
  const path = gedWhatsappWebhookPath(connectorId);
  if (/^https?:\/\//i.test(apiBase)) {
    try {
      return { url: `${new URL(apiBase).origin}${path}`, complete: true };
    } catch {
      /* adresse illisible : on retombe sur le chemin */
    }
  }
  return { url: path, complete: false };
}

export { GED_WHATSAPP_CREDENTIAL_KEYS };
