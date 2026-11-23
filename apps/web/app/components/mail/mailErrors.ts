/**
 * Messages d'erreur lisibles du module courriers. Logique pure (sans React ni antd) : testée par
 * `mailErrors.test.ts` (`npx tsx --test`).
 */

/**
 * Libellés des statuts que `apiJson` remonte SANS message serveur exploitable (« HTTP 400 ») :
 * c'est le cas des refus de validation de schéma, dont le message est une LISTE et non un texte.
 * Afficher « HTTP 400 » à l'agent ne lui dit ni ce qui est refusé, ni quoi corriger.
 */
const STATUS_LABELS: Record<number, string> = {
  400: 'Saisie refusée par le serveur : vérifiez les champs du formulaire.',
  401: 'Session expirée : reconnectez-vous.',
  403: 'Action non autorisée pour votre profil.',
  404: 'Élément introuvable : il a peut-être été supprimé entre-temps.',
  409: 'Conflit : l’élément a été modifié entre-temps, rechargez la page.',
  413: 'Fichier trop volumineux.',
};

/**
 * Message à afficher pour une erreur d'appel API. Le message du serveur est conservé tel quel
 * quand il existe (« Courrier lié introuvable ») ; seul le repli technique « HTTP nnn » est traduit.
 */
export function readableApiError(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback;
  const msg = e.message.trim();
  if (!msg) return fallback;
  const http = /^HTTP (\d{3})$/.exec(msg);
  if (!http) return msg;
  const status = Number(http[1]);
  const label = STATUS_LABELS[status];
  if (label) return label;
  if (status >= 500) return 'Erreur du serveur : réessayez dans un instant.';
  return fallback;
}

/** Bilan d'une création d'imputations en lot (un appel par destinataire). */
export interface ImputationBatchOutcome {
  /** Nombre d'imputations réellement créées. */
  created: number;
  /** Destinataires (`userGroupId`) dont l'imputation a échoué — à garder dans le formulaire. */
  failedIds: number[];
  /** Raisons d'échec distinctes, dans l'ordre d'apparition. */
  reasons: string[];
}

/**
 * Résume un `Promise.allSettled` aligné sur `ids` (même ordre). Une longueur différente est une
 * erreur de programmation : on la signale plutôt que d'attribuer un échec au mauvais destinataire.
 */
export function summarizeImputations(
  ids: readonly number[],
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
): ImputationBatchOutcome {
  if (ids.length !== results.length) {
    throw new Error('summarizeImputations : résultats non alignés sur les destinataires');
  }
  const failedIds: number[] = [];
  const reasons: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') return;
    failedIds.push(ids[i] as number); // longueurs vérifiées ci-dessus : l'index existe
    const reason = readableApiError(r.reason, 'Création impossible');
    if (!reasons.includes(reason)) reasons.push(reason);
  });
  return { created: results.length - failedIds.length, failedIds, reasons };
}

/**
 * Message de bilan. `null` quand tout a réussi (le message de succès habituel s'applique) ;
 * sinon le niveau (`warning` si une partie a été créée, `error` si rien ne l'a été) et le texte.
 */
export function imputationOutcomeMessage(
  o: ImputationBatchOutcome,
): { level: 'warning' | 'error'; text: string } | null {
  if (o.failedIds.length === 0) return null;
  const reason = o.reasons.join(' ; ');
  if (o.created === 0) {
    return {
      level: 'error',
      text:
        o.failedIds.length > 1
          ? `Aucune imputation créée, ${o.failedIds.length} en échec : ${reason}`
          : `Imputation non créée : ${reason}`,
    };
  }
  return {
    level: 'warning',
    text: `${o.created} imputation(s) créée(s), ${o.failedIds.length} en échec : ${reason}`,
  };
}
