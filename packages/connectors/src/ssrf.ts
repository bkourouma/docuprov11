// Garde SSRF pour les hôtes saisis par l'administrateur applicatif (serveur IMAP, API distante…).
//
// Menace : un administrateur DocuPro (ou un compte administrateur compromis) saisit comme « serveur
// de messagerie » une adresse interne — base de données, Redis, API interne, métadonnées du cloud
// (169.254.169.254) — et se sert du worker comme d'un relais vers le réseau privé. L'administrateur
// APPLICATIF n'est pas l'exploitant : seul ce dernier peut ouvrir un serveur interne, par la
// variable d'environnement GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS.
//
// Principe : refus par défaut (fail-closed). Tout ce qu'on ne sait pas analyser est refusé ; les
// notations IP « exotiques » acceptées par inet_aton/getaddrinfo (2130706433, 0x7f.1, 0177.0.0.1,
// 127.1) sont décodées pour être jugées, puis refusées même si publiques : aucun administrateur
// n'en a besoin, et les bibliothèques ne les interprètent pas toutes de la même façon.
//
// `assertPublicHost` renvoie les adresses VÉRIFIÉES : le connecteur doit s'y connecter directement
// (et garder le nom pour SNI/TLS) au lieu de relancer une résolution DNS, sinon un DNS piégé peut
// répondre une adresse publique à la vérification puis une adresse interne à la connexion (DNS
// rebinding).
import { promises as dnsPromises } from 'node:dns';

/** Motif du refus, pour que l'API choisisse un statut et un libellé sans analyser le message. */
export type SsrfErrorCode =
  | 'invalid_host'
  | 'blocked_name'
  | 'blocked_address'
  | 'non_standard_ip'
  | 'unresolved';

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly code: SsrfErrorCode = 'blocked_address',
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

// ---------------------------------------------------------------------------
// Analyse d'adresses
// ---------------------------------------------------------------------------

/** IPv4 en notation canonique stricte (4 octets décimaux, sans zéro de tête) → entier non signé. */
function parseIpv4Canonical(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i] as string;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/**
 * IPv4 selon les règles d'inet_aton (celles de getaddrinfo et de la norme URL WHATWG) : 1 à 4
 * parties, chacune décimale, hexadécimale (`0x`) ou octale (zéro de tête), la dernière couvrant
 * les octets restants. C'est ce que le système résoudrait réellement : on le décode pour le juger.
 */
function parseIpv4Loose(s: string): { value: number; canonical: boolean } | null {
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  let canonical = parts.length === 4;
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(part)) {
      n = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
      canonical = false;
    } else if (/^0[0-7]+$/.test(part)) {
      n = parseInt(part, 8);
      canonical = false;
    } else if (/^(0|[1-9][0-9]*)$/.test(part)) {
      n = Number(part);
    } else {
      // `08`, `09`, partie vide, lettres : invalide pour inet_aton → refus franc plutôt que de
      // laisser la résolution DNS décider de ce que cela signifie.
      return null;
    }
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1] as number;
  const head = nums.slice(0, -1);
  if (head.some((n) => n > 255)) return null;
  if (last >= 256 ** (5 - nums.length)) return null;
  let value = 0;
  head.forEach((n, i) => {
    value += n * 256 ** (3 - i);
  });
  value += last;
  return { value, canonical };
}

function formatIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** IPv6 (sans crochets ni zone) → 16 octets ; `null` si la syntaxe n'est pas rigoureusement valide. */
function parseIpv6(input: string): Uint8Array | null {
  if (input.length < 2 || input.length > 45 || !input.includes(':')) return null;
  let s = input.toLowerCase();
  // Queue IPv4 pointée (`::ffff:127.0.0.1`) : réécrite en deux groupes hexadécimaux.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4Canonical(tail);
    if (v4 == null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const split = (h: string): string[] => (h === '' ? [] : h.split(':'));
  const head = split(halves[0] as string);
  const rest = halves.length === 2 ? split(halves[1] as string) : [];
  const groups = [...head, ...rest];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1 ? groups.length !== 8 : groups.length > 7) return null;
  const fill = 8 - groups.length;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
  const bytes = new Uint8Array(16);
  all.forEach((g, i) => {
    const n = parseInt(g, 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 255;
  });
  return bytes;
}

type V4Rule = { base: number; prefix: number };
type V6Rule = { bytes: Uint8Array; prefix: number };

function v4Rule(cidr: string): V4Rule {
  const [addr, len] = cidr.split('/') as [string, string];
  return { base: parseIpv4Canonical(addr) as number, prefix: Number(len) };
}
function v6Rule(cidr: string): V6Rule {
  const [addr, len] = cidr.split('/') as [string, string];
  return { bytes: parseIpv6(addr) as Uint8Array, prefix: Number(len) };
}
function inV4(ip: number, r: V4Rule): boolean {
  if (r.prefix === 0) return true;
  return (ip ^ r.base) >>> (32 - r.prefix) === 0;
}
function inV6(ip: Uint8Array, r: V6Rule): boolean {
  let bits = r.prefix;
  for (let i = 0; i < 16 && bits > 0; i++) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((ip[i] as number) & mask) !== ((r.bytes[i] as number) & mask)) return false;
    bits -= 8;
  }
  return true;
}

/** Plages IPv4 internes, réservées, de documentation ou non routables (RFC 6890 et suivantes). */
const BLOCKED_V4 = [
  '0.0.0.0/8', // « ce réseau » ; 0.0.0.0 joint l'hôte local sous Linux
  '10.0.0.0/8',
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8',
  '169.254.0.0/16', // lien local, dont métadonnées cloud 169.254.169.254
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24', // relais 6to4 anycast
  '192.168.0.0/16',
  '198.18.0.0/15', // bancs d'essai
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // réservé, dont 255.255.255.255
].map(v4Rule);

/** Jamais autorisées, même par la liste blanche de l'exploitant : aucun serveur légitime n'y répond. */
const NEVER_ALLOWED_V4 = [
  '0.0.0.0/8',
  '169.254.169.254/32',
  '224.0.0.0/4',
  '255.255.255.255/32',
].map(v4Rule);
const NEVER_ALLOWED_V6 = ['::/128', 'fd00:ec2::254/128', 'ff00::/8'].map(v6Rule);

/** Adresses IPv6 qui transportent une IPv4 : jugées sur l'IPv4 embarquée (octets indiqués). */
const V4_MAPPED = v6Rule('::ffff:0:0/96');
const V6_EMBEDDING: Array<{ rule: V6Rule; offset: number }> = [
  { rule: V4_MAPPED, offset: 12 }, // IPv4-mappée
  { rule: v6Rule('::ffff:0:0:0/96'), offset: 12 }, // IPv4-traduite (SIIT)
  { rule: v6Rule('64:ff9b::/96'), offset: 12 }, // NAT64
  { rule: v6Rule('2002::/16'), offset: 2 }, // 6to4
];

/**
 * Seul l'espace unicast global 2000::/3 est attribué aujourd'hui : tout le reste (::/8 dont ::1 et
 * ::, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64, 64:ff9b:1::/48…) est refusé d'office,
 * ce qui évite de devoir énumérer chaque plage réservée. À l'intérieur de 2000::/3, on retire :
 */
const GLOBAL_V6 = v6Rule('2000::/3');
const BLOCKED_IN_GLOBAL_V6 = [
  '2001::/23', // attributions de protocole IETF : Teredo (2001::/32), bancs d'essai, ORCHID…
  '2001:db8::/32', // documentation
  '3fff::/20', // documentation (RFC 9637)
].map(v6Rule);

function embeddedV4(bytes: Uint8Array): number | null {
  for (const { rule, offset } of V6_EMBEDDING) {
    if (inV6(bytes, rule)) {
      return (
        (bytes[offset] as number) * 2 ** 24 +
        ((bytes[offset + 1] as number) << 16) +
        ((bytes[offset + 2] as number) << 8) +
        (bytes[offset + 3] as number)
      );
    }
  }
  return null;
}

function isBlockedV4(ip: number): boolean {
  return BLOCKED_V4.some((r) => inV4(ip, r));
}
function isBlockedV6(bytes: Uint8Array): boolean {
  const v4 = embeddedV4(bytes);
  if (v4 != null) return isBlockedV4(v4);
  if (!inV6(bytes, GLOBAL_V6)) return true;
  return BLOCKED_IN_GLOBAL_V6.some((r) => inV6(bytes, r));
}

type ParsedIp = { family: 4; v4: number } | { family: 6; v6: Uint8Array };

/** Adresse canonique (IPv4 stricte, ou IPv6 éventuellement entre crochets, sans zone). */
function parseIp(raw: string): ParsedIp | null {
  let s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('%')) return null;
  const v4 = parseIpv4Canonical(s);
  if (v4 != null) return { family: 4, v4 };
  const v6 = parseIpv6(s);
  return v6 ? { family: 6, v6 } : null;
}

/**
 * Vrai pour toute adresse interne, réservée, de documentation, multicast… Entrée non analysable
 * (notation non canonique, zone `%eth0`, texte quelconque) → vrai : en cas de doute, on bloque.
 */
export function isBlockedAddress(ip: string): boolean {
  if (typeof ip !== 'string') return true;
  const parsed = parseIp(ip);
  if (!parsed) return true;
  return parsed.family === 4 ? isBlockedV4(parsed.v4) : isBlockedV6(parsed.v6);
}

function isNeverAllowed(p: ParsedIp): boolean {
  if (p.family === 4) return NEVER_ALLOWED_V4.some((r) => inV4(p.v4, r));
  const v4 = embeddedV4(p.v6);
  if (v4 != null) return NEVER_ALLOWED_V4.some((r) => inV4(v4, r));
  return NEVER_ALLOWED_V6.some((r) => inV6(p.v6, r));
}

// ---------------------------------------------------------------------------
// Liste blanche de l'exploitant
// ---------------------------------------------------------------------------

type AllowRule =
  | { kind: 'name'; name: string }
  | { kind: 'v4'; rule: V4Rule }
  | { kind: 'v6'; rule: V6Rule };

const LABEL_REGEX = /^[a-z0-9_-]{1,63}$/;
/** Préfixes plus larges que /8 (IPv4) ou /16 (IPv6) ignorés : `0.0.0.0/0` désactiverait la garde. */
const MIN_ALLOW_PREFIX_V4 = 8;
const MIN_ALLOW_PREFIX_V6 = 16;

/** Découpe `GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS` (séparateur virgule) en entrées non vides. */
export function parseAllowList(raw: string | undefined | null): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Entrée invalide → ignorée : une liste blanche mal écrite doit RESTREINDRE, jamais ouvrir. */
function compileAllowRules(entries: readonly string[]): AllowRule[] {
  const rules: AllowRule[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const e = entry.trim().toLowerCase();
    if (e === '') continue;
    const slash = e.indexOf('/');
    const addrPart = slash >= 0 ? e.slice(0, slash) : e;
    const lenPart = slash >= 0 ? e.slice(slash + 1) : null;
    if (lenPart != null && !/^\d{1,3}$/.test(lenPart)) continue;
    const bare =
      addrPart.startsWith('[') && addrPart.endsWith(']') ? addrPart.slice(1, -1) : addrPart;
    const v4 = parseIpv4Canonical(bare);
    if (v4 != null) {
      const prefix = lenPart == null ? 32 : Number(lenPart);
      if (prefix < MIN_ALLOW_PREFIX_V4 || prefix > 32) continue;
      rules.push({ kind: 'v4', rule: { base: v4, prefix } });
      continue;
    }
    const v6 = parseIpv6(bare);
    if (v6) {
      const prefix = lenPart == null ? 128 : Number(lenPart);
      if (prefix < MIN_ALLOW_PREFIX_V6 || prefix > 128) continue;
      rules.push({ kind: 'v6', rule: { bytes: v6, prefix } });
      continue;
    }
    if (lenPart != null) continue;
    const name = e.endsWith('.') ? e.slice(0, -1) : e;
    if (
      name.length > 0 &&
      name.length <= 253 &&
      name.split('.').every((l) => LABEL_REGEX.test(l))
    ) {
      rules.push({ kind: 'name', name });
    }
  }
  return rules;
}

function isAddressAllowed(p: ParsedIp, rules: AllowRule[]): boolean {
  // Une IPv4-mappée (::ffff:a.b.c.d) EST l'IPv4 a.b.c.d pour la pile réseau : même verdict.
  const v4 = p.family === 4 ? p.v4 : inV6(p.v6, V4_MAPPED) ? embeddedV4(p.v6) : null;
  return rules.some((r) => {
    if (r.kind === 'v4') return v4 != null && inV4(v4, r.rule);
    if (r.kind === 'v6') return p.family === 6 && inV6(p.v6, r.rule);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Noms d'hôte
// ---------------------------------------------------------------------------

/**
 * Suffixes qui ne désignent jamais un serveur public (RFC 6761/6762/8375, `.internal` réservé par
 * l'ICANN, pseudo-domaines privés usuels). La résolution DNS les attraperait souvent, mais pas
 * toujours : un `*.local` mDNS ou un `/etc/hosts` du conteneur peuvent répondre autre chose.
 */
const BLOCKED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'localdomain',
  'home.arpa',
  'lan',
  'intranet',
  'corp',
  'home',
];

function isBlockedName(name: string, labels: string[]): boolean {
  // Nom court sans point (`redis`, `postgres`, `api`) : c'est exactement ainsi que Docker Compose
  // nomme les services voisins du worker. Aucun serveur public ne s'adresse ainsi.
  if (labels.length === 1) return true;
  return BLOCKED_SUFFIXES.some((s) => name === s || name.endsWith(`.${s}`));
}

const DNS_TIMEOUT_MS = 5000;

async function defaultResolve(host: string): Promise<string[]> {
  const results = await dnsPromises.lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Messages destinés à l'administrateur applicatif : clairs, sans détail réseau (on ne recopie
// jamais les adresses résolues, pour ne pas faire de cette garde un outil de cartographie interne).
const HINT_OPERATOR =
  'Si ce serveur interne est voulu, l’exploitant doit l’autoriser explicitement (GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS).';
const MSG = {
  empty: 'Nom de serveur manquant ou trop long.',
  chars:
    'Nom de serveur invalide : espaces, accents ou caractères spéciaux interdits (utilisez la forme punycode pour un nom accentué).',
  userinfo:
    'Nom de serveur invalide : n’y mettez pas d’identifiant (« utilisateur@ ») ; ils se saisissent dans les champs prévus.',
  path: 'Nom de serveur invalide : indiquez seulement le nom du serveur, sans « https:// » ni chemin.',
  port: 'Nom de serveur invalide : n’y mettez pas de port, il se règle dans un champ séparé.',
  syntax: 'Nom de serveur invalide.',
  badIp: 'Adresse IP invalide.',
  nonStandard:
    'Adresse IP en notation inhabituelle : saisissez-la sous la forme a.b.c.d, ou indiquez un nom de serveur.',
  blockedName: `Ce nom désigne un serveur du réseau interne : il est refusé par sécurité. ${HINT_OPERATOR}`,
  blockedAddress: `Ce serveur correspond à une adresse interne ou réservée : il est refusé par sécurité. ${HINT_OPERATOR}`,
  unresolved: 'Serveur introuvable : vérifiez le nom saisi.',
} as const;

export interface SsrfOptions {
  /** Résolveur DNS injectable (tests). Défaut : `dns.promises.lookup({ all: true })`. */
  resolve?: (host: string) => Promise<string[]>;
  /** Liste blanche explicite (hôtes exacts ou CIDR) pour un serveur interne voulu ; défaut env GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS. */
  allowInternal?: string[];
}

/**
 * Lève `SsrfError` si l'hôte (nom ou IP littérale) résout vers une adresse interne/réservée.
 * Renvoie les adresses vérifiées (au moins une), à utiliser telles quelles pour se connecter.
 *
 * Liste blanche : un NOM listé autorise ce nom exact (pas ses sous-domaines) quelles que soient
 * ses adresses ; une IP/CIDR listée autorise les adresses qu'elle couvre, pour n'importe quel nom.
 * Ne sont jamais autorisées : 0.0.0.0/8, ::, multicast, diffusion, métadonnées cloud.
 */
export async function assertPublicHost(host: string, opts?: SsrfOptions): Promise<string[]> {
  const rules = compileAllowRules(
    opts?.allowInternal ?? parseAllowList(process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS),
  );
  const resolve = opts?.resolve ?? defaultResolve;

  if (typeof host !== 'string' || host.length === 0 || host.length > 255) {
    throw new SsrfError(MSG.empty, 'invalid_host');
  }
  // ASCII imprimable uniquement : refuse espaces, caractères de contrôle et Unicode. Les chiffres
  // pleine chasse (« １２７.０.０.１ ») ou les points idéographiques sont normalisés en 127.0.0.1 par
  // certaines bibliothèques (IDNA) — mieux vaut ne pas leur laisser l'occasion.
  if (/[^\x21-\x7e]/.test(host)) throw new SsrfError(MSG.chars, 'invalid_host');
  if (host.includes('@')) throw new SsrfError(MSG.userinfo, 'invalid_host');
  if (/[/\\?#]/.test(host)) throw new SsrfError(MSG.path, 'invalid_host');

  const lower = host.toLowerCase();

  // IPv6 littérale, avec ou sans crochets, éventuellement avec zone (`%eth0`).
  if (lower.startsWith('[') || lower.includes(':')) {
    let inner = lower;
    if (lower.startsWith('[')) {
      if (!lower.endsWith(']')) throw new SsrfError(MSG.port, 'invalid_host');
      inner = lower.slice(1, -1);
    }
    const pct = inner.indexOf('%');
    const addr = pct >= 0 ? inner.slice(0, pct) : inner;
    const v6 = parseIpv6(addr);
    if (!v6) throw new SsrfError(MSG.port, 'invalid_host');
    const parsed: ParsedIp = { family: 6, v6 };
    if (isNeverAllowed(parsed)) throw new SsrfError(MSG.blockedAddress, 'blocked_address');
    // Une zone n'a de sens que pour une adresse de lien local : jamais pour un serveur distant.
    if (pct >= 0) {
      throw isBlockedV6(v6)
        ? new SsrfError(MSG.blockedAddress, 'blocked_address')
        : new SsrfError(MSG.syntax, 'invalid_host');
    }
    if (isBlockedV6(v6) && !isAddressAllowed(parsed, rules)) {
      throw new SsrfError(MSG.blockedAddress, 'blocked_address');
    }
    return [addr];
  }

  // Un seul point final est la forme absolue d'un nom DNS (`example.com.`) : légitime.
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  if (name.length === 0 || name.length > 253) throw new SsrfError(MSG.empty, 'invalid_host');
  const labels = name.split('.');
  if (labels.some((l) => l.length === 0 || l.length > 63))
    throw new SsrfError(MSG.syntax, 'invalid_host');

  // Dernier label numérique → le système traitera la chaîne comme une IPv4 (règle inet_aton/URL) :
  // on la décode et on la juge comme telle, sans jamais la confier au DNS.
  if (/^(0x[0-9a-f]*|[0-9]+)$/.test(labels[labels.length - 1] as string)) {
    const v4 = parseIpv4Loose(name);
    if (!v4) throw new SsrfError(MSG.badIp, 'invalid_host');
    const parsed: ParsedIp = { family: 4, v4: v4.value };
    if (isNeverAllowed(parsed)) throw new SsrfError(MSG.blockedAddress, 'blocked_address');
    if (isBlockedV4(v4.value) && !isAddressAllowed(parsed, rules)) {
      throw new SsrfError(MSG.blockedAddress, 'blocked_address');
    }
    if (!v4.canonical) throw new SsrfError(MSG.nonStandard, 'non_standard_ip');
    return [formatIpv4(v4.value)];
  }

  if (!labels.every((l) => LABEL_REGEX.test(l))) throw new SsrfError(MSG.syntax, 'invalid_host');

  const nameAllowed = rules.some((r) => r.kind === 'name' && r.name === name);
  if (!nameAllowed && isBlockedName(name, labels)) {
    throw new SsrfError(MSG.blockedName, 'blocked_name');
  }

  let resolved: unknown;
  try {
    resolved = await withTimeout(resolve(name), DNS_TIMEOUT_MS);
  } catch {
    // Le message du résolveur (ENOTFOUND, serveur DNS interne…) n'est pas recopié.
    throw new SsrfError(MSG.unresolved, 'unresolved');
  }
  if (!Array.isArray(resolved)) throw new SsrfError(MSG.unresolved, 'unresolved');
  const unique = [
    ...new Set(resolved.map((a) => (typeof a === 'string' ? a.trim().toLowerCase() : ''))),
  ];
  if (unique.length === 0) throw new SsrfError(MSG.unresolved, 'unresolved');

  // UNE seule adresse interne suffit à refuser : le client réseau peut choisir n'importe laquelle,
  // et un DNS piégé peut mêler une adresse publique (pour passer) et une interne (pour attaquer).
  for (const addr of unique) {
    const parsed = parseIp(addr);
    if (!parsed || isNeverAllowed(parsed))
      throw new SsrfError(MSG.blockedAddress, 'blocked_address');
    const blocked = parsed.family === 4 ? isBlockedV4(parsed.v4) : isBlockedV6(parsed.v6);
    if (blocked && !nameAllowed && !isAddressAllowed(parsed, rules)) {
      throw new SsrfError(MSG.blockedAddress, 'blocked_address');
    }
  }
  return unique;
}
