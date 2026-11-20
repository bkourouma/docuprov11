import { isIP } from 'node:net';

/** Au-delà, l'en-tête `X-Forwarded-For` est ignoré (aucun proxy légitime n'en produit autant). */
const MAX_FORWARDED_FOR_LENGTH = 2048;
/** Nombre maximal de sauts de proxy de confiance accepté en configuration. */
export const MAX_TRUSTED_PROXY_HOPS = 10;

/** Adresse IP normalisée (IPv4 projetée en IPv6 ramenée en IPv4), ou `null` si invalide. */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (isIP(value) === 0) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  return value.toLowerCase();
}

/**
 * `COLLAB_TRUST_PROXY` -> nombre de sauts de proxy de confiance. Vide/absent = 0 (désactivé).
 * Toute valeur qui n'est pas un entier décimal de 0 à `MAX_TRUSTED_PROXY_HOPS` est REFUSÉE
 * (`null`) : l'appelant retombe alors sur 0, le réglage le plus prudent.
 */
export function parseTrustProxy(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null) return 0;
  const text = String(raw).trim();
  if (text === '') return 0;
  if (!/^\d{1,2}$/.test(text)) return null;
  const hops = Number(text);
  return hops <= MAX_TRUSTED_PROXY_HOPS ? hops : null;
}

/**
 * Adresse du client pour les limites par IP.
 *
 * Sans proxy de confiance (`trustProxy` = 0, défaut), seule l'adresse du socket TCP compte :
 * `X-Forwarded-For` est entièrement contrôlé par le client et donc ignoré.
 *
 * Avec `trustProxy` = N, les N derniers sauts (le socket et les proxys qui ont AJOUTÉ leur entrée
 * à droite de la chaîne) sont de confiance : l'adresse retenue est l'entrée à N positions depuis
 * la droite de `X-Forwarded-For`. Ce qu'un client a forgé à GAUCHE n'est jamais lu. Chaîne plus
 * courte que N (requête qui n'a pas traversé les proxys attendus), entrée invalide ou en-tête
 * démesuré : l'en-tête est ignoré, on garde l'adresse du socket.
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy: number,
): string {
  const socketIp = normalizeIp(remoteAddress) ?? remoteAddress ?? 'inconnue';
  if (!(trustProxy > 0) || forwardedFor === undefined) return socketIp;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (header.length === 0 || header.length > MAX_FORWARDED_FOR_LENGTH) return socketIp;
  const chain = header.split(',');
  const index = chain.length - trustProxy;
  if (index < 0) return socketIp;
  return normalizeIp(chain[index]) ?? socketIp;
}
