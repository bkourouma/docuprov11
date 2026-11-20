// Lot 2c — schémas de configuration et d'identifiants du connecteur WhatsApp Business (API Cloud de Meta).
//
// Pas de champ d'hôte ni d'URL : le connecteur ne parle qu'à l'API Graph officielle, l'administrateur ne
// peut donc diriger le serveur vers aucune adresse (surface SSRF nulle côté configuration).
// Liste blanche d'expéditeurs : seuls les numéros de `senders` peuvent déposer (cf. whatsapp-senders.ts).
import { z } from 'zod';
import { GED_CONNECTOR_LIMITS } from '@archivage/types';
import type { ConnectorFieldDescriptor } from './types';
import { normalizePhone } from './whatsapp-phone';

/** Nombre maximal d'expéditeurs autorisés par connecteur. */
export const WHATSAPP_MAX_SENDERS = 500;

/** Version de l'API Graph utilisée quand la configuration n'en précise pas (appliquée par l'appelant). */
export const WHATSAPP_DEFAULT_GRAPH_API_VERSION = 'v21.0';

/**
 * Caractères interdits dans un libellé : contrôles C0/C1 (U+0000-U+001F, U+007F-U+009F), séparateurs de ligne/paragraphe
 * Unicode et contrôles bidirectionnels (inversion d'affichage dans l'écran d'administration).
 */
const LABEL_FORBIDDEN_EXTRA = new Set([
  0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);
function hasForbiddenLabelChar(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || LABEL_FORBIDDEN_EXTRA.has(cp)) return true;
  }
  return false;
}

/** Secret : ASCII imprimable sans espace. */
const SECRET_CHARS = /^[\x21-\x7E]+$/;

const senderSchema = z
  .object({
    // Réécrit sous sa forme canonique (chiffres seulement, sans `+`). Le message d'erreur ne reprend
    // jamais le numéro saisi (donnée personnelle).
    phone: z.string().transform((value, ctx) => {
      const digits = normalizePhone(value);
      if (digits === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'numéro invalide : format international complet attendu (ex. +221 77 123 45 67), 8 à 15 chiffres',
        });
        return z.NEVER;
      }
      return digits;
    }),
    label: z
      .string()
      .max(100, 'libellé trop long (100 caractères au plus)')
      .refine((v) => !hasForbiddenLabelChar(v), 'libellé : caractères de contrôle interdits')
      // Libellé vide (champ de formulaire laissé blanc) = pas de libellé.
      .transform((v) => (v.trim() === '' ? undefined : v.trim()))
      .optional(),
  })
  .strict();

export const whatsappConfigSchema = z
  .object({
    /** Identifiant du numéro WhatsApp Business (Phone Number ID de Meta), chiffres seulement. */
    phoneNumberId: z
      .string()
      .trim()
      .regex(/^[0-9]{5,30}$/, 'identifiant du numéro : 5 à 30 chiffres attendus'),
    /** Version de l'API Graph (ex. `v21.0`). Défaut appliqué par l'appelant, pas ici. */
    graphApiVersion: z
      .string()
      .trim()
      .regex(/^v[0-9]{1,2}\.[0-9]$/, 'version de l’API Graph invalide (ex. v21.0)')
      .optional(),
    senders: z
      .array(senderSchema)
      .max(WHATSAPP_MAX_SENDERS, `${WHATSAPP_MAX_SENDERS} expéditeurs au plus`)
      // Absent = aucune liste blanche = personne ne peut déposer (refus par défaut).
      .default([])
      .superRefine((senders, ctx) => {
        const firstIndex = new Map<string, number>();
        senders.forEach((s, i) => {
          const prev = firstIndex.get(s.phone);
          if (prev === undefined) firstIndex.set(s.phone, i);
          else {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, 'phone'],
              // Positions seulement, jamais le numéro.
              message: `numéro en double (même numéro que l’expéditeur n° ${prev + 1})`,
            });
          }
        });
      }),
    /** Ne peut que resserrer le plafond commun `GED_CONNECTOR_LIMITS.maxFileBytes`. */
    maxFileBytes: z
      .number()
      .int()
      .min(1)
      .max(
        GED_CONNECTOR_LIMITS.maxFileBytes,
        `taille maximale au-delà du plafond commun (${GED_CONNECTOR_LIMITS.maxFileBytes} octets)`,
      )
      .optional(),
    ackEnabled: z.boolean().default(true),
    refuseUnknownSenders: z.boolean().default(false),
  })
  .strict();

export type WhatsappConfigParsed = z.infer<typeof whatsappConfigSchema>;

export const whatsappCredentialsSchema = z
  .object({
    accessToken: z.string().min(20).max(1000).regex(SECRET_CHARS, 'caractères non admis'),
    appSecret: z.string().min(16).max(200).regex(SECRET_CHARS, 'caractères non admis'),
    verifyToken: z.string().min(8).max(200).regex(SECRET_CHARS, 'caractères non admis'),
  })
  .strict()
  .superRefine((c, ctx) => {
    // Le jeton de vérification circule en clair dans l'URL de vérification du webhook (requête GET de
    // Meta, journaux de proxy) : il ne doit jamais être égal à un vrai secret. Messages sans valeur.
    if (c.verifyToken === c.appSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verifyToken'],
        message: 'le jeton de vérification doit différer de la clé secrète de l’application',
      });
    }
    if (c.verifyToken === c.accessToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verifyToken'],
        message: 'le jeton de vérification doit différer du jeton d’accès',
      });
    }
  });

export type WhatsappCredentialsParsed = z.infer<typeof whatsappCredentialsSchema>;

const MAX_MIB = Math.floor(GED_CONNECTOR_LIMITS.maxFileBytes / (1024 * 1024));

/**
 * Champs non secrets du formulaire générique. La liste blanche `senders` (tableau) n'y figure pas :
 * le formulaire générique ne sait pas saisir de tableau ; elle se gère dans l'écran dédié.
 */
export const WHATSAPP_CONFIG_FIELDS: ConnectorFieldDescriptor[] = [
  {
    name: 'phoneNumberId',
    label: 'Identifiant du numéro WhatsApp Business',
    kind: 'text',
    required: true,
    placeholder: '123456789012345',
    help:
      'Console Meta (developers.facebook.com) > votre application > WhatsApp > Configuration de l’API : ' +
      '« Identifiant du numéro de téléphone » (Phone number ID). Ce n’est pas le numéro lui-même : ' +
      'chiffres seulement.',
  },
  {
    name: 'graphApiVersion',
    label: 'Version de l’API Graph',
    kind: 'text',
    required: false,
    placeholder: WHATSAPP_DEFAULT_GRAPH_API_VERSION,
    help:
      `Laisser vide pour utiliser ${WHATSAPP_DEFAULT_GRAPH_API_VERSION}. Format vNN.N, tel qu’affiché dans ` +
      'les exemples d’appels de la console Meta.',
  },
  {
    name: 'maxFileBytes',
    label: 'Taille maximale d’un fichier reçu (octets)',
    kind: 'number',
    required: false,
    help: `Laisser vide pour le plafond commun (${MAX_MIB} Mio). Une valeur ne peut que l’abaisser.`,
  },
  {
    name: 'ackEnabled',
    label: 'Envoyer un accusé de réception',
    kind: 'boolean',
    required: false,
    help: 'Répond « Document reçu » à l’expéditeur une fois le document enregistré. Activé par défaut.',
  },
  {
    name: 'refuseUnknownSenders',
    label: 'Répondre aux numéros non autorisés',
    kind: 'boolean',
    required: false,
    help:
      'Envoie un message poli de refus aux numéros absents de la liste des expéditeurs. Désactivé par ' +
      'défaut : leurs messages sont ignorés sans réponse.',
  },
];

/** Champs secrets (chiffrés, jamais réaffichés). */
export const WHATSAPP_CREDENTIAL_FIELDS: ConnectorFieldDescriptor[] = [
  {
    name: 'accessToken',
    label: 'Jeton d’accès permanent',
    kind: 'password',
    required: true,
    help:
      'Meta Business Suite > Paramètres de l’entreprise > Utilisateurs > Utilisateurs système : ' +
      'sélectionner l’utilisateur système, « Générer un nouveau jeton » pour l’application, avec les ' +
      'autorisations whatsapp_business_messaging et whatsapp_business_management. Éviter le jeton ' +
      'temporaire de la page « Configuration de l’API » : il expire au bout de 24 heures.',
  },
  {
    name: 'appSecret',
    label: 'Clé secrète de l’application',
    kind: 'password',
    required: true,
    help:
      'Console Meta > votre application > Paramètres de l’application > Général > « Clé secrète » ' +
      '(bouton Afficher). Sert à vérifier la signature de chaque appel reçu sur le webhook.',
  },
  {
    name: 'verifyToken',
    label: 'Jeton de vérification du webhook',
    kind: 'password',
    required: true,
    help:
      'Valeur de votre choix (8 caractères au moins, sans espace), à recopier à l’identique dans la ' +
      'console Meta > WhatsApp > Configuration > Webhook > « Jeton de vérification ». Doit différer de ' +
      'la clé secrète et du jeton d’accès.',
  },
];

/**
 * Garde de configuration (sans réseau) : re-valide le schéma. Aucun hôte n'est configurable, il n'y a
 * donc pas de garde SSRF à appliquer. Le message d'erreur ne cite que des chemins et des motifs.
 */
export function assertWhatsappConfigSafe(config: unknown): void {
  const result = whatsappConfigSchema.safeParse(config);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.length ? i.path.join('.') : '(racine)'} : ${i.message}`,
    );
    throw new Error(`Configuration WhatsApp invalide : ${problems.join(' ; ')}`);
  }
}
