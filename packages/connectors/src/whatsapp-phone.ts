// Lot 2c — numéros de téléphone WhatsApp : normalisation, principal de droits, pseudonymisation.
// Socle commun du webhook (whatsapp-webhook.ts), des expéditeurs (whatsapp-senders.ts) et du worker.
import { createHmac } from 'node:crypto';
import { GED_WHATSAPP_PRINCIPAL_PREFIX } from '@archivage/types';

/** Numéro international sans `+` : 8 à 15 chiffres, ne commençant pas par 0 (E.164). */
const PHONE_DIGITS = /^[1-9][0-9]{7,14}$/;

/**
 * Normalise un numéro saisi ou reçu : retire espaces, points, tirets, parenthèses et un `+` de tête.
 * Retourne les chiffres seulement, ou `null` si le résultat n'est pas un numéro E.164 plausible.
 * Aucune autre transformation (pas de deviner l'indicatif pays : l'administrateur saisit le numéro complet).
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 40) return null;
  const digits = raw.trim().replace(/^\+/, '').replace(/[\s.\-()]/g, '');
  return PHONE_DIGITS.test(digits) ? digits : null;
}

/** Principal d'un expéditeur dans `rights.principalMap` et dans l'ACL d'origine : `wa:<chiffres>`. */
export function principalForPhone(digits: string): string {
  return `${GED_WHATSAPP_PRINCIPAL_PREFIX}${digits}`;
}

/**
 * Pseudonyme stable d'un numéro pour les journaux : HMAC-SHA256 (clé = secret du connecteur) tronqué à
 * 16 caractères hexadécimaux. Le numéro lui-même ne doit jamais apparaître dans un log.
 */
export function hashPhone(digits: string, key: string): string {
  return createHmac('sha256', key).update(`wa-phone:${digits}`).digest('hex').slice(0, 16);
}
