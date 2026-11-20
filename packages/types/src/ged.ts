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
