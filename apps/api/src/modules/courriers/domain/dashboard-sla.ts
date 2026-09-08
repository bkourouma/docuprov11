import { MailType } from '@archivage/types';

/**
 * Évaluation du respect des délais (KPI C4), à partir des durées de suivi portées par l'objet type
 * (`mail_objet.duree_suivi_externe` / `duree_suivi_interne`, en **jours**).
 *
 * ⚠️ Ces deux colonnes sont **configurables mais inertes** : vérifié par recherche exhaustive dans
 * le dépôt, aucun calcul métier ne les lit aujourd'hui (elles ne sont que créées/éditées par le
 * CRUD du référentiel). Le tableau de bord en est le **premier consommateur** — c'est ce qui fait
 * passer les KPI du descriptif (« combien de temps ») au qualitatif (« dans les délais ou non »),
 * sans ajouter une seule colonne en base.
 *
 * ⚠️ Corollaire : la valeur par défaut est `0`. Traiter `0` comme une échéance immédiate
 * classerait **tout** en hors-délai et produirait un indicateur catastrophiste et faux. `0` et
 * `null` signifient donc « non configuré », et l'objet est **exclu** du calcul, pas compté en échec.
 */
export interface EvaluationSla {
  /** `false` = aucune durée exploitable pour ce courrier ⟹ il ne compte NI en succès NI en échec. */
  configure: boolean;
  /** `null` quand `configure` est faux, ou quand le délai n'est pas mesurable (non archivé). */
  dansLesDelais: boolean | null;
  /** Durée de référence retenue, en jours. `null` si non configurée. */
  dureeRetenue: number | null;
}

/**
 * Choix de la durée applicable selon le type de courrier.
 *
 * ⚠️ **Interprétation à valider par le métier** (arbitrage §1.3-3 du plan) : le référentiel
 * distingue « suivi externe » et « suivi interne » sans que le code source n'indique lequel
 * s'applique à quel type. Retenu ici : un courrier **Interne** relève du suivi interne, une
 * **Arrivée** ou un **Départ** (qui impliquent un correspondant externe) du suivi externe.
 * Cette règle est isolée dans une fonction dédiée pour qu'un changement d'avis soit un
 * one-liner testé, et non une chasse au `CASE` dans les requêtes SQL.
 */
export function dureeApplicable(
  mailType: MailType,
  dureeExterne: number | null,
  dureeInterne: number | null,
): number | null {
  const duree = mailType === MailType.Interne ? dureeInterne : dureeExterne;
  // `0` = valeur par défaut du référentiel = non configuré (et non « échéance immédiate »).
  return duree != null && duree > 0 ? duree : null;
}

/**
 * Le courrier a-t-il été traité dans les délais ?
 *
 * @param delaiJours délai de traitement réel (KPI C3), `null` si le courrier n'est pas archivé.
 */
export function evalSla(
  delaiJours: number | null,
  mailType: MailType,
  dureeExterne: number | null,
  dureeInterne: number | null,
): EvaluationSla {
  const dureeRetenue = dureeApplicable(mailType, dureeExterne, dureeInterne);
  if (dureeRetenue === null) return { configure: false, dansLesDelais: null, dureeRetenue: null };
  if (delaiJours === null) return { configure: true, dansLesDelais: null, dureeRetenue };
  // Le jour de l'échéance est encore « dans les délais » (<=), comme le compte à rebours des rappels.
  return { configure: true, dansLesDelais: delaiJours <= dureeRetenue, dureeRetenue };
}

/**
 * Agrégat servi au widget SLA. `configure` reste faux tant qu'aucun courrier de l'échantillon n'a
 * de durée exploitable : l'écran affiche alors « SLA non configuré » avec un lien vers le KPI
 * d'hygiène G4, au lieu d'un graphique vide qui laisserait croire à une absence de données.
 */
export interface SyntheseSla {
  configure: boolean;
  dansLesDelais: number;
  horsDelais: number;
  /** Courriers écartés faute de durée configurée — rend l'angle mort visible plutôt que muet. */
  nonEvalues: number;
}

export function agregerSla(evaluations: readonly EvaluationSla[]): SyntheseSla {
  let dansLesDelais = 0;
  let horsDelais = 0;
  let nonEvalues = 0;

  for (const e of evaluations) {
    if (!e.configure || e.dansLesDelais === null) nonEvalues += 1;
    else if (e.dansLesDelais) dansLesDelais += 1;
    else horsDelais += 1;
  }

  return { configure: dansLesDelais + horsDelais > 0, dansLesDelais, horsDelais, nonEvalues };
}
