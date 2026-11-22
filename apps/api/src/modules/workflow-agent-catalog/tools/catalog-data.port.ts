import type { AuthUser } from '../../auth/auth.types';
import type { DeclaredDelegates } from '../catalog.contracts';
import type { CompareField } from './piece-fields';

/** Jeton d'injection du port de données des outils du catalogue. */
export const WF_CATALOG_DATA = 'WF_CATALOG_DATA';

/** Courrier lisible par le lanceur (champs d'identification seulement). */
export interface CatalogMailRef {
  mailId: number;
  reference: string | null;
  title: string | null;
}

/** Imputation vue du lanceur, SANS instructions libres. */
export interface SimilarMailImputation {
  mailInputationId: number;
  actorUserGroupId: number;
  actorLabel: string;
  typeId: number;
  typeLabel: string;
  /** Délai en jours calendaires entre la création et l'échéance ; `null` sans échéance. */
  delayDays: number | null;
  treated: boolean;
}

export interface SimilarMail extends CatalogMailRef {
  natureLabel: string | null;
  date: string | null;
  imputations: SimilarMailImputation[];
}

export interface ImputableActorView {
  userGroupId: number;
  label: string;
  roleName: string | null;
  organigrammeLabel: string | null;
}

export interface InputationTypeView {
  id: number;
  label: string;
  suivi: boolean;
}

export interface ImputableOverview {
  actors: ImputableActorView[];
  types: InputationTypeView[];
}

/** Cible d'une liste de pièces : exactement une des trois. */
export type PieceTarget = { mailId: number } | { documentId: number } | { dossierId: number };

export interface PieceView {
  documentId: number;
  label: string;
  documentTypeLabel: string | null;
  documentDate: string | null;
  cote: string | null;
  pageCount: number | null;
  /** Extrait court des métadonnées (montant, date, objet), `null` si aucune. */
  metadataExcerpt: string | null;
}

/** Valeurs brutes d'une pièce ACCESSIBLE pour la comparaison (aucune normalisation ici). */
export interface PieceFields {
  documentId: number;
  label: string;
  /** Pour chaque champ trouvé : valeur brute et preuve courte (libellé de la métadonnée + valeur). */
  values: Partial<Record<CompareField, { raw: string; evidence: string }>>;
}

/** Imputation d'un courrier lisible, telle que vue du lanceur. */
export interface InputationView {
  mailInputationId: number;
  mailId: number;
  mailReference: string | null;
  mailTitle: string | null;
  /** Acteur imputé. */
  userGroupId: number;
  actorLabel: string;
  actorActive: boolean;
  typeLabel: string;
  deadline: Date | null;
  dateTreated: Date | null;
  createdBy: number | null;
}

export interface RelanceCounts {
  /** Relances internes déjà envoyées aujourd'hui (UTC) à ce destinataire pour ce courrier. */
  target: number;
  /** Relances de l'instance déjà appliquées aujourd'hui (UTC). */
  instance: number;
}

export interface DraftTemplateView {
  id: string;
  label: string;
  skeletonHtml: string;
}

export interface DraftGenerationRequest {
  templateId: string;
  instruction: string;
  contextDocumentIds?: number[];
  dossierId?: number;
}

/** Résultat d'une génération : jamais d'exception pour une cause métier (IA désactivée, refus, plafond). */
export type DraftGenerationResult =
  | { status: 'ok'; draftHtml: string; decisionId: string | null; contextDocumentCount: number }
  | { status: 'disabled'; message: string }
  | { status: 'refused'; message: string };

/**
 * Accès des outils du catalogue aux données, TOUJOURS au nom du lanceur (`user`). `null` signifie
 * « refus OU introuvable » : jamais distingués.
 */
export interface CatalogDataPort {
  /** Courrier lisible par le lanceur (règle d'accès de `AgentDataAdapter.readMail`). */
  readMail(user: AuthUser, mailId: number): Promise<CatalogMailRef | null>;

  /** Courriers archivés semblables à `mailId`, filtrés un à un par les droits du lanceur. `null` : source illisible. */
  findSimilarMails(user: AuthUser, mailId: number, limit: number): Promise<SimilarMail[] | null>;

  /** Acteurs imputables par le lanceur et types d'imputation ACTIFS du référentiel. */
  readImputables(user: AuthUser, opts: { search?: string; limit: number }): Promise<ImputableOverview>;
  /** Le lanceur a-t-il le droit d'imputer (un des menus d'imputation, ou administrateur) ? */
  canImpute?(user: AuthUser): Promise<boolean>;
  /** Acteur existant, actif et imputable par le lanceur ; sinon `null`. */
  resolveImputableActor(user: AuthUser, userGroupId: number): Promise<{ userGroupId: number; label: string } | null>;
  /** Acteur existant et dont le compte n'est pas désactivé ; sinon `null`. */
  resolveActiveActor(userGroupId: number): Promise<{ userGroupId: number; label: string } | null>;
  /** Ligne ACTIVE du référentiel `mail_inputation_type`, ou `null`. */
  getActiveInputationType(id: number): Promise<InputationTypeView | null>;
  /** Une imputation NON traitée existe-t-elle déjà pour (courrier, acteur, type) ? */
  hasOpenImputation(mailId: number, userGroupId: number, typeId: number): Promise<boolean>;

  /** Pièces filtrées par `DocumentsService.canAccess` ; `null` : objet inaccessible ou inexistant. Au plus `limit`. */
  listPieces(user: AuthUser, target: PieceTarget, limit: number): Promise<PieceView[] | null>;
  /** Valeurs brutes des pièces ACCESSIBLES parmi `documentIds` (les autres sont omises sans distinction). */
  readPieceFields(user: AuthUser, documentIds: number[]): Promise<PieceFields[]>;

  /** Imputation d'un courrier lisible ; `null` si le courrier est illisible OU l'imputation n'est pas de ce courrier. */
  readInputation(user: AuthUser, mailId: number, mailInputationId: number): Promise<InputationView | null>;
  /** Plafonds de relances du jour (UTC). `instanceId` null : compteur d'instance à 0. */
  countRelances(mailId: number, recipientUserGroupId: number, instanceId: string | null, now: Date): Promise<RelanceCounts>;
  /** Délégataires DÉCLARÉS de l'étape agent (`step.config.delegates`) ; invalide ou absent : liste vide. */
  readDeclaredDelegates(instanceId: string, stepKey: string): Promise<DeclaredDelegates>;

  /** Modèle de rédaction (un des 8), ou `null` s'il est inconnu. */
  getDraftTemplate(templateId: string): Promise<DraftTemplateView | null>;
  /**
   * Génère un brouillon avec les droits du lanceur (jamais d'envoi, jamais d'écriture), budget réservé
   * (réserver, régler, libérer en cas d'échec). N'est PAS appelée en évaluation (`dryRun`).
   */
  generateDraft(user: AuthUser, request: DraftGenerationRequest, instanceId: string | null): Promise<DraftGenerationResult>;
}
