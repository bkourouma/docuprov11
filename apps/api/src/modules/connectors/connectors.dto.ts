import { z } from 'zod';
import { CREDENTIALS_REF_REGEX } from '@archivage/connectors';
import { GED_CONNECTOR_TYPE_REGEX } from '@archivage/types';

/** Plafond de page des éléments et des passes : une ligne embarque des JSON (ACL, métadonnées). */
export const CONNECTORS_MAX_PAGE_SIZE = 100;
export const CONNECTORS_DEFAULT_PAGE_SIZE = 25;
export const CONNECTORS_DEFAULT_RUNS_LIMIT = 20;

const INT4_MAX = 2147483647;
/** Bornes de la périodicité : 5 minutes (au plus une passe par tick utile) à 7 jours. */
export const SYNC_INTERVAL_MIN = 5;
export const SYNC_INTERVAL_MAX = 10080;

/**
 * Entier de requête : une chaîne vide est refusée au lieu d'être coercée en 0 (même règle que le
 * socle IA). `NaN` fait échouer `z.coerce.number()` : 400.
 */
const queryInt = (min: number, max?: number) => {
  const bounded =
    max === undefined ? z.number().int().min(min) : z.number().int().min(min).max(max);
  return z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? Number.NaN : v),
    z.coerce.number().pipe(bounded),
  );
};

const modeSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

/** Configuration : un OBJET (un tableau ou un scalaire est refusé) ; son contenu est validé par le registre. */
const configSchema = z.record(z.unknown());

/** Identifiants en clair : clé → chaîne. Le contenu précis dépend du type (validé par le registre). */
const credentialsSchema = z.record(z.string().max(10_000));

const credentialsRefSchema = z
  .string()
  .regex(
    CREDENTIALS_REF_REGEX,
    'Référence refusée : seules les variables GED_CONNECTOR_SECRET_… sont autorisées',
  );

const isoDate = z.string().datetime({ offset: true });
const syncInterval = z.number().int().min(SYNC_INTERVAL_MIN).max(SYNC_INTERVAL_MAX);
const dossierId = z.number().int().min(1).max(INT4_MAX);

const EXCLUSIVE_MESSAGE =
  'credentials et credentialsRef sont exclusifs : fournissez l’un ou l’autre';

export const createConnectorSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    connectorType: z.string().max(40).regex(GED_CONNECTOR_TYPE_REGEX),
    mode: modeSchema,
    config: configSchema.default({}),
    credentials: credentialsSchema.optional(),
    credentialsRef: credentialsRefSchema.optional(),
    credentialsExpiresAt: isoDate.nullable().optional(),
    syncIntervalMinutes: syncInterval.nullable().optional(),
    targetDossierId: dossierId.nullable().optional(),
  })
  .strict()
  .refine((v) => !(v.credentials !== undefined && v.credentialsRef !== undefined), {
    message: EXCLUSIVE_MESSAGE,
    path: ['credentialsRef'],
  });
export type CreateConnectorDto = z.infer<typeof createConnectorSchema>;

/**
 * Mise à jour partielle. `connectorType` n'y figure pas (le schéma strict le refuse) : changer de
 * type reviendrait à réinterpréter une configuration et des identifiants qui ne lui appartiennent
 * pas. `credentials` : objet = remplacement complet, `null` = effacement, absent = inchangé.
 */
export const updateConnectorSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    mode: modeSchema.optional(),
    config: configSchema.optional(),
    credentials: credentialsSchema.nullable().optional(),
    credentialsRef: credentialsRefSchema.nullable().optional(),
    credentialsExpiresAt: isoDate.nullable().optional(),
    syncIntervalMinutes: syncInterval.nullable().optional(),
    targetDossierId: dossierId.nullable().optional(),
  })
  .strict()
  .refine((v) => !(v.credentials != null && v.credentialsRef != null), {
    message: EXCLUSIVE_MESSAGE,
    path: ['credentialsRef'],
  });
export type UpdateConnectorDto = z.infer<typeof updateConnectorSchema>;

export const listRunsQuerySchema = z
  .object({
    limit: queryInt(1, CONNECTORS_MAX_PAGE_SIZE).optional(),
  })
  .strict();
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const listItemsQuerySchema = z
  .object({
    state: queryInt(0, 6).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    page: queryInt(1, INT4_MAX).optional(),
    pageSize: queryInt(1, CONNECTORS_MAX_PAGE_SIZE).optional(),
  })
  .strict();
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;

/** Id de connecteur : entier > 0 tenant dans un int4 (colonne `Int`). */
export const connectorIdSchema = z.coerce.number().int().min(1).max(INT4_MAX);
/** Id d'élément (BigInt en base) : exactement représentable en `number` ; le service le reconvertit. */
export const itemIdSchema = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
