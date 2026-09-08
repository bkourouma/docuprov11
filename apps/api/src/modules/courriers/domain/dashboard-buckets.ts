/**
 * Regroupements en tranches du tableau de bord (KPI D4 « paliers » et D5 « ancienneté »).
 *
 * ⚠️ Distinction essentielle, source de confusion : les **niveaux de notification** du worker
 * (`apps/worker/src/domain/mail-reminders.ts`, `dateButoireAlert`) sont des **valeurs EXACTES**
 * — 7, 3, 1, 0, -1..-3 — et rien d'autre. Un courrier à 5 jours de son échéance ne déclenche
 * aucune relance, et un courrier à 10 jours de retard non plus (§3.6).
 *
 * Les tranches ci-dessous sont **couvrantes** : tout courrier tombe dans exactement une tranche.
 * C'est précisément l'intérêt du tableau de bord — il rattrape ce que les rappels laissent passer.
 * Ne jamais aligner ces bornes sur les paliers de notification : ce serait reproduire l'angle mort.
 */

/** Convention de signe (identique au SQL `date_butoire - now()`) : **positif = échéance future**. */
export type PalierEcheance = 'retard' | 'aujourd_hui' | 'j1_j3' | 'j4_j7' | 'au_dela';

/**
 * Palier d'échéance d'un courrier non traité (KPI D4).
 *
 * @param joursRestants jours calendaires avant l'échéance. **Positif** = l'échéance est à venir ;
 *                      **négatif** = elle est dépassée. En notation métier, « J-5 » (cinq jours
 *                      restants) correspond donc à la valeur `+5`, et un retard de cinq jours
 *                      à la valeur `-5`.
 */
export function bucketPalier(joursRestants: number): PalierEcheance {
  if (joursRestants < 0) return 'retard';
  if (joursRestants === 0) return 'aujourd_hui';
  if (joursRestants <= 3) return 'j1_j3';
  if (joursRestants <= 7) return 'j4_j7';
  return 'au_dela';
}

export type TrancheAnciennete = 'moins_7' | 'entre_7_15' | 'entre_16_30' | 'plus_30';

/**
 * Ancienneté d'un courrier en cours (KPI D5), en jours depuis son enregistrement.
 *
 * Indépendant de `dateButoire` — et c'est tout son intérêt : un courrier **sans échéance** n'est
 * jamais « en retard » (il est absent de D1), donc rien ne l'empêche de vieillir indéfiniment.
 * D5 est le seul KPI qui le rattrape. À croiser avec G1 (« courriers sans échéance »).
 *
 * Une ancienneté négative (enregistrement dans le futur, donnée incohérente) tombe en `moins_7` :
 * la tranche reste couvrante, et l'anomalie relève de l'hygiène, pas du regroupement.
 */
export function bucketAnciennete(ageJours: number): TrancheAnciennete {
  if (ageJours < 7) return 'moins_7';
  if (ageJours <= 15) return 'entre_7_15';
  if (ageJours <= 30) return 'entre_16_30';
  return 'plus_30';
}

/** Libellés d'affichage — centralisés ici pour que l'API et l'écran ne divergent pas. */
export const PALIER_LABELS: Record<PalierEcheance, string> = {
  retard: 'En retard',
  aujourd_hui: "Échéance aujourd'hui",
  j1_j3: 'Sous 3 jours',
  j4_j7: 'Sous 7 jours',
  au_dela: 'Au-delà de 7 jours',
};

export const ANCIENNETE_LABELS: Record<TrancheAnciennete, string> = {
  moins_7: 'Moins de 7 jours',
  entre_7_15: 'De 7 à 15 jours',
  entre_16_30: 'De 16 à 30 jours',
  plus_30: 'Plus de 30 jours',
};
