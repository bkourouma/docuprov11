import { z } from 'zod';

// Docu-GED — énumérations & constantes métier partagées (api / worker / web).
// Miroir TS des états stockés en base sous forme de `smallint` + CHECK (pas d'enum Prisma) :
// cf. packages/db/prisma/models/ged.prisma.

/** Mode d'IA de la GED (paramétrage). */
export const GedAiMode = {
  Desactivee: 0,
  Locale: 1,
  Cloud: 2,
} as const;
export type GedAiMode = (typeof GedAiMode)[keyof typeof GedAiMode];

export const GED_AI_MODE_LABELS: Record<GedAiMode, string> = {
  [GedAiMode.Desactivee]: 'Désactivée',
  [GedAiMode.Locale]: 'Locale',
  [GedAiMode.Cloud]: 'Cloud',
};

/** Type de masquage IA (expression régulière, texte exact, entité prédéfinie). */
export const GedAiMaskingKind = {
  Regex: 0,
  Exact: 1,
  Entite: 2,
} as const;
export type GedAiMaskingKind = (typeof GedAiMaskingKind)[keyof typeof GedAiMaskingKind];

export const GED_AI_MASKING_KIND_LABELS: Record<GedAiMaskingKind, string> = {
  [GedAiMaskingKind.Regex]: 'Expression régulière',
  [GedAiMaskingKind.Exact]: 'Texte exact',
  [GedAiMaskingKind.Entite]: 'Entité prédéfinie',
};

/** Tâche confiée à l'IA. */
export const GedAiTask = {
  Classement: 0,
  ExtractionMetadonnees: 1,
  Resume: 2,
  TypeDocument: 3,
  Question: 4,
  Similarite: 5,
  CorrectionOcr: 6,
  Autre: 7,
} as const;
export type GedAiTask = (typeof GedAiTask)[keyof typeof GedAiTask];

export const GED_AI_TASK_LABELS: Record<GedAiTask, string> = {
  [GedAiTask.Classement]: 'Classement',
  [GedAiTask.ExtractionMetadonnees]: 'Extraction de métadonnées',
  [GedAiTask.Resume]: 'Résumé',
  [GedAiTask.TypeDocument]: 'Type de document',
  [GedAiTask.Question]: 'Réponse à une question',
  [GedAiTask.Similarite]: 'Similarité / doublon',
  [GedAiTask.CorrectionOcr]: 'Correction OCR',
  [GedAiTask.Autre]: 'Autre',
};

/** Statut d'une décision proposée par l'IA. */
export const GedAiDecisionStatus = {
  Proposee: 0,
  Validee: 1,
  Rejetee: 2,
  AppliqueeAuto: 3,
  Erreur: 4,
} as const;
export type GedAiDecisionStatus = (typeof GedAiDecisionStatus)[keyof typeof GedAiDecisionStatus];

export const GED_AI_DECISION_STATUS_LABELS: Record<GedAiDecisionStatus, string> = {
  [GedAiDecisionStatus.Proposee]: 'Proposée',
  [GedAiDecisionStatus.Validee]: 'Validée',
  [GedAiDecisionStatus.Rejetee]: 'Rejetée',
  [GedAiDecisionStatus.AppliqueeAuto]: 'Appliquée automatiquement',
  [GedAiDecisionStatus.Erreur]: 'En erreur',
};

/** Mode d'une source : copie, indexation en place ou synchronisation. */
export const GedSourceMode = {
  Copie: 0,
  IndexationEnPlace: 1,
  Synchro: 2,
} as const;
export type GedSourceMode = (typeof GedSourceMode)[keyof typeof GedSourceMode];

export const GED_SOURCE_MODE_LABELS: Record<GedSourceMode, string> = {
  [GedSourceMode.Copie]: 'Copie',
  [GedSourceMode.IndexationEnPlace]: 'Indexation en place',
  [GedSourceMode.Synchro]: 'Synchronisation',
};

/** Statut d'un connecteur de source. */
export const GedSourceConnectorStatus = {
  Inactif: 0,
  Actif: 1,
  Erreur: 2,
  AutorisationExpiree: 3,
} as const;
export type GedSourceConnectorStatus =
  (typeof GedSourceConnectorStatus)[keyof typeof GedSourceConnectorStatus];

export const GED_SOURCE_CONNECTOR_STATUS_LABELS: Record<GedSourceConnectorStatus, string> = {
  [GedSourceConnectorStatus.Inactif]: 'Inactif',
  [GedSourceConnectorStatus.Actif]: 'Actif',
  [GedSourceConnectorStatus.Erreur]: 'En erreur',
  [GedSourceConnectorStatus.AutorisationExpiree]: 'Autorisation expirée',
};

/** Statut d'une exécution de synchronisation. */
export const GedSyncRunStatus = {
  EnCours: 0,
  Reussie: 1,
  Partielle: 2,
  Echouee: 3,
} as const;
export type GedSyncRunStatus = (typeof GedSyncRunStatus)[keyof typeof GedSyncRunStatus];

export const GED_SYNC_RUN_STATUS_LABELS: Record<GedSyncRunStatus, string> = {
  [GedSyncRunStatus.EnCours]: 'En cours',
  [GedSyncRunStatus.Reussie]: 'Réussie',
  [GedSyncRunStatus.Partielle]: 'Partielle',
  [GedSyncRunStatus.Echouee]: 'Échouée',
};

/** État d'un élément issu d'une source. */
export const GedSourceItemState = {
  Decouvert: 0,
  Copie: 1,
  IndexeEnPlace: 2,
  ModifieSource: 3,
  SupprimeSource: 4,
  Erreur: 5,
  Doublon: 6,
} as const;
export type GedSourceItemState = (typeof GedSourceItemState)[keyof typeof GedSourceItemState];

export const GED_SOURCE_ITEM_STATE_LABELS: Record<GedSourceItemState, string> = {
  [GedSourceItemState.Decouvert]: 'Découvert',
  [GedSourceItemState.Copie]: 'Copié',
  [GedSourceItemState.IndexeEnPlace]: 'Indexé en place',
  [GedSourceItemState.ModifieSource]: 'Modifié à la source',
  [GedSourceItemState.SupprimeSource]: 'Supprimé à la source',
  [GedSourceItemState.Erreur]: 'En erreur',
  [GedSourceItemState.Doublon]: 'Doublon',
};

/** Nature d'un espace GED. */
export const GedSpaceKind = {
  Prive: 0,
  Partage: 1,
  Collaboration: 2,
  Publication: 3,
} as const;
export type GedSpaceKind = (typeof GedSpaceKind)[keyof typeof GedSpaceKind];

export const GED_SPACE_KIND_LABELS: Record<GedSpaceKind, string> = {
  [GedSpaceKind.Prive]: 'Privé',
  [GedSpaceKind.Partage]: 'Partagé',
  [GedSpaceKind.Collaboration]: 'Collaboration',
  [GedSpaceKind.Publication]: 'Publication',
};

/** Droit accordé sur un espace GED. */
export const GedSpacePermission = {
  Lecture: 0,
  Contribution: 1,
  Gestion: 2,
} as const;
export type GedSpacePermission = (typeof GedSpacePermission)[keyof typeof GedSpacePermission];

export const GED_SPACE_PERMISSION_LABELS: Record<GedSpacePermission, string> = {
  [GedSpacePermission.Lecture]: 'Lecture',
  [GedSpacePermission.Contribution]: 'Contribution',
  [GedSpacePermission.Gestion]: 'Gestion',
};

/** Nature d'une nouvelle version d'un document GED. */
export const GedVersionChangeKind = {
  Creation: 0,
  Modification: 1,
  SynchroSource: 2,
  Restauration: 3,
  ModificationIa: 4,
} as const;
export type GedVersionChangeKind = (typeof GedVersionChangeKind)[keyof typeof GedVersionChangeKind];

export const GED_VERSION_CHANGE_KIND_LABELS: Record<GedVersionChangeKind, string> = {
  [GedVersionChangeKind.Creation]: 'Création',
  [GedVersionChangeKind.Modification]: 'Modification',
  [GedVersionChangeKind.SynchroSource]: 'Synchro depuis la source',
  [GedVersionChangeKind.Restauration]: 'Restauration',
  [GedVersionChangeKind.ModificationIa]: "Modification par l'IA",
};

/** Dimension figée de `ged_document_chunk.embedding` (`vector(1024)`). */
export const GED_EMBEDDING_DIMENSION = 1024;

/** Empreinte SHA-256 attendue : 64 caractères hexadécimaux minuscules. */
export const GED_SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

/** Identifiant de type de connecteur : minuscules, chiffres et underscores. */
export const GED_CONNECTOR_TYPE_REGEX = /^[a-z0-9_]+$/;

// ===========================================================================
// Socle IA (lot 1) — contrat partagé api / worker
// ===========================================================================
// Tout ce qui suit est SANS dépendance d'exécution (hors zod) : masquage, seuil d'application
// automatique, extrait de journal, schémas de sortie des tâches. API et worker doivent appliquer
// EXACTEMENT les mêmes règles — d'où leur place ici plutôt que dupliquée.

/** Message renvoyé par toute fonctionnalité IA quand `ged_ai_setting.mode = 0` (jamais une erreur). */
export const GED_AI_DISABLED_MESSAGE = 'IA désactivée';

/** File BullMQ du pipeline lecture → classement → extraction (producteur api, consommateur worker). */
export const GED_AI_QUEUE = 'ged-ai';

/** Travail de la file `ged-ai` : un document à analyser. */
export interface GedAiPipelineJobData {
  documentId: number;
  sourceItemId?: number | null;
  /** `user_group_id` de l'auteur de la demande ; `null`/absent = déclenchement système. */
  requestedBy?: number | null;
}

/** Résultat d'un job du pipeline (valeur de retour BullMQ). */
export type GedAiPipelineResult =
  | { disabled: true; message: string }
  | {
      disabled: false;
      documentId: number;
      /** `no_text` : aucun texte lisible (OCR absent) — rien n'est envoyé au modèle. */
      skipped?: 'no_text' | 'document_not_found';
      decisions: Array<{
        task: GedAiTask;
        decisionId: string;
        status: GedAiDecisionStatus;
        confidence: number | null;
      }>;
    };

/** Nature du fournisseur effectivement utilisé. */
export type GedAiProviderKind = 'local' | 'cloud' | 'disabled';

/** Valeurs par défaut (H2 : fournisseur cloud par défaut = OpenAI, interchangeable par configuration). */
export const GED_AI_DEFAULT_CLOUD_PROVIDER = 'openai';
export const GED_AI_DEFAULT_CLOUD_ENDPOINT = 'https://api.openai.com/v1';
export const GED_AI_DEFAULT_CLOUD_MODEL = 'gpt-5.6-terra';
export const GED_AI_DEFAULT_CLOUD_EMBEDDING_MODEL = 'text-embedding-3-large';
export const GED_AI_DEFAULT_LOCAL_EMBEDDING_MODEL = 'bge-m3';

/**
 * Nom de variable d'environnement acceptable comme `api_key_ref` : `OPENAI_API_KEY` ou `GED_AI_*`.
 * Liste blanche volontaire — une référence libre permettrait d'envoyer `JWT_SECRET` ou
 * `DATABASE_URL` en en-tête d'autorisation vers l'endpoint configuré. Majuscules seulement ; après
 * `GED_AI_`, un caractère alphanumérique obligatoire (`GED_AI_` seul ou `GED_AI__X` refusés). Ancrée
 * des deux côtés, sans drapeau `m` (un saut de ligne final est refusé) ni `g` (`test` sans état).
 */
export const GED_AI_API_KEY_REF_REGEX = /^(?:OPENAI_API_KEY|GED_AI_[A-Z0-9][A-Z0-9_]{0,59})$/;

/** Longueur maximale de l'extrait d'entrée conservé dans `ged_ai_decision.input_excerpt`. */
export const GED_AI_INPUT_EXCERPT_MAX_CHARS = 2000;

/** Version du gabarit de requête du pipeline (colonne `prompt_version`). */
export const GED_AI_PIPELINE_PROMPT_VERSION = 'ged-pipeline-v1';

/** Entités prédéfinies du masquage (`ged_ai_masking_rule.kind = 2`, `pattern` = ce code). */
export const GED_AI_MASKING_ENTITIES = [
  'email',
  'phone',
  'amount',
  'iban',
  'card',
  'nir',
  'identity',
] as const;
export type GedAiMaskingEntity = (typeof GED_AI_MASKING_ENTITIES)[number];

export const GED_AI_DEFAULT_MASKING_REPLACEMENT = '[MASQUÉ]';

/** Marqueur inséré par défaut à la place de chaque entité prédéfinie. */
export const GED_AI_MASKING_ENTITY_MARKERS: Record<GedAiMaskingEntity, string> = {
  email: '[EMAIL]',
  phone: '[TÉLÉPHONE]',
  amount: '[MONTANT]',
  iban: '[IBAN]',
  card: '[CARTE]',
  nir: '[NIR]',
  identity: '[IDENTITÉ]',
};

/**
 * Filet de sécurité du masquage PAR DÉFAUT (cloud) : toute suite d'au moins 9 chiffres (espaces ou
 * points admis entre eux), ou de 8 chiffres collés, restée en clair après les entités — numéro de
 * téléphone mal formé, carte à clé de Luhn fausse, RIB, n° de pièce d'identité…
 */
export const GED_AI_MASKING_RESIDUAL_NUMBER_MARKER = '[NUMÉRO]';

/** Longueur maximale d'un motif de règle (`ged_ai_masking_rule.pattern`). */
export const GED_AI_MASKING_PATTERN_MAX_LENGTH = 500;
/** Longueur maximale d'un texte de remplacement de règle. */
export const GED_AI_MASKING_REPLACEMENT_MAX_LENGTH = 200;
/**
 * Plafond du texte soumis au masquage (après normalisation NFKC). Au-delà : refus (échec fermé),
 * l'appelant doit tronquer AVANT de masquer. Borne le coût des règles regex de l'administrateur.
 */
export const GED_AI_MASKING_MAX_TEXT_CHARS = 200_000;
/** Règle regex : borne maximale d'un quantificateur `{n,m}` (les répétitions illimitées sont refusées). */
export const GED_AI_MASKING_REGEX_MAX_REPEAT = 100;
/**
 * Règle regex : budget de retour arrière — produit des amplitudes `(max − min + 1)` de tous les
 * quantificateurs variables. Mesuré : `\w{1,30}\w{1,30}x` (900) ≈ 0,7 s au pire sur 200 000
 * caractères, contre 48 s pour `[a-z]+\d+` non borné.
 */
export const GED_AI_MASKING_REGEX_MAX_COST = 1000;

/** Règle de masquage (forme de `ged_ai_masking_rule`, sans colonnes techniques). */
export interface GedAiMaskingRuleDef {
  kind: GedAiMaskingKind;
  pattern: string;
  replacement?: string | null;
}

export interface GedAiMaskingResult {
  text: string;
  /** Nombre de substitutions effectuées. */
  count: number;
}

// ---------------------------------------------------------------------------
// Masquage — motifs prédéfinis
// ---------------------------------------------------------------------------
// LIMITES CONNUES (à compléter par des règles « texte exact » en base, insensibles à la casse, aux
// accents, aux espaces et aux apostrophes) :
// - un nom propre libre, sans civilité ni libellé (« KOUASSI Jean a signé »), N'EST PAS détectable
//   par expression régulière ; idem pour un nom écrit tout en minuscules après une civilité ;
// - montants écrits en lettres (« un million de francs »), ou sans devise ni libellé (sauf filet
//   [NUMÉRO] à partir de 9 chiffres) ;
// - e-mails obfusqués (« jean [at] exemple [point] ci »), adresses postales, dates de naissance,
//   identifiants courts (moins de 8 chiffres) ;
// - binaires joints (images, PDF) : non masquables, l'envoi cloud est refusé en amont ;
// - sur-masquage ASSUMÉ (références de 9 chiffres et plus, « Client : … » jusqu'en fin de ligne,
//   mots en capitales après une civilité) : masquer trop vaut mieux que laisser fuir.
// Tous les motifs ci-dessous sont conçus en temps linéaire (débuts de correspondance ancrés par
// des assertions arrière, répétitions bornées, pas d'alternative ambiguë répétée).

/** Espaces horizontaux, dont insécables (U+00A0, fine U+202F, chiffre U+2007) — jamais de saut de ligne. */
const SP = String.raw`[ \t\u00a0\u202f\u2007]`;
/** Séparateurs de chiffres « espace ou point » (filet [NUMÉRO], NIR). */
const SP_DOT = String.raw`[ \u00a0\u202f\u2007.]`;
/** Séparateurs admis dans un numéro de téléphone international ou libellé (jusqu'à 2 d'affilée). */
const PHONE_SEP = String.raw`[ \t\u00a0\u202f\u2007.\-‐‑()]`;
/** Séparateur unique entre paires de chiffres (07 12 34 56 78, 07.12.34.56.78, 07-12-…). */
const PAIR_SEP = String.raw`[ \u00a0\u202f\u2007.\-‐‑]`;
/** Séparateur unique entre chiffres d'une carte bancaire. */
const CARD_SEP = String.raw`[ \u00a0\u202f\u2007\-]`;

// --- E-mail (Unicode ; espaces tolérés autour de « @ », fréquents en sortie d'OCR) ---
const EMAIL_CHAR = String.raw`[\p{L}\p{N}\p{M}._%+'’\-]`;
const RX_EMAIL = new RegExp(
  String.raw`(?<!${EMAIL_CHAR})${EMAIL_CHAR}+${SP}?@${SP}?[\p{L}\p{N}\p{M}\-]+(?:\.[\p{L}\p{N}\p{M}\-]+)*`,
  'gu',
);

// --- IBAN (FR, UEMOA « CI93 CI00 … », minuscules admises) ; au moins 10 chiffres exigés ---
const RX_IBAN = new RegExp(
  String.raw`(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:${SP}?[A-Z0-9]{4}){2,7}(?:${SP}?[A-Z0-9]{1,4})?(?![\p{L}\p{N}])`,
  'giu',
);

// --- Montants : FCFA / F CFA / F / XOF, €, $, … ; nombre AVANT ou APRÈS la devise, ou après un libellé ---
const AMOUNT_SYMBOLS = String.raw`(?:US\$|\$US|[€$£₦₵¥])`;
const AMOUNT_CURRENCY_WORDS = String.raw`(?:f${SP}?cfa|fcfa|francs?(?:${SP}+cfa)?|frs?\.?|cfa|xof|xaf|eur(?:os?)?|usd|gbp|chf|cad|gnf|ngn|ghs|mad|dollars?|f)`;
const AMOUNT_CURRENCY = String.raw`(?:${AMOUNT_SYMBOLS}|${AMOUNT_CURRENCY_WORDS}(?![\p{L}\p{N}]))`;
const AMOUNT_MULTIPLIER = String.raw`(?:mille|millions?|milliards?|mrds?|mds?|k|m)(?![\p{L}\p{N}])`;
/** Nombre : chiffres séparés par UN espace, point, virgule ou apostrophe (1 500 000 ; 1.500,50 ; 1'000). */
const AMOUNT_NUMBER = String.raw`\d+(?:[ \u00a0\u202f\u2007.,'’]\d+)*`;
/** « Queue » d'un montant suffixé (devise après le nombre) : le nombre est retrouvé à rebours. */
const RX_AMOUNT_TAIL = new RegExp(
  String.raw`(?<=\d)${SP}{0,2}(?:${AMOUNT_MULTIPLIER}${SP}*(?:de${SP}+|d['’]${SP}*)?)?${AMOUNT_CURRENCY}`,
  'giu',
);
const RX_AMOUNT_PREFIX = new RegExp(
  String.raw`(?:${AMOUNT_SYMBOLS}|(?<![\p{L}\p{N}])(?:eur|usd|gbp|chf|xof|xaf|fcfa|f${SP}?cfa|cfa|gnf|ngn|ghs)(?![\p{L}]))${SP}{0,2}${AMOUNT_NUMBER}`,
  'giu',
);
const RX_AMOUNT_LABELLED = new RegExp(
  String.raw`(?<![\p{L}])((?:montants?|total|totaux|somme|prix|solde|net${SP}+à${SP}+payer|reste${SP}+à${SP}+payer|co[uû]ts?|tarifs?|salaires?|loyers?|honoraires|acomptes?)(?![\p{L}])[^\d\n\r]{0,30}?)(${AMOUNT_NUMBER})(?!\d|[/\-]\d)`,
  'giu',
);
const AMOUNT_INNER_SEPARATORS = " \u00a0\u202f\u2007.,'’";

// --- Téléphones : international (+225 / 00225 / +33 (0)6…), national par paires, compact, libellé ---
const RX_PHONE_INTL = new RegExp(
  String.raw`(?<![\p{L}\p{N}+])(?<!\d[ \u00a0\u202f\u2007.,])(?:\+|00)${SP}?\d(?:${PHONE_SEP}{0,2}\d){6,14}(?!${PHONE_SEP}{0,2}\d)`,
  'gu',
);
const RX_PHONE_GROUPED = new RegExp(
  String.raw`(?<!\d${PAIR_SEP}?)(?:\d{3}${PAIR_SEP})?\d{2}(?:${PAIR_SEP}\d{2}){3,4}(?!${PAIR_SEP}?\d)`,
  'gu',
);
const RX_PHONE_COMPACT = /(?<!\d)0\d{9}(?!\d)/g;
const RX_PHONE_LABELLED = new RegExp(
  String.raw`(?<![\p{L}])((?:t[ée]l[ée]phones?|t[ée]l[ée]copie|t[ée]l|portable|mobile|cellulaire|cel|gsm|fax|whatsapp)\.?${SP}*(?:\(s\))?${SP}*(?:(?:n°|no\.?|:|-|/)${SP}*){0,2})(\+?\d(?:${PHONE_SEP}{0,2}\d){5,14})(?!${PHONE_SEP}{0,2}\d)`,
  'giu',
);

// --- NIR (sécurité sociale française, Corse 2A/2B) : clé vérifiée si présente ---
const NIR_SEP = `${SP_DOT}?`;
const RX_NIR = new RegExp(
  String.raw`(?<!\d${SP_DOT}?)[1-478]${NIR_SEP}\d{2}${NIR_SEP}(?:0[1-9]|1[0-2]|[2-9]\d)${NIR_SEP}(?:\d{2}|2[AB])${NIR_SEP}\d{3}${NIR_SEP}\d{3}(?:${NIR_SEP}\d{2})?(?!${SP_DOT}?\d)`,
  'giu',
);

// --- Carte bancaire : 13 à 19 chiffres, clé de Luhn valide (sinon filet [NUMÉRO]) ---
const RX_CARD = new RegExp(
  String.raw`(?<!\d${CARD_SEP}?)\d(?:${CARD_SEP}?\d){12,18}(?!${CARD_SEP}?\d)`,
  'gu',
);

// --- Filet : longue suite de chiffres restée en clair ---
const RX_RESIDUAL_NUMBER = new RegExp(
  String.raw`(?<!\d${SP_DOT}?)\d(?:${SP_DOT}?\d){8,}(?!${SP_DOT}?\d)|(?<![\p{L}\p{N}])\d{8}(?![\p{L}\p{N}])`,
  'gu',
);

// --- Identité : civilité + nom (capitale initiale), ou libellé « Nom : … » ---
/** Mot de nom : initiale (« J. », « J.-M. ») ou mot à capitale initiale (KOUASSI, N’Guessan, Jean-Marc). */
const NAME_WORD = String.raw`(?:\p{Lu}\.(?:-\p{Lu}\.)?|\p{Lu}[\p{L}\p{M}'’\-]*)`;
const NAME_PARTICLE = String.raw`(?:de|du|des|da|dos|di|del|van|von|der|den|le|la|ben|bin|ibn|ould|el|al|d['’])`;
/** Liaison entre mots : espaces (« et », « & », « ou » admis), ou virgule suivie d'un nom EN CAPITALES. */
const NAME_JOINER = String.raw`(?:${SP}+(?:(?:et|&|ou)${SP}+)?|${SP}*,${SP}*(?=\p{Lu}[\p{Lu}'’\-]+(?![\p{Ll}])))`;
/** Nom : 1 à 6 mots ; le séparateur qui SUIT le nom n'est jamais consommé. */
const NAME = String.raw`${NAME_WORD}(?:${NAME_JOINER}(?:${NAME_PARTICLE}${SP}*)?${NAME_WORD}){0,5}`;
const CIVILITY_DOT = String.raw`(?:MM|M|Mr|Mrs|Ms|Dr|DR|Pr|PR|[ÉéEe]p)\.`;
const CIVILITY_WORD = String.raw`(?:Monsieur|MONSIEUR|Messieurs|MESSIEURS|Madame|MADAME|Mesdames|MESDAMES|Mademoiselle|MADEMOISELLE|Mmes|MMES|Mme|MME|Mlles|Mlle|MLLE|Docteur|DOCTEUR|Dr|DR|Professeur|PROFESSEUR|Pr|Maître|MAÎTRE|Maitre|MAITRE|Me|Mrs|Mr|Ms|Sieur|SIEUR|Dame|DAME|Veuve|VEUVE|Vve|VVE|[Nn]ée|NÉE|[Nn]ee|NEE|[Éé]pouse|ÉPOUSE|[Ee]pouse|EPOUSE|[Ff]ils${SP}+de|FILS${SP}+DE|[Ff]ille${SP}+de|FILLE${SP}+DE|[Ss]oussign[ée]e?(?:\(e\))?|SOUSSIGN[ÉE]E?(?:\(E\))?)`;
const CIVILITY_BREAK = String.raw`(?:${SP}|\r?\n)`;
const RX_IDENTITY_CIVILITY = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:${CIVILITY_DOT}${CIVILITY_BREAK}{0,4}|${CIVILITY_WORD}${CIVILITY_BREAK}{1,4})${NAME}`,
  'gu',
);
const IDENTITY_LABEL = String.raw`(?:noms?(?:${SP}*(?:et|&|/)${SP}*pr[ée]noms?)?|pr[ée]noms?|nom${SP}+(?:de${SP}+(?:jeune${SP}+fille|famille|naissance)|d['’]usage|marital|patronymique)|titulaire(?:${SP}+du${SP}+compte)?|b[ée]n[ée]ficiaire|souscripteur|assur[ée]e?|patiente?|employ[ée]e?|salari[ée]e?|locataire|bailleur|demandeu(?:r|se)|requ[ée]rante?|signataire|conjointe?|[ée]poux|[ée]pouse|p[èe]re|m[èe]re|cliente?|d[ée]funte?)`;
/** Libellé conservé (groupe 1) ; valeur masquée jusqu'en fin de ligne, « ; », « | », tabulation ou double espace (120 car. max). */
const RX_IDENTITY_LABELLED = new RegExp(
  String.raw`(?<![\p{L}])(${IDENTITY_LABEL}${SP}*(?:\(s\))?${SP}*:${SP}*(?:\r?\n${SP}*)?)((?:(?!${SP}{2}|\t)[^\n\r;|]){1,120})`,
  'giu',
);

type MaskFn = (text: string, replacement: string, hit: () => void) => string;

/** Remplace chaque correspondance ; `accept` peut la laisser en place (elle relèvera d'une autre étape). */
function regexMask(re: RegExp, accept?: (match: string) => boolean): MaskFn {
  return (text, replacement, hit) =>
    text.replace(re, (m: string) => {
      if (accept && !accept(m)) return m;
      hit();
      return replacement;
    });
}

/** Comme `regexMask`, mais conserve le libellé capturé en groupe 1 (« Tél : », « Nom : »…). */
function labelledMask(re: RegExp): MaskFn {
  return (text, replacement, hit) =>
    text.replace(re, (_m: string, label: string) => {
      hit();
      return `${label}${replacement}`;
    });
}

const isAsciiDigit = (code: number) => code >= 48 && code <= 57;

/**
 * Montants : (1) devise APRÈS le nombre — on repère la devise, puis on remonte le nombre à rebours
 * (un séparateur n'est franchi qu'entre deux chiffres) : linéaire, sans retour arrière de regex ;
 * (2) devise AVANT le nombre ; (3) nombre après un libellé (« Montant : 1 250 000 »).
 */
const maskAmounts: MaskFn = (text, replacement, hit) => {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(RX_AMOUNT_TAIL)) {
    const tailStart = m.index ?? 0;
    let start = tailStart;
    while (start > last) {
      const code = text.charCodeAt(start - 1);
      if (isAsciiDigit(code)) {
        start -= 1;
      } else if (
        AMOUNT_INNER_SEPARATORS.includes(text[start - 1] ?? '') &&
        start - 2 >= last &&
        isAsciiDigit(text.charCodeAt(start - 2)) &&
        isAsciiDigit(text.charCodeAt(start))
      ) {
        start -= 1;
      } else {
        break;
      }
    }
    if (start === tailStart) continue; // garde-fou : aucun chiffre (impossible vu l'assertion arrière)
    out += text.slice(last, start) + replacement;
    last = tailStart + m[0].length;
    hit();
  }
  out += text.slice(last);
  out = regexMask(RX_AMOUNT_PREFIX)(out, replacement, hit);
  return labelledMask(RX_AMOUNT_LABELLED)(out, replacement, hit);
};

function countDigits(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (isAsciiDigit(s.charCodeAt(i))) n += 1;
  return n;
}

/** Clé de Luhn (cartes bancaires). */
function luhnIsValid(match: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = match.length - 1; i >= 0; i -= 1) {
    const code = match.charCodeAt(i);
    if (!isAsciiDigit(code)) continue;
    let d = code - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** NIR : sans clé (13 caractères) accepté tel quel ; avec clé, clé = 97 − (n mod 97), Corse 2A→19, 2B→18. */
function nirIsValid(match: string): boolean {
  const compact = match.replace(/[^0-9AB]/gi, '').toUpperCase();
  if (compact.length === 13) return true;
  if (compact.length !== 15) return false;
  const body = compact.slice(0, 13).replace('2A', '19').replace('2B', '18');
  let r = 0;
  for (let i = 0; i < body.length; i += 1) r = (r * 10 + (body.charCodeAt(i) - 48)) % 97;
  return 97 - r === Number(compact.slice(13));
}

const MASK_EMAIL = regexMask(RX_EMAIL);
const MASK_IBAN = regexMask(RX_IBAN, (m) => countDigits(m) >= 10);
const MASK_PHONE_INTL = regexMask(RX_PHONE_INTL);
const MASK_PHONE_GROUPED = regexMask(RX_PHONE_GROUPED);
const MASK_PHONE_COMPACT = regexMask(RX_PHONE_COMPACT);
const MASK_PHONE_LABELLED = labelledMask(RX_PHONE_LABELLED);
const MASK_NIR = regexMask(RX_NIR, nirIsValid);
const MASK_CARD = regexMask(RX_CARD, luhnIsValid);
const MASK_RESIDUAL_NUMBER = regexMask(RX_RESIDUAL_NUMBER);
const MASK_IDENTITY_CIVILITY = regexMask(RX_IDENTITY_CIVILITY);
const MASK_IDENTITY_LABELLED = labelledMask(RX_IDENTITY_LABELLED);

/** Étapes d'une entité appliquée seule (règle `kind = 2`). */
const ENTITY_MASKERS: Record<GedAiMaskingEntity, readonly MaskFn[]> = {
  email: [MASK_EMAIL],
  phone: [MASK_PHONE_INTL, MASK_PHONE_GROUPED, MASK_PHONE_COMPACT, MASK_PHONE_LABELLED],
  amount: [maskAmounts],
  iban: [MASK_IBAN],
  card: [MASK_CARD],
  nir: [MASK_NIR],
  identity: [MASK_IDENTITY_CIVILITY, MASK_IDENTITY_LABELLED],
};

/**
 * Ordre du masquage par défaut (cloud, H1). Le plus spécifique d'abord : e-mail (contient des
 * chiffres), IBAN (lettres + chiffres), montants (ancrés sur la devise, avant qu'un « 2 000 000 000 »
 * ne passe pour un « 00… » international), téléphone international (un « +225 07 12 34 56 78 » de
 * 13 chiffres n'est JAMAIS une carte), NIR et carte (clés vérifiées), téléphones nationaux, filet
 * [NUMÉRO], puis identités (aucun marqueur ne commence par une capitale : pas de ré-absorption).
 */
const DEFAULT_PIPELINE: ReadonlyArray<{ fn: MaskFn; marker: string }> = [
  { fn: MASK_EMAIL, marker: GED_AI_MASKING_ENTITY_MARKERS.email },
  { fn: MASK_IBAN, marker: GED_AI_MASKING_ENTITY_MARKERS.iban },
  { fn: maskAmounts, marker: GED_AI_MASKING_ENTITY_MARKERS.amount },
  { fn: MASK_PHONE_INTL, marker: GED_AI_MASKING_ENTITY_MARKERS.phone },
  { fn: MASK_NIR, marker: GED_AI_MASKING_ENTITY_MARKERS.nir },
  { fn: MASK_CARD, marker: GED_AI_MASKING_ENTITY_MARKERS.card },
  { fn: MASK_PHONE_GROUPED, marker: GED_AI_MASKING_ENTITY_MARKERS.phone },
  { fn: MASK_PHONE_COMPACT, marker: GED_AI_MASKING_ENTITY_MARKERS.phone },
  { fn: MASK_PHONE_LABELLED, marker: GED_AI_MASKING_ENTITY_MARKERS.phone },
  { fn: MASK_RESIDUAL_NUMBER, marker: GED_AI_MASKING_RESIDUAL_NUMBER_MARKER },
  { fn: MASK_IDENTITY_CIVILITY, marker: GED_AI_MASKING_ENTITY_MARKERS.identity },
  { fn: MASK_IDENTITY_LABELLED, marker: GED_AI_MASKING_ENTITY_MARKERS.identity },
];

// ---------------------------------------------------------------------------
// Masquage — règles « texte exact »
// ---------------------------------------------------------------------------

const APOSTROPHES = '’‘ʼ`´';
const HYPHENS = '‐‑‒–—−';

/**
 * Repli caractère par caractère, de MÊME LONGUEUR (indices identiques au texte d'origine) :
 * minuscules, sans accents, espaces (dont sauts de ligne et insécables) → « ␠ », apostrophes → « ' »,
 * tirets → « - ». « KONE », « Koné » et « KONÉ » se retrouvent ainsi.
 */
function foldForExactMatch(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] ?? '';
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      out += code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d ? ' ' : ch.toLowerCase();
      continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      out += ch; // demi-paire de substitution : inchangée
      continue;
    }
    if (/\s/u.test(ch)) {
      out += ' ';
    } else if (APOSTROPHES.includes(ch)) {
      out += "'";
    } else if (HYPHENS.includes(ch)) {
      out += '-';
    } else {
      const base = ch.normalize('NFD')[0] ?? ch;
      const candidate = base.length === 1 ? base : ch;
      const lower = candidate.toLowerCase();
      out += lower.length === 1 ? lower : candidate;
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskExact(text: string, pattern: string, replacement: string, hit: () => void): string {
  const parts = foldForExactMatch(pattern.normalize('NFKC')).trim().split(/ +/);
  const re = new RegExp(parts.map(escapeRegExp).join(' +'), 'gu');
  const folded = foldForExactMatch(text);
  let out = '';
  let last = 0;
  for (const m of folded.matchAll(re)) {
    const index = m.index ?? 0;
    out += text.slice(last, index) + replacement;
    last = index + m[0].length;
    hit();
  }
  return out + text.slice(last);
}

// ---------------------------------------------------------------------------
// Masquage — validation des règles (anti-ReDoS) et application
// ---------------------------------------------------------------------------

/**
 * Analyse statique d'une regex d'administrateur : renvoie la raison du refus, ou `null`. Le moteur
 * JS n'est pas interruptible : une regex coûteuse bloquerait le fil d'exécution de l'API ou du
 * worker. Sont refusés : rétro-références ; répétitions ILLIMITÉES (`*`, `+`, `{n,}` — même
 * `[a-z]+\d+` coûte un temps quadratique, 48 s mesurées sur 200 000 caractères) ; bornes au-delà de
 * `GED_AI_MASKING_REGEX_MAX_REPEAT` ; quantificateurs imbriqués et alternatives répétées (explosion
 * exponentielle) ; produit des amplitudes des quantificateurs variables au-delà de
 * `GED_AI_MASKING_REGEX_MAX_COST`. Volontairement conservatrice : un motif refusé se réécrit avec
 * des bornes explicites (`\d{1,20}` au lieu de `\d+`).
 */
function regexRiskReason(pattern: string): string | null {
  interface Frame {
    variable: boolean;
    alternation: boolean;
  }
  const newFrame = (): Frame => ({ variable: false, alternation: false });
  const stack: Frame[] = [newFrame()];
  const top = () => stack[stack.length - 1] ?? newFrame();
  /** Dernier élément quantifiable : `null` (rien ou assertion), atome (`group: null`) ou groupe fermé. */
  let prev: { group: Frame | null } | null = null;
  let cost = 1;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] ?? '';
    if (c === '\\') {
      const n = pattern[i + 1] ?? '';
      if (/[1-9]/.test(n) || n === 'k') return 'rétro-référence interdite.';
      if ((n === 'p' || n === 'P' || n === 'u') && pattern[i + 2] === '{') {
        const close = pattern.indexOf('}', i + 2);
        i = close < 0 ? pattern.length : close + 1;
      } else {
        i += 2;
      }
      prev = n === 'b' || n === 'B' ? null : { group: null };
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      i = j + 1;
      prev = { group: null };
      continue;
    }
    if (c === '(') {
      if (pattern.startsWith('(?<=', i) || pattern.startsWith('(?<!', i)) i += 4;
      else if (pattern.startsWith('(?=', i) || pattern.startsWith('(?!', i) || pattern.startsWith('(?:', i)) i += 3;
      else if (pattern.startsWith('(?<', i)) {
        const close = pattern.indexOf('>', i);
        i = close < 0 ? pattern.length : close + 1;
      } else i += 1;
      stack.push(newFrame());
      prev = null;
      continue;
    }
    if (c === ')') {
      const frame = stack.length > 1 ? (stack.pop() ?? newFrame()) : newFrame();
      const parent = top();
      parent.variable = parent.variable || frame.variable;
      parent.alternation = parent.alternation || frame.alternation;
      prev = { group: frame };
      i += 1;
      continue;
    }
    if (c === '|') {
      top().alternation = true;
      prev = null;
      i += 1;
      continue;
    }
    if (c === '*' || c === '+' || c === '?' || c === '{') {
      let min: number;
      let max: number;
      if (c === '{') {
        const q = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i, i + 24));
        if (!q) return 'quantificateur incorrect.';
        min = Number(q[1]);
        max = q[2] === undefined ? min : q[3] === '' ? Infinity : Number(q[3]);
        i += q[0].length;
      } else {
        min = c === '+' ? 1 : 0;
        max = c === '?' ? 1 : Infinity;
        i += 1;
      }
      if (pattern[i] === '?') i += 1; // quantificateur paresseux
      if (max === Infinity) {
        return 'répétition illimitée (*, +, {n,}) interdite : utilisez une borne explicite, ex. \\d{1,20}.';
      }
      if (min > GED_AI_MASKING_REGEX_MAX_REPEAT || max > GED_AI_MASKING_REGEX_MAX_REPEAT) {
        return `borne de répétition trop grande (${GED_AI_MASKING_REGEX_MAX_REPEAT} au plus).`;
      }
      if (prev?.group && max > 1 && (prev.group.variable || prev.group.alternation)) {
        return 'quantificateurs imbriqués ou alternative répétée (risque de blocage).';
      }
      if (max !== min) {
        top().variable = true;
        cost *= max - min + 1;
        if (cost > GED_AI_MASKING_REGEX_MAX_COST) {
          return 'trop de combinaisons possibles (réduisez les amplitudes {min,max}).';
        }
      }
      prev = null;
      continue;
    }
    prev = c === '^' || c === '$' ? null : { group: null };
    i += 1;
  }
  return null;
}

function normalizeEntityCode(pattern: string): GedAiMaskingEntity | null {
  const code = pattern.trim().toLowerCase();
  return (GED_AI_MASKING_ENTITIES as readonly string[]).includes(code) ? (code as GedAiMaskingEntity) : null;
}

/**
 * Valide une règle de masquage (à appeler aussi À L'ENREGISTREMENT d'une règle) : renvoie le
 * message d'erreur (« Règle de masquage invalide : … »), ou `null` si elle est acceptable. Le
 * message ne cite jamais le motif (il peut contenir un nom de personne).
 */
export function validateAiMaskingRule(rule: GedAiMaskingRuleDef): string | null {
  const invalid = (why: string) => `Règle de masquage invalide : ${why}`;
  if (!rule || typeof rule !== 'object') return invalid('règle absente.');
  const { kind, pattern, replacement } = rule;
  if (typeof pattern !== 'string' || pattern.trim() === '' || pattern.length > GED_AI_MASKING_PATTERN_MAX_LENGTH) {
    return invalid('motif vide ou trop long.');
  }
  if (
    replacement !== null &&
    replacement !== undefined &&
    (typeof replacement !== 'string' || replacement.length > GED_AI_MASKING_REPLACEMENT_MAX_LENGTH)
  ) {
    return invalid('texte de remplacement trop long.');
  }
  if (kind === GedAiMaskingKind.Exact) return null;
  if (kind === GedAiMaskingKind.Entite) {
    return normalizeEntityCode(pattern)
      ? null
      : invalid(`entité inconnue (attendu : ${GED_AI_MASKING_ENTITIES.join(', ')}).`);
  }
  if (kind !== GedAiMaskingKind.Regex) return invalid('type de règle inconnu.');
  try {
    new RegExp(pattern, 'giu');
  } catch {
    return invalid('expression régulière incorrecte.');
  }
  const risk = regexRiskReason(pattern);
  if (risk) return invalid(risk);
  // Correspondance vide (`x?`, `\b`, `(?=x)`) : le remplacement s'insérerait partout. Sondage sur le
  // texte vide et sur un échantillon contenant le motif lui-même ; l'exécution le revérifie.
  const sample = `${pattern} Aa1 _-.,@\n`;
  if (new RegExp(pattern, 'u').test('') || [...sample.matchAll(new RegExp(pattern, 'giu'))].some((m) => m[0] === '')) {
    return invalid('le motif peut correspondre à un texte vide.');
  }
  return null;
}

/**
 * Masque `text` : d'abord les règles configurées (regex, texte exact, entité), puis — si
 * `includeDefaults` (cas cloud, H1) — TOUTES les entités prédéfinies et le filet [NUMÉRO]. Échoue
 * FERMÉ : une règle invalide ou dangereuse (cf. `validateAiMaskingRule`), un texte trop long ou
 * une correspondance vide lèvent une erreur au lieu d'être ignorés (un masquage silencieusement
 * affaibli enverrait la donnée en clair). Le texte est normalisé NFKC (chiffres et « @ » pleine
 * chasse, espaces insécables) avant tout traitement : le texte renvoyé est cette forme normalisée.
 */
export function applyAiMasking(
  text: string,
  rules: readonly GedAiMaskingRuleDef[],
  options: { includeDefaults?: boolean } = {},
): GedAiMaskingResult {
  if (typeof text !== 'string') throw new Error('Masquage impossible : texte absent.');
  const tooLong = () =>
    new Error(`Masquage impossible : texte trop long (${GED_AI_MASKING_MAX_TEXT_CHARS} caractères au plus).`);
  if (text.length > GED_AI_MASKING_MAX_TEXT_CHARS) throw tooLong();
  // Toutes les règles sont validées AVANT tout traitement : rien n'est appliqué à moitié.
  for (const rule of rules) {
    const error = validateAiMaskingRule(rule);
    if (error) throw new Error(error);
  }

  let out = text.normalize('NFKC');
  if (out.length > GED_AI_MASKING_MAX_TEXT_CHARS) throw tooLong();
  let count = 0;
  const hit = () => {
    count += 1;
  };

  for (const rule of rules) {
    if (rule.kind === GedAiMaskingKind.Exact) {
      out = maskExact(out, rule.pattern, rule.replacement ?? GED_AI_DEFAULT_MASKING_REPLACEMENT, hit);
    } else if (rule.kind === GedAiMaskingKind.Entite) {
      const entity = normalizeEntityCode(rule.pattern);
      if (!entity) throw new Error('Règle de masquage invalide : entité inconnue.');
      const replacement = rule.replacement ?? GED_AI_MASKING_ENTITY_MARKERS[entity];
      for (const fn of ENTITY_MASKERS[entity]) out = fn(out, replacement, hit);
    } else {
      const replacement = rule.replacement ?? GED_AI_DEFAULT_MASKING_REPLACEMENT;
      out = out.replace(new RegExp(rule.pattern, 'giu'), (m: string) => {
        if (m === '') throw new Error('Règle de masquage invalide : le motif peut correspondre à un texte vide.');
        hit();
        return replacement;
      });
    }
  }

  if (options?.includeDefaults) {
    for (const step of DEFAULT_PIPELINE) out = step.fn(out, step.marker, hit);
  }
  return { text: out, count };
}

/** Écart toléré autour de [0, 1] (arrondis flottants) avant de rejeter un score. */
const CONFIDENCE_EPSILON = 1e-6;

/**
 * Ramène un score de confiance dans [0, 1], tronqué (jamais arrondi vers le haut) au millième ;
 * `null` si absent, non numérique ou HORS ÉCHELLE (ex. 85 pour « 85 % ») : mieux vaut « pas de
 * score » (décision à valider) qu'un 1 trompeur qui déclencherait une application automatique.
 */
export function clampConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < -CONFIDENCE_EPSILON || value > 1 + CONFIDENCE_EPSILON) return null;
  const truncated = Math.floor(value * 1000 + 1e-9) / 1000;
  return Math.min(1, Math.max(0, truncated));
}

const isUnitScore = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Statut initial d'une décision réussie. Application automatique SEULEMENT si un seuil est défini
 * (`null` = jamais), qu'un score existe et qu'il atteint le seuil, et que l'appelant l'autorise.
 * Seuil ou score non fini ou hors [0, 1] : traité comme absent. Tout le reste attend une
 * validation humaine.
 */
export function decideAiStatus(
  confidence: number | null,
  threshold: number | null,
  autoApplyAllowed = true,
): typeof GedAiDecisionStatus.Proposee | typeof GedAiDecisionStatus.AppliqueeAuto {
  if (autoApplyAllowed !== true || !isUnitScore(threshold) || !isUnitScore(confidence)) {
    return GedAiDecisionStatus.Proposee;
  }
  return confidence >= threshold ? GedAiDecisionStatus.AppliqueeAuto : GedAiDecisionStatus.Proposee;
}

/**
 * Extrait d'entrée pour le journal : tronqué à `GED_AI_INPUT_EXCERPT_MAX_CHARS` (+ « … »). Déjà
 * masqué par l'appelant. Le caractère NUL (refusé par PostgreSQL) devient U+FFFD et la coupe ne
 * sépare jamais une paire de substitution.
 */
export function buildInputExcerpt(maskedText: string): string {
  const safe = maskedText.split('\u0000').join('�');
  if (safe.length <= GED_AI_INPUT_EXCERPT_MAX_CHARS) return safe;
  let cut = GED_AI_INPUT_EXCERPT_MAX_CHARS;
  const lastCode = safe.charCodeAt(cut - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1;
  return `${safe.slice(0, cut)}…`;
}

/** Sortie de la tâche Classement. */
export const gedAiClassificationOutputSchema = z.object({
  documentTypeId: z.number().int().nullable(),
  documentTypeLabel: z.string().nullable(),
  confidence: z.number(),
  rationale: z.string().nullable(),
});
export type GedAiClassificationOutput = z.infer<typeof gedAiClassificationOutputSchema>;

/** Sortie de la tâche Extraction de métadonnées. */
export const gedAiExtractionOutputSchema = z.object({
  title: z.string().nullable(),
  date: z.string().nullable(),
  reference: z.string().nullable(),
  summary: z.string().nullable(),
  confidence: z.number(),
});
export type GedAiExtractionOutput = z.infer<typeof gedAiExtractionOutputSchema>;

const nullableJson = (type: 'string' | 'integer' | 'number', description: string) => ({
  anyOf: [{ type }, { type: 'null' }],
  description,
});

/** JSON Schema (sortie structurée stricte) — tous les champs requis, nullables. */
export const GED_AI_CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['documentTypeId', 'documentTypeLabel', 'confidence', 'rationale'],
  properties: {
    documentTypeId: nullableJson(
      'integer',
      'Identifiant du type de document, STRICTEMENT dans la liste fournie ; null sinon.',
    ),
    documentTypeLabel: nullableJson('string', 'Libellé du type retenu.'),
    confidence: { type: 'number', description: 'Confiance entre 0 et 1.' },
    rationale: nullableJson('string', 'Justification en une phrase.'),
  },
} as const;

export const GED_AI_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'date', 'reference', 'summary', 'confidence'],
  properties: {
    title: nullableJson('string', 'Intitulé du document.'),
    date: nullableJson('string', 'Date du document au format AAAA-MM-JJ.'),
    reference: nullableJson('string', 'Référence ou numéro du document.'),
    summary: nullableJson('string', 'Résumé en deux ou trois phrases.'),
    confidence: { type: 'number', description: 'Confiance entre 0 et 1.' },
  },
} as const;

/** Champs du document qu'une décision validée (ou appliquée automatiquement) peut renseigner. */
export interface GedAiDocumentPatch {
  documentTypeId?: number;
  /** AAAA-MM-JJ, date réelle. */
  documentDate?: string;
  overview?: string;
}

/** Longueur maximale du résumé reporté dans `document.overview`. */
export const GED_AI_OVERVIEW_MAX_CHARS = 4000;
/** Années admises pour `document_date` (au-delà : hallucination probable, champ non renseigné). */
export const GED_AI_DOCUMENT_DATE_MIN_YEAR = 1000;
export const GED_AI_DOCUMENT_DATE_MAX_YEAR = 2100;
/** Plus grand identifiant accepté (`int4` PostgreSQL). */
const PG_INT4_MAX = 2_147_483_647;

/** Date calendaire réelle AAAA-MM-JJ dans les bornes, sinon `null` (30 février, 2026-13-01, …). */
function validDocumentDate(raw: string | null): string | null {
  if (!raw) return null;
  const d = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const year = Number(d.slice(0, 4));
  if (year < GED_AI_DOCUMENT_DATE_MIN_YEAR || year > GED_AI_DOCUMENT_DATE_MAX_YEAR) return null;
  const check = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === d ? d : null;
}

/** Résumé assaini : sans caractères de contrôle (sauf \t \n \r) ni demi-paires, rogné, plafonné. */
function cleanOverview(raw: string | null): string | null {
  if (!raw) return null;
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    const control = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f);
    const loneSurrogate = c >= 0xd800 && c <= 0xdfff;
    if (!control && !loneSurrogate) out += ch;
  }
  out = out.trim();
  if (out.length > GED_AI_OVERVIEW_MAX_CHARS) {
    let cut = GED_AI_OVERVIEW_MAX_CHARS;
    const lastCode = out.charCodeAt(cut - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1;
    out = out.slice(0, cut).trimEnd();
  }
  return out === '' ? null : out;
}

/**
 * Patch de document déduit d'une sortie IA. Ne porte que des champs renseignés et valides ; le
 * service qui l'applique ne remplit QUE les champs encore vides du document (jamais d'écrasement).
 * Identifiant de type : entier strictement positif (`int4`) ; l'appartenance à la liste fournie
 * reste à vérifier par l'appelant.
 */
export function buildDocumentPatch(task: GedAiTask, output: unknown): GedAiDocumentPatch {
  if (task === GedAiTask.Classement) {
    const parsed = gedAiClassificationOutputSchema.safeParse(output);
    if (!parsed.success) return {};
    const id = parsed.data.documentTypeId;
    return id !== null && Number.isSafeInteger(id) && id > 0 && id <= PG_INT4_MAX ? { documentTypeId: id } : {};
  }
  if (task === GedAiTask.ExtractionMetadonnees) {
    const parsed = gedAiExtractionOutputSchema.safeParse(output);
    if (!parsed.success) return {};
    const patch: GedAiDocumentPatch = {};
    const date = validDocumentDate(parsed.data.date);
    if (date) patch.documentDate = date;
    const overview = cleanOverview(parsed.data.summary);
    if (overview) patch.overview = overview;
    return patch;
  }
  return {};
}
