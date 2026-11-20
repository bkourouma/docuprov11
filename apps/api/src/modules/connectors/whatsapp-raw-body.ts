// Lot 2c — corps BRUT du webhook WhatsApp (Meta), lu avant les parseurs de Nest.
//
// Pourquoi : la signature `X-Hub-Signature-256` est un HMAC des OCTETS EXACTS envoyés par Meta. Un
// corps déjà analysé puis re-sérialisé (`JSON.stringify(req.body)`) ne redonne pas ces octets
// (espaces, échappements `é`, ordre des clés) : la signature serait invérifiable, ou pire,
// vérifiée sur autre chose que ce qui a été reçu. Et aucun JSON ne doit être analysé avant que la
// signature ne soit établie.
//
// Comment : `configureWhatsappRawBody(app)` monte, AVANT `app.init()` (donc avant les parseurs JSON
// et urlencoded que Nest enregistre à l'initialisation), un petit lecteur de flux plafonné sur le
// seul préfixe du webhook. Il pose `req.body` (Buffer) et `req._body = true`. Les parseurs de Nest
// (body-parser 2) ignorent ensuite la requête car son flux est entièrement consommé
// (`onFinished.isFinished(req)`) ; body-parser 1 l'ignorait sur `req._body`. Le test
// `whatsapp-raw-body.spec.ts` le vérifie sur une vraie application Nest initialisée.
//
// Pas de `express.raw` : `express` et `body-parser` ne sont pas des dépendances directes de l'API
// (seulement transitives via `@nestjs/platform-express`) et on ne touche ni au package.json ni au
// lockfile. Ce lecteur fait d'ailleurs moins : pas de décompression (`Content-Encoding` autre que
// `identity` refusé : la signature porte sur les octets reçus, et pas de bombe de décompression),
// pas de jeu de caractères, pas d'analyse.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WHATSAPP_MAX_BODY_BYTES } from '@archivage/connectors';

/** Route du contrôleur, relative au préfixe global `api`. */
export const WHATSAPP_WEBHOOK_ROUTE = 'ged/webhooks/whatsapp';
/** Préfixe HTTP complet (préfixe global inclus) : cf. `gedWhatsappWebhookPath` de @archivage/types. */
export const WHATSAPP_WEBHOOK_BASE_PATH = `/api/${WHATSAPP_WEBHOOK_ROUTE}`;

/**
 * Après un refus (413, 415), le reste du corps est lu et jeté avant de répondre, pour que le client
 * reçoive la réponse au lieu d'une connexion coupée en pleine écriture. Au-delà de cette quantité,
 * on cesse de lire : réponse avec `Connection: close`.
 */
const MAX_DRAIN_BYTES = 1024 * 1024;

type RawBodyRequest = IncomingMessage & { body?: unknown; _body?: boolean };
type Next = (err?: unknown) => void;

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
};

/** Même forme que `AllExceptionsFilter` (`{ code, message }`), sans aucun détail sur la requête. */
function sendError(res: ServerResponse, status: number, close: boolean): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify({ code: status, message: STATUS_TEXT[status] ?? 'Error' });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', 'no-store');
  if (close) res.setHeader('Connection', 'close');
  res.end(body);
}

/** Même règle que `type-is` (`hasBody`) : un corps existe si l'un de ces en-têtes est présent. */
function hasBody(req: IncomingMessage): boolean {
  return req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined;
}

/** Lit et jette le reste du flux (plafonné), puis répond `status`. */
function drainThenReject(req: IncomingMessage, res: ServerResponse, status: number): void {
  if (req.readableEnded) {
    sendError(res, status, false);
    return;
  }
  let discarded = 0;
  const cleanup = (): void => {
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onGone);
    req.off('aborted', onGone);
  };
  const onData = (chunk: Buffer): void => {
    discarded += chunk.length;
    if (discarded > MAX_DRAIN_BYTES) {
      cleanup();
      req.pause();
      sendError(res, status, true);
    }
  };
  const onEnd = (): void => {
    cleanup();
    sendError(res, status, false);
  };
  const onGone = (): void => {
    cleanup();
  };
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onGone);
  req.on('aborted', onGone);
  req.resume();
}

/**
 * Middleware de lecture du corps brut, plafonné à `limit` octets (défaut
 * `WHATSAPP_MAX_BODY_BYTES`, 256 Kio) : 413 au-delà, 415 si le corps est compressé, 400 si le flux
 * est interrompu. Le contenu n'est ni décodé, ni analysé, ni journalisé.
 */
export function createWhatsappRawBodyMiddleware(
  limit: number = WHATSAPP_MAX_BODY_BYTES,
): (req: RawBodyRequest, res: ServerResponse, next: Next) => void {
  return function whatsappRawBody(req: RawBodyRequest, res: ServerResponse, next: Next): void {
    // Déjà lu par un autre composant : on ne relit pas (le contrôleur exige de toute façon un Buffer).
    if (req._body === true || req.readableEnded) {
      next();
      return;
    }
    if (!hasBody(req)) {
      req.body = Buffer.alloc(0);
      req._body = true;
      next();
      return;
    }
    const encoding = req.headers['content-encoding'];
    if (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity') {
      drainThenReject(req, res, 415);
      return;
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0) {
        drainThenReject(req, res, 400);
        return;
      }
      if (length > limit) {
        drainThenReject(req, res, 413);
        return;
      }
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onBroken);
      req.off('aborted', onBroken);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      received += chunk.length;
      if (received > limit) {
        // Corps sans longueur annoncée (chunked) ou longueur mensongère : on arrête d'accumuler.
        settled = true;
        cleanup();
        chunks.length = 0;
        drainThenReject(req, res, 413);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.body = Buffer.concat(chunks, received);
      req._body = true;
      next();
    };
    const onBroken = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      sendError(res, 400, true);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onBroken);
    req.on('aborted', onBroken);
  };
}

/** Sous-ensemble de `INestApplication` utilisé ici (évite d'imposer le type complet aux tests). */
export interface AppWithUse {
  use(...args: unknown[]): unknown;
}

/**
 * À appeler dans `main.ts` juste après `NestFactory.create`, AVANT `listen`/`init` : Nest
 * n'enregistre ses parseurs qu'à l'initialisation, ce middleware passe donc devant eux.
 */
export function configureWhatsappRawBody(app: AppWithUse, limit: number = WHATSAPP_MAX_BODY_BYTES): void {
  app.use(WHATSAPP_WEBHOOK_BASE_PATH, createWhatsappRawBodyMiddleware(limit));
}
