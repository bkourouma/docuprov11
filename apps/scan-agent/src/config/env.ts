import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Dossier surveillé par défaut : un dossier simple, à la racine du disque de données, hors du
 * coffre. Le pilote du scanner y écrit, l'agent le vide — rien d'autre ne doit y toucher.
 */
export const DEFAULT_WATCH_DIR = 'D:/scans-entrants';

/**
 * Contrat d'environnement de l'agent de numérisation (validé au démarrage).
 *
 * Tout est préfixé `SCAN_AGENT_` : le fichier peut cohabiter avec le `.env` du serveur sans
 * collision si l'agent tourne sur la même machine (poste de scan = serveur en petite installation).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),

  /** Racine de l'API, préfixe `/api` inclus — ex. `http://serveur-docupro:3001/api`. */
  SCAN_AGENT_API_URL: z.string().url(),

  /**
   * Clé de service, posée une fois à l'installation — **c'est la voie normale**. Elle vaut la même
   * chose côté serveur (`SCAN_AGENT_API_KEY` du `.env` de l'API) et dispense l'agent de tout
   * compte utilisateur : rien à renouveler, rien qui expire, révocation en changeant la clé.
   */
  SCAN_AGENT_API_KEY: z.string().min(32).optional(),

  /**
   * Repli par compte applicatif, pour un serveur antérieur à la clé de service. Le compte a besoin
   * du menu `/courriers/documents-scannes` et c'est lui qui apparaît en `created_by` sur chaque
   * dépôt. À éviter : un mot de passe d'utilisateur sur un poste de scan finit toujours par expirer
   * un vendredi soir.
   */
  SCAN_AGENT_USERNAME: z.string().min(1).optional(),
  SCAN_AGENT_PASSWORD: z.string().min(1).optional(),

  /** Dossier surveillé : le pilote du scanner doit y écrire ses fichiers. */
  SCAN_AGENT_WATCH_DIR: z.string().min(1).default(DEFAULT_WATCH_DIR),

  /**
   * Racine du coffre. L'agent n'y écrit rien : elle ne sert qu'à refuser de surveiller le coffre
   * lui-même (voir `resolveWatchDir`). Même clé que l'API et le worker, déjà présente dans le
   * `.env` du serveur — rien à renseigner de plus.
   */
  ARCHIVES_PATH: z.string().min(1).optional(),

  /** Colonne « Poste » de l'écran §07. Par défaut le nom NetBIOS de la machine. */
  SCAN_AGENT_MACHINE_NAME: z.string().min(1).default(hostname()),

  /** Intervalle entre deux balayages du dossier. */
  SCAN_AGENT_POLL_MS: z.coerce.number().int().positive().default(5_000),

  /**
   * Durée pendant laquelle taille et date doivent rester identiques avant de considérer que le
   * scanner a fini d'écrire. Trop court ⇒ on envoie un PDF tronqué ; c'est le seul réglage
   * vraiment sensible sur un dossier alimenté par un pilote lent ou un partage réseau.
   */
  SCAN_AGENT_STABLE_MS: z.coerce.number().int().positive().default(4_000),

  /** Tentatives d'envoi avant mise en quarantaine (erreurs réseau / serveur uniquement). */
  SCAN_AGENT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /** Garde-fou local : au-delà, le fichier part en quarantaine sans encombrer le réseau. */
  SCAN_AGENT_MAX_FILE_MB: z.coerce.number().positive().default(100),
});

export type Env = z.infer<typeof envSchema>;

/** Ce que l'agent présente à l'API. */
export type Credentials =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'password'; username: string; password: string };

/**
 * Clé de service si elle est là, sinon compte applicatif. Sans l'un ni l'autre, l'agent ne peut
 * rien déposer : échouer ici, au démarrage, plutôt qu'au premier scan de la journée.
 */
export function resolveCredentials(env: Env): Credentials {
  if (env.SCAN_AGENT_API_KEY) return { kind: 'apiKey', apiKey: env.SCAN_AGENT_API_KEY };
  if (env.SCAN_AGENT_USERNAME && env.SCAN_AGENT_PASSWORD) {
    return {
      kind: 'password',
      username: env.SCAN_AGENT_USERNAME,
      password: env.SCAN_AGENT_PASSWORD,
    };
  }
  throw new Error(
    "Aucun moyen d'authentification : renseignez SCAN_AGENT_API_KEY (recommandé — la même valeur " +
      'que côté serveur), ou à défaut SCAN_AGENT_USERNAME + SCAN_AGENT_PASSWORD.',
  );
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration de l'agent invalide :\n${issues}`);
  }
  return parsed.data;
}

/**
 * Dossier effectivement surveillé : `SCAN_AGENT_WATCH_DIR`, ou `D:/scans-entrants` par défaut.
 *
 * Refuse la racine du coffre : `DiskFileStore` y écrit les binaires de la GED (`<fileId>.pdf`, à
 * plat). Surveiller `ARCHIVES_PATH` reviendrait à réinjecter toute la GED dans la file §07 **et à
 * sortir les fichiers du coffre** — chaque document existant deviendrait introuvable. Le garde-fou
 * est ici, pas dans la documentation.
 */
export function resolveWatchDir(env: Pick<Env, 'SCAN_AGENT_WATCH_DIR' | 'ARCHIVES_PATH'>): string {
  const { SCAN_AGENT_WATCH_DIR: watchDir, ARCHIVES_PATH: archives } = env;

  if (archives && resolve(watchDir) === resolve(archives)) {
    throw new Error(
      `SCAN_AGENT_WATCH_DIR ne peut pas être la racine du coffre (${archives}) : les binaires de ` +
        `la GED y sont stockés à plat et seraient déplacés hors du coffre. Utilisez un dossier ` +
        `dédié, par exemple ${DEFAULT_WATCH_DIR}.`,
    );
  }
  return watchDir;
}
