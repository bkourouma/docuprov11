// Règles de rappel (§03.5) — logique pure, sans I/O : c'est ici que vit la fidélité au source,
// et c'est ce que couvrent les tests. Les processors ne font que lire/écrire autour.

// Paliers et calcul de jours : définis dans `@archivage/types`, car l'INTERFACE affiche le même
// palier au même moment (bandeau d'alerte sur le détail du courrier). Deux copies dériveraient,
// et l'écran annoncerait « dans 3 jours » quand l'e-mail dit « dernière chance ».
export {
  dateButoireAlert,
  daysUntilDeadline as daysUntil,
  type DateButoireAlert,
} from '@archivage/types';
import type { DateButoireAlert } from '@archivage/types';

/** Libellé de notification d'échéance courrier, par palier. */
export function dateButoireMessage(alert: DateButoireAlert, title: string): string {
  const prefix: Record<DateButoireAlert, string> = {
    PREMIERE_ALERTE: 'Première alerte — échéance dans 7 jours',
    RAPPEL: 'Rappel — échéance dans 3 jours',
    DERNIERE_CHANCE: 'Dernière chance — échéance demain',
    URGENCE: "Urgence — échéance aujourd'hui",
    RETARD: 'Retard — échéance dépassée',
  };
  return `${prefix[alert]} : ${title}`;
}

/**
 * Une imputation est-elle à relancer ? (§03.5, `MailInputationReminderService`)
 * - échéance dans la fenêtre d'alerte (`delaisAlerteHours`, défaut 48 h) ET pas encore passée ;
 * - jamais relancée, ou dernière relance plus vieille que l'intervalle (`intervalHours`, défaut 6 h).
 * Le filtre « non traitée » est appliqué par la requête, pas ici.
 */
export function shouldRemindInputation(
  input: { deadline: Date | null; lastReminderSent: Date | null },
  now: Date,
  delaisAlerteHours: number,
  intervalHours: number,
): boolean {
  if (!input.deadline) return false;
  // `Deadline >= now` : le source cesse de relancer une imputation déjà en retard.
  if (input.deadline.getTime() < now.getTime()) return false;
  const windowEnd = now.getTime() + delaisAlerteHours * 3_600_000;
  if (input.deadline.getTime() > windowEnd) return false;
  if (!input.lastReminderSent) return true;
  return now.getTime() - input.lastReminderSent.getTime() >= intervalHours * 3_600_000;
}

/** Libellé de notification d'échéance d'imputation. */
export function inputationReminderMessage(title: string, deadline: Date): string {
  const when = deadline.toISOString().slice(0, 16).replace('T', ' ');
  return `Échéance d'imputation le ${when} (UTC) : ${title}`;
}
