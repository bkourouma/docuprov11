import { stdSerializers } from 'pino';

/** Préfixe des routes publiques de webhook : jamais de query dans les journaux. */
export const WEBHOOK_PATH_PREFIX = '/api/ged/webhooks/';

/**
 * Vrai si l'URL (relative ou absolue, avec ou sans query) vise une route de webhook : préfixe
 * insensible à la casse, `//` répétés tolérés, schéma+hôte ignorés.
 */
export function isWebhookUrl(url: string | undefined): boolean {
  if (typeof url !== 'string') return false;
  let path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  try {
    path = decodeURIComponent(path);
  } catch {
    /* chemin non décodable : testé tel quel */
  }
  path = path.replace(/\/{2,}/g, '/').toLowerCase();
  return path.startsWith(WEBHOOK_PATH_PREFIX);
}

const SENSITIVE_PARAM = /token|secret|signature|key|password/i;
const MASK = '[masqué]';

/**
 * Nettoie une URL avant journalisation : query supprimée pour les webhooks, sinon valeur masquée
 * pour tout paramètre dont le nom contient token, secret, signature, key ou password.
 */
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (typeof url !== 'string') return url;
  const q = url.indexOf('?');
  if (q === -1) return url;
  const path = url.slice(0, q);
  if (isWebhookUrl(path)) return path;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash === -1 ? undefined : hash);
  const cleaned = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      let name = rawName;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        /* nom non décodable : testé tel quel */
      }
      return SENSITIVE_PARAM.test(name) ? `${rawName}=${MASK}` : pair;
    })
    .join('&');
  return `${path}?${cleaned}`;
}

/** Sérialiseur `req` : sérialiseur standard de pino, URL nettoyée, `query` supprimée. */
export function serializeReq(req: unknown): Record<string, unknown> {
  if (req == null || typeof req !== 'object') return {};
  const out = { ...(stdSerializers.req(req as never) as unknown as Record<string, unknown>) };
  out.url = sanitizeUrl(out.url as string | undefined);
  delete out.query;
  return out;
}

/** Configuration pino-http partagée (sans transport : ajouté par l'application). */
export const pinoHttpOptions = {
  // Le webhook WhatsApp porte la signature (en-tête) et le verify token (query du GET) : pas de
  // journal de requête pour ce préfixe ; `serializers.req` protège aussi les journaux applicatifs
  // émis pendant la requête (pino-http crée `req.log` avant `autoLogging.ignore`).
  autoLogging: {
    ignore: (req: { url?: string }) => isWebhookUrl(req.url),
  },
  serializers: { req: serializeReq },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-hub-signature-256"]',
      'req.headers["x-api-key"]',
    ],
    censor: MASK,
  },
};
