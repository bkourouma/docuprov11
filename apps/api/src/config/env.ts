import { z } from 'zod';

/**
 * Une variable LAISSÉE VIDE dans `.env` vaut « absente ».
 *
 * Sans ce prétraitement, `MAIL_LOGO_URL=""` fait échouer `.url()` et le démarrage entier tombe sur
 * « Invalid url » — alors que vider une variable est justement la façon naturelle de désactiver un
 * réglage facultatif (et c'est ce que porte `.env.example`).
 */
const emptyAsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

/**
 * Environment contract for the API (validated at boot — fail fast on misconfig).
 * Timestamps are UTC (D-19); binaries live under ARCHIVES_PATH (D-16).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ARCHIVES_PATH: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('1d'),

  /**
   * Clé de service de l'agent de numérisation (`@archivage/scan-agent`), présentée en `X-Api-Key`
   * sur la file §07. Optionnelle : sans elle, l'authentification par clé n'existe pas et rien
   * n'est exposé. Un service installé sur un poste de scan ne doit pas porter le compte ni le mot
   * de passe d'un utilisateur — d'où une clé dédiée, révocable en la changeant ici.
   */
  SCAN_AGENT_API_KEY: emptyAsAbsent(
    z.string().min(32, 'SCAN_AGENT_API_KEY must be at least 32 characters').optional(),
  ) as z.ZodType<string | undefined>,
  /**
   * Clé privée Ed25519 (PEM) qui signe et horodate les documents — onglet « Sécurité et
   * conformité ». Optionnelle : à défaut, `<ARCHIVES_PATH>/.keys/sealing-ed25519.pem`, généré au
   * premier scellement. À sauvegarder : sans elle, les cachets déjà apposés sont invérifiables.
   */
  SEALING_KEY_PATH: emptyAsAbsent(z.string().optional()) as z.ZodType<string | undefined>,
  TESSERACT_LANG: z.string().default('fra+eng'),
  TESSERACT_DATA_PATH: z.string().optional(),

  // --- Saisie automatique par IA (§05) ---
  // Optionnel, comme SMTP : sans clé, la case « Saisie automatique » disparaît de l'écran
  // d'enregistrement et la saisie manuelle reste le seul chemin. Un déploiement sans IA doit
  // démarrer normalement.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5.6-terra'),

  // --- E-mail (notifications §03.5) ---
  // TOUT est optionnel : sans SMTP_HOST le canal e-mail est simplement désactivé (les
  // notifications in-app continuent). Un déploiement sans messagerie doit démarrer normalement,
  // et une notification n'a jamais le droit de bloquer l'action métier qui la déclenche.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** Expéditeur affiché ; à défaut SMTP_USER. */
  SMTP_FROM: z.string().optional(),
  /** Base des liens « Consulter le courrier » dans les e-mails. */
  APP_BASE_URL: z.string().url().default('http://localhost:5000'),
  /**
   * Identité affichée dans les e-mails. REPLI uniquement depuis le passage au paramétrage en base
   * (`email_template_setting`, écran « Paramétrage e-mail ») : ces variables ne servent plus qu'aux
   * déploiements où rien n'a encore été saisi. Les laisser vides est le cas NORMAL — une valeur
   * oubliée ici ferait resurgir la marque d'une autre organisation dès qu'un champ est vidé en base.
   */
  MAIL_ORG_NAME: emptyAsAbsent(z.string().optional()),
  /** URL ABSOLUE du logo : une image relative ne s'affiche pas dans une boîte mail. */
  MAIL_LOGO_URL: emptyAsAbsent(z.string().url().optional()),
});

export type Env = z.infer<typeof envSchema>;

/** Validator wired into Nest's ConfigModule.forRoot({ validate }). */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
