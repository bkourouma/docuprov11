import { markTraite, type MailStatusPatch } from './mail-status';

/** Vue minimale d'une imputation pour les règles de traitement (§03.1/§03.3). */
export interface InputationView {
  mailInputationId: number;
  dateTreated: Date | null;
  /** `MailInputationType.suivi` — déclenche l'auto-traitement à la lecture. */
  suivi: boolean;
}

export interface TreatmentResult {
  /** Ids des imputations à marquer traitées (DateTreated = now). */
  inputationsToTreat: number[];
  /** Vrai si, après ce traitement, toutes les imputations du courrier sont traitées. */
  allTreated: boolean;
  /** Patch de statut à appliquer au courrier si `allTreated` (Traité + DateTraited), sinon null. */
  mailPatch: MailStatusPatch | null;
}

/**
 * Toutes les imputations sont-elles traitées ? (§03.3, CheckAllInputationsProcessedAsync).
 *
 * DÉCISION (« corriger les écarts ») : une liste VIDE renvoie `false` — un courrier sans imputation
 * n'est pas considéré « traité ». Un `.All()` C# renverrait vrai sur l'ensemble vide et pourrait
 * donc auto-clore un courrier non imputé à la simple lecture ; on l'évite ici. À confirmer sur la
 * source si un iso-comportement strict est requis. Le même garde `length > 0` protège
 * `computeAutomaticValidation`.
 */
export function allInputationsProcessed(inputations: readonly InputationView[]): boolean {
  return inputations.length > 0 && inputations.every((i) => i.dateTreated !== null);
}

/**
 * Validation automatique à la lecture (§03.1 / quirk §03.6-2 : le code traite les types dont
 * `suivi == true`, contrairement à son commentaire). Marque traitées les imputations non traitées
 * dont le type a `suivi == true` ; si le courrier devient alors entièrement traité, bascule en Traité.
 */
export function computeAutomaticValidation(
  inputations: readonly InputationView[],
  now: Date,
): TreatmentResult {
  const toTreat = inputations
    .filter((i) => i.dateTreated === null && i.suivi)
    .map((i) => i.mailInputationId);
  const treated = new Set(toTreat);
  const allTreated =
    inputations.length > 0 &&
    inputations.every((i) => i.dateTreated !== null || treated.has(i.mailInputationId));
  return {
    inputationsToTreat: toTreat,
    allTreated,
    mailPatch: allTreated ? markTraite(now) : null,
  };
}

/**
 * « Marquer comme traité » manuel (parapheur §08, MailInputationsAppService.UpdateMailStatus) :
 * traite TOUTES les imputations non traitées puis bascule le courrier en Traité.
 */
export function computeManualTreatment(
  inputations: readonly InputationView[],
  now: Date,
): TreatmentResult {
  const toTreat = inputations.filter((i) => i.dateTreated === null).map((i) => i.mailInputationId);
  return { inputationsToTreat: toTreat, allTreated: true, mailPatch: markTraite(now) };
}
