import { MailStatus } from '@archivage/types';

/**
 * Machine à états du courrier (§03.1). L'état n'est pas porté par un seul champ : `status`
 * (MailStatus) bifurque selon MailType et se combine aux drapeaux + dates. Ces fonctions PURES
 * reproduisent fidèlement les deux surcharges de `UpdateMailStatus` de la source, dont l'effet
 * sur les dates diffère (récapitulatif §03.1) :
 *
 *   UpdateMailStatus(status)              → status ; DateTraited=now SI Traité ; DateDecharge=now SI Déchargé
 *   UpdateMailStatus(status, dateDecharge)→ status ; DateDecharge=dateDecharge (TOUJOURS) ; DateTraited inchangé
 *
 * Le patch retourné ne contient que les colonnes à écrire (les champs absents restent inchangés).
 */
export interface MailStatusPatch {
  status: MailStatus;
  dateTraited?: Date;
  dateDecharge?: Date;
}

/**
 * Surcharge 2 arguments (§03.1, MailsAppService.cs:1178). Stampe DateTraited au passage Traité
 * et DateDecharge au passage Déchargé.
 */
export function statusTransition(status: MailStatus, now: Date): MailStatusPatch {
  const patch: MailStatusPatch = { status };
  if (status === MailStatus.Traite) patch.dateTraited = now;
  if (status === MailStatus.Decharge) patch.dateDecharge = now;
  return patch;
}

/**
 * Surcharge 3 arguments (§03.1, MailsAppService.cs:1158). Force DateDecharge quel que soit le
 * statut, sans toucher DateTraited. Utilisée pour le Départ, dont DateDecharge sert de date
 * d'archivage (§03.3) — ce n'est donc pas un bug mais un effet voulu pour ce flux (quirk §03.6-1).
 */
export function statusTransitionWithDecharge(
  status: MailStatus,
  dateDecharge: Date,
): MailStatusPatch {
  return { status, dateDecharge };
}

/** « Marquer traité » (parapheur §08 / auto-validation) : Traité + DateTraited. */
export function markTraite(now: Date): MailStatusPatch {
  return statusTransition(MailStatus.Traite, now);
}

/** Intégration de la décharge signée (§13) : Déchargé + DateDecharge (suivi d'un archivage → DateTraited). */
export function markDecharge(now: Date): MailStatusPatch {
  return statusTransition(MailStatus.Decharge, now);
}

/** Création / greffe d'un courrier Départ (§12) : Rédigé + DateDecharge (= date d'archivage du Départ). */
export function markDepartRedige(now: Date): MailStatusPatch {
  return statusTransitionWithDecharge(MailStatus.Redige, now);
}

/**
 * Archivage « service courrier » (§03.1) : positionne uniquement DateTraited, le statut reste
 * inchangé (retire le courrier des files « en cours » filtrées par DateTraited == null).
 */
export function archiveEffect(now: Date): { dateTraited: Date } {
  return { dateTraited: now };
}
