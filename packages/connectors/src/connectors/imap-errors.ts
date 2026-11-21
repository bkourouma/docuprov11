import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
} from '../types';

const AUTH_PATTERN = /AUTHENTICATIONFAILED|AUTHENTICATIONEXPIRED|\b535\b|authentication failed|invalid credentials|login failed|AUTHORIZATIONFAILED/i;
const EXPIRED_PATTERN = /AUTHENTICATIONEXPIRED|expired/i;
const QUOTA_PATTERN = /THROTTLED|rate[ -]?limit|too many|\[LIMIT\]|\bETHROTTLE\b|Request is throttled/i;

/** Retire des secrets connus (mot de passe, identifiant) de tout texte avant qu'il ne sorte d'ici. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

function describe(err: unknown): { text: string; code?: string; authFlag: boolean; reset?: number } {
  if (typeof err !== 'object' || err === null) return { text: String(err), authFlag: false };
  const e = err as {
    message?: string;
    code?: string;
    response?: string;
    responseText?: string;
    serverResponseCode?: string;
    authenticationFailed?: boolean;
    throttleReset?: number;
  };
  const text = [e.message, e.response, e.responseText, e.serverResponseCode, e.code]
    .filter((x): x is string => typeof x === 'string')
    .join(' | ');
  return {
    text,
    code: e.code,
    authFlag: e.authenticationFailed === true,
    reset: typeof e.throttleReset === 'number' ? e.throttleReset : undefined,
  };
}

/**
 * Traduit une erreur du client IMAP en erreur typée du cadre. Les erreurs déjà typées passent telles
 * quelles. Les messages produits ne contiennent jamais le mot de passe (ni aucun `secrets` fourni).
 */
export function mapImapError(err: unknown, secrets: readonly string[] = []): Error {
  if (
    err instanceof ConnectorAuthError ||
    err instanceof ConnectorQuotaError ||
    err instanceof ConnectorItemRejectedError
  ) {
    return err;
  }
  const d = describe(err);
  if (d.authFlag || AUTH_PATTERN.test(d.text)) {
    return new ConnectorAuthError(
      EXPIRED_PATTERN.test(d.text)
        ? "L'autorisation d'accès à la boîte IMAP a expiré."
        : 'Authentification IMAP refusée : vérifiez le compte et le mot de passe.',
      EXPIRED_PATTERN.test(d.text),
    );
  }
  if (QUOTA_PATTERN.test(d.text)) {
    return new ConnectorQuotaError(
      'La boîte IMAP limite le débit : la synchronisation reprendra plus tard.',
      d.reset,
    );
  }
  const safe = redactSecrets(d.text || 'erreur inconnue', secrets).slice(0, 300);
  return new Error(`Erreur IMAP : ${safe}`);
}
