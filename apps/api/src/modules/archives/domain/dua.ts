// Domaine PUR du cycle de vie documentaire (DUA / conformité) — aucune dépendance NestJS/Prisma.
//
// Une règle de cycle de vie (`document_type_life_cycle`) exprime des DURÉES en mois ; un document
// porte des DATES d'échéance (`document_life_cycle`). Ce module fait le pont entre les deux, et
// c'est le seul endroit où l'arithmétique est écrite côté TypeScript.
//
// ⚠ La requête paginée de l'écran « DUA Expirés » calcule les mêmes échéances EN SQL
// (`+ make_interval(months => …)`, cf. archives-compliance.service.ts) pour rester paginable sur
// une grande archive. Les deux doivent donner le même résultat : `addMonths` ci-dessous reproduit
// donc exactement la sémantique de Postgres, y compris son écrêtage de fin de mois.

/**
 * Date + N mois, avec l'ÉCRÊTAGE de Postgres : le 31 janvier + 1 mois donne le 28 (ou 29) février,
 * jamais le 3 mars. `Date.setMonth()` de JavaScript déborde au contraire sur le mois suivant —
 * d'où le calcul explicite plutôt qu'un `setMonth` naïf.
 *
 * Travaille en UTC : les dates d'échéance sont des dates civiles (`DATE` en base), pas des
 * instants ; passer par le fuseau local décalerait l'échéance d'un jour à l'ouest de Greenwich.
 */
export function addMonths(base: Date, months: number): Date {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + months;
  const day = base.getUTCDate();
  // Jour 0 du mois suivant = dernier jour du mois visé.
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDayOfTarget)));
}

/** Règle de conservation d'un type de document, en mois. */
export interface LifeCycleRule {
  usefulnessLifespan: number; // DUA
  complianceLifespan: number;
}

/** Échéances calculées pour un document. */
export interface LifeCycleDueDates {
  usefulnessLifespan: Date;
  complianceLifespan: Date;
}

/**
 * Point de départ du décompte : la date métier du document, à défaut sa date de création.
 * Un document sans date métier (indexation incomplète) ne doit pas échapper au cycle de vie —
 * le source retombait déjà sur la date d'enregistrement.
 */
export function lifeCycleStartDate(doc: {
  documentDate: Date | null;
  createdAt: Date;
}): Date {
  const base = doc.documentDate ?? doc.createdAt;
  // Normalise à une date civile UTC : `created_at` est un timestamptz, l'échéance une date.
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
}

/** Échéances d'un document à partir de la règle de son type. */
export function computeDueDates(startDate: Date, rule: LifeCycleRule): LifeCycleDueDates {
  return {
    usefulnessLifespan: addMonths(startDate, rule.usefulnessLifespan),
    complianceLifespan: addMonths(startDate, rule.complianceLifespan),
  };
}

/**
 * L'échéance est-elle atteinte à la date d'observation ? Comparaison INCLUSIVE : une DUA qui
 * tombe aujourd'hui est expirée aujourd'hui, pas demain (c'est ce que fait le `<=` du source).
 */
export function isExpired(dueDate: Date, asOf: Date): boolean {
  return dueDate.getTime() <= asOf.getTime();
}

/**
 * Date de coupure de l'écran « DUA Expirés ». `monthsAhead` ouvre une fenêtre d'anticipation
 * (le source raisonnait sur une fenêtre de `Mois` mois) : à 0 on ne voit que l'échu, à 3 on voit
 * aussi ce qui échoit dans le trimestre — de quoi préparer une campagne d'épuration.
 */
export function expiryCutoff(asOf: Date, monthsAhead: number): Date {
  const today = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  return monthsAhead > 0 ? addMonths(today, monthsAhead) : today;
}

/** Date civile `AAAA-MM-JJ` — format d'échange des échéances avec le client. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
