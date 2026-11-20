import IORedis from 'ioredis';

/** File du pipeline IA (producteur api, consommateur worker) — nom défini dans le contrat partagé. */
export { GED_AI_QUEUE } from '@archivage/types';

/** Must match the API producer (apps/api/.../queue.constants.ts). */
export const ACQUISITION_QUEUE = 'acquisition';

export interface AcquisitionJobData {
  batchId: number;
  reprocess?: boolean;
}

/**
 * Rappels Docu-Courriers (§03.5). Pas de producteur côté API : le worker planifie lui-même ses
 * jobs répétables au démarrage (l'équivalent des `RecurringJob` Hangfire enregistrés au Startup).
 */
export const REMINDERS_QUEUE = 'courriers-reminders';

/** Un job par rappel du §03.5 ; le nom sert aussi d'id de planificateur (upsert idempotent). */
export const REMINDER_JOBS = {
  dateButoire: 'mail-reminder-datebutoire',
  inputationDeadline: 'mail-inputation-reminder-deadline',
} as const;

export type ReminderJobName = (typeof REMINDER_JOBS)[keyof typeof REMINDER_JOBS];

export function createRedis(url: string): IORedis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}
