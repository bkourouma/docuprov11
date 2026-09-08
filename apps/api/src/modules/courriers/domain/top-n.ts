/**
 * Regroupement Top-N des répartitions (KPI A2/A3, F1–F4) — reprise du motif déjà en place dans
 * `apps/api/src/modules/analytics/analytics.service.ts` : le SQL renvoie **tout**, trié ; c'est le
 * TypeScript qui coupe, agrège le reste dans « Autres » et épingle la tranche `NULL` en dernier.
 *
 * Deux règles qui ne sont pas cosmétiques :
 *
 *  1. **La tranche `NULL` ne concourt pas au Top-N** et n'est jamais fondue dans « Autres ».
 *     « Non rattaché » (courriers sans organigramme, §2.2) ou « Sans type » est une information
 *     en soi, souvent la plus actionnable de la liste. La noyer reviendrait à masquer un défaut
 *     de saisie derrière un agrégat.
 *  2. **Le total est conservé.** La somme des tranches rendues égale la somme des lignes reçues,
 *     sinon le camembert ne réconcilie pas avec le compteur affiché juste à côté.
 */
export interface TrancheBrute {
  /** `null` = valeur non renseignée en base (FK nullable). */
  cle: string | null;
  valeur: number;
}

export interface Tranche {
  label: string;
  valeur: number;
}

export interface OptionsTopN {
  /** Nombre de tranches nommées conservées (hors « Autres » et hors tranche nulle). Défaut 8. */
  limite?: number;
  /** Libellé de la tranche `NULL`. Le format « — … — » suit la convention du dashboard existant. */
  labelNull?: string;
  labelAutres?: string;
}

export function regrouperTopN(rows: readonly TrancheBrute[], options: OptionsTopN = {}): Tranche[] {
  const { limite = 8, labelNull = '— Non renseigné —', labelAutres = 'Autres' } = options;

  const nulles = rows.filter((r) => r.cle === null);
  const nommees = rows
    .filter((r) => r.cle !== null)
    .slice()
    .sort((a, b) => b.valeur - a.valeur);

  const tete = nommees.slice(0, limite).map((r) => ({ label: r.cle as string, valeur: r.valeur }));
  const reste = somme(nommees.slice(limite));
  const totalNull = somme(nulles);

  const resultat: Tranche[] = [...tete];
  if (reste > 0) resultat.push({ label: labelAutres, valeur: reste });
  // Épinglée en dernier, quelle que soit sa valeur relative.
  if (totalNull > 0) resultat.push({ label: labelNull, valeur: totalNull });

  return resultat;
}

function somme(rows: readonly TrancheBrute[]): number {
  return rows.reduce((acc, r) => acc + r.valeur, 0);
}
