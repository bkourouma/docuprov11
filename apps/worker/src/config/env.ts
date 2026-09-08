import { z } from 'zod';

/**
 * Une variable LAISSÉE VIDE dans `.env` vaut « absente » — même règle que côté API, sur le même
 * fichier `.env` : sans cela `MAIL_LOGO_URL=""` ferait échouer `.url()` et le worker refuserait de
 * démarrer, alors que vider une variable est la façon naturelle de désactiver un réglage facultatif.
 */
const emptyAsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

/** Environment contract for the ingestion worker (validated at boot). */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ARCHIVES_PATH: z.string().min(1),
  TESSERACT_LANG: z.string().default('fra+eng'),
  TESSERACT_DATA_PATH: z.string().optional(),
  // Rappels §03.5 — mêmes clés de configuration que le source (`DelaisAlerte` /
  // `DelaisAlerteInterval`), mêmes valeurs par défaut (48 h / 6 h).
  DELAIS_ALERTE_HOURS: z.coerce.number().positive().default(48),
  DELAIS_ALERTE_INTERVAL_HOURS: z.coerce.number().positive().default(6),
  /**
   * Fuseau des crons de rappel. Le source planifie « 13h10 » dans le fuseau du serveur ; en UTC
   * (D-19) il faut le dire explicitement, sinon 13h10 UTC ≠ 13h10 local. Abidjan = UTC+0.
   */
  REMINDERS_TZ: z.string().default('UTC'),

  // --- E-mail (§03.5) --- mêmes clés que l'API : les rappels planifiés partent par le même canal.
  // Tout optionnel : sans SMTP_HOST les rappels restent en notification in-app seule.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  APP_BASE_URL: z.string().url().default('http://localhost:5000'),
  // Identité affichée dans les e-mails — REPLI seulement : la valeur affichée vient de
  // `email_template_setting`, comme côté API, pour un rendu identique entre rappel et notification.
  MAIL_ORG_NAME: emptyAsAbsent(z.string().optional()),
  MAIL_LOGO_URL: emptyAsAbsent(z.string().url().optional()),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
