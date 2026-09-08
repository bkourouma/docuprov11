import { MailType } from '@archivage/types';

/**
 * Date d'archivage d'un courrier (§3.7 du dossier de conception) — sémantique héritée du source
 * (`MailStats.cs:2676,2683`) : **elle diffère selon le type**.
 *
 *   Départ            → `dateDecharge`
 *   Arrivée / Interne → `dateTraited`
 *
 * Cette bifurcation n'est pas un détail : `dateDecharge` est écrite sur un Départ dès son passage
 * à « Rédigé » (quirk §3.1, cf. `markDepartRedige` dans `mail-status.ts`), si bien qu'un Départ
 * possède une date d'archivage alors même qu'il n'a jamais été déchargé. C'est voulu.
 *
 * Toute agrégation « archivés sur la période » qui utiliserait `dateTraited` seule **perdrait la
 * totalité des Départs**. On isole donc la règle ici, testée, plutôt que de la dupliquer dans
 * chaque requête SQL (où elle s'écrit `CASE WHEN m.mail_type = 1 THEN m.date_decharge ELSE
 * m.date_traited END`).
 */
export function dateArchivage(
  mailType: MailType,
  dateDecharge: Date | null,
  dateTraited: Date | null,
): Date | null {
  return mailType === MailType.Depart ? dateDecharge : dateTraited;
}

/**
 * Un courrier est-il archivé ? Corollaire direct de `dateArchivage` — utilisé par les KPI de stock
 * (A4 « en cours ») autant que de flux (A5 « archivés sur P »).
 */
export function estArchive(
  mailType: MailType,
  dateDecharge: Date | null,
  dateTraited: Date | null,
): boolean {
  return dateArchivage(mailType, dateDecharge, dateTraited) !== null;
}

/**
 * Délai de traitement global en jours (KPI C3) : de la prise en charge au bureau d'ordre jusqu'à
 * l'archivage. `null` dès qu'une des deux bornes manque — un délai partiel serait un chiffre faux.
 *
 * Le résultat peut être négatif si les données sont incohérentes (archivage antérieur à
 * l'enregistrement) ; on ne le corrige pas ici : c'est au KPI d'hygiène de le signaler, pas au
 * calcul de le masquer.
 */
export function delaiTraitementJours(
  dateEnregistrement: Date | null,
  dateArchivageCourrier: Date | null,
): number | null {
  if (!dateEnregistrement || !dateArchivageCourrier) return null;
  return joursEntre(dateEnregistrement, dateArchivageCourrier);
}

/**
 * Écart en jours calendaires entre deux instants, à la journée — même convention que
 * `daysUntil()` du worker (`apps/worker/src/domain/mail-reminders.ts`) : on compare des dates
 * civiles UTC, pour que l'heure de la journée ne décale pas un palier.
 */
export function joursEntre(debut: Date, fin: Date): number {
  const d = Date.UTC(debut.getUTCFullYear(), debut.getUTCMonth(), debut.getUTCDate());
  const f = Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth(), fin.getUTCDate());
  return Math.round((f - d) / 86_400_000);
}
