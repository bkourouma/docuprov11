/**
 * Variation d'un indicateur entre la période courante et la précédente (zone 3 « chiffres clés »).
 *
 * Le piège ici n'est pas la formule, c'est le **zéro au dénominateur**. Passer de 0 à 12 courriers
 * n'est pas « +∞ % » ni « +1200 % » : c'est une apparition, qui n'a pas de taux de variation.
 * On renvoie donc `null`, et l'écran affiche « — » plutôt qu'un pourcentage absurde.
 */
export interface Variation {
  valeur: number;
  precedent: number | null;
  /** Ratio signé (0.25 = +25 %). `null` quand la variation n'a pas de sens mathématique. */
  ratio: number | null;
  sens: 'hausse' | 'baisse' | 'stable' | 'indetermine';
}

export function variation(valeur: number, precedent: number | null): Variation {
  if (precedent === null || precedent === 0) {
    return { valeur, precedent, ratio: null, sens: 'indetermine' };
  }

  const ratio = (valeur - precedent) / precedent;
  const sens = ratio > 0 ? 'hausse' : ratio < 0 ? 'baisse' : 'stable';
  return { valeur, precedent, ratio, sens };
}

/**
 * Période immédiatement antérieure, de **même durée**, servant de base de comparaison.
 * Bornes en jours civils UTC ; `finPrecedente` est le jour précédant `debut` (pas de recouvrement,
 * pas de trou), et la durée est conservée à la journée près.
 */
export function periodePrecedente(debut: Date, fin: Date): { debut: Date; fin: Date } {
  const dureeMs = fin.getTime() - debut.getTime();
  const finPrecedente = new Date(debut.getTime() - 86_400_000);
  return { debut: new Date(finPrecedente.getTime() - dureeMs), fin: finPrecedente };
}
