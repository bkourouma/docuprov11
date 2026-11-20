/**
 * CONTRAT du module collab (posé par le chef de lot, LECTURE SEULE pour les exécutants).
 * T1 (serveur WebSocket / accès) et T2 (persistance / REST) codent contre ces interfaces ; les
 * classes concrètes (`CollabServerService`, `CollabAccessService`, `CollabPersistenceService`)
 * les implémentent. Les tests de chaque tâche mockent l'autre côté via ces ports.
 */
import type * as Y from 'yjs';
import type { AuthUser } from '../auth/auth.types';

/** Chemin WebSocket (sans préfixe de proxy) : `ws(s)://hôte/api/collab`. */
export const COLLAB_WS_PATH = '/api/collab';

/** Codes de fermeture applicatifs (4000-4999). Aucun détail sur l'existence du document. */
export const CollabCloseCode = {
  /** Authentification absente/invalide/expirée, OU document inaccessible (volontairement identique). */
  Unauthorized: 4401,
  /** Message trop gros / débit dépassé. */
  PolicyViolation: 4409,
  /** Salle réinitialisée (restauration de version) : le client doit se reconnecter. */
  Reload: 4410,
} as const;

/** Nom de salle Hocuspocus = id du document en décimal strict (`/^[1-9]\d{0,9}$/`). */
export type CollabMode = 'write' | 'read';

export type CollabVersionReason = 'manual' | 'close' | 'idle' | 'import' | 'before-import';

export interface CollabLoadResult {
  documentId: number;
  label: string;
  /** État Yjs à charger ; `null` = document neuf (partir du ydoc vide). */
  state: Uint8Array | null;
  /** `document_version_id` de la version courante dont dérive l'état chargé. */
  baseVersionId: number;
}

export interface CollabVersionResult {
  documentVersionId: number;
  versionNumber: number;
}

/** Implémenté par T2 (`persistence/collab-persistence.service.ts`, classe `CollabPersistenceService`). */
export interface CollabPersistencePort {
  /** `null` si le document n'existe pas OU n'est pas un document texte natif. Ne contrôle PAS les droits. */
  loadDocument(documentId: number): Promise<CollabLoadResult | null>;
  /** Autosave : état de travail sur disque (ARCHIVES/collab), SANS créer de version. */
  saveWorkingState(documentId: number, state: Uint8Array, baseVersionId: number): Promise<void>;
  /** Supprime l'état de travail (après restauration/réinitialisation). */
  discardWorkingState(documentId: number): Promise<void>;
  /**
   * Crée une version (pièces `.ydoc` = état + `.html` = instantané assaini, empreinte SHA-256) via
   * le module doc-versions. Renvoie `null` si le contenu est identique à la version courante.
   * `user` null = système (fermeture de salle) : le serveur passe le dernier auteur connu.
   */
  createVersion(
    documentId: number,
    state: Uint8Array,
    user: AuthUser | null,
    opts: { reason: CollabVersionReason; changeSummary?: string | null },
  ): Promise<CollabVersionResult | null>;
  /**
   * Notifie (module notifications) les NOUVELLES mentions, idempotent. Le registre des ids déjà
   * notifiés est tenu CÔTÉ SERVEUR (fichier d'état serveur, hors Y.Doc : un écrivain ne peut ni le
   * réécrire ni s'en servir pour faire taire ou répéter une notification).
   * `opts.mentionIds` : si fourni, seuls ces ids (déjà attribués à `actor` par le serveur, par
   * comparaison avant/après de la modification de sa connexion) sont notifiés ; sinon tous les
   * nouveaux ids du ydoc (comportement historique, utilisé hors connexion).
   * N'envoie qu'aux destinataires qui ont déjà accès au document (`DocumentsService.canAccess`) :
   * une mention ne donne jamais de droit.
   */
  notifyMentions(
    documentId: number,
    ydoc: Y.Doc,
    actor: AuthUser,
    opts?: { mentionIds?: readonly number[] },
  ): Promise<void>;
}

/** Implémenté par T1 (`server/collab-server.service.ts`, classe `CollabServerService`). */
export interface CollabServerPort {
  /** État encodé de la salle vivante, ou `null` si aucune salle ouverte pour ce document. */
  getLiveState(documentId: number): Uint8Array | null;
  /** Applique une mutation au document vivant (diffusée aux clients) via connexion directe. */
  mutateDocument(documentId: number, mutator: (ydoc: Y.Doc) => void, actor: AuthUser): Promise<void>;
  /** Ferme les connexions (code `Reload`) et abandonne la salle ; recharge depuis la persistance à la prochaine ouverture. */
  resetRoom(documentId: number): Promise<void>;
}

/** Implémenté par T1 (`access/collab-access.service.ts`, classe `CollabAccessService`). */
export interface CollabAccessPort {
  /** Vérifie le JWT existant (même secret/algo que `JwtStrategy`) ; jette si invalide/expiré. */
  authenticate(token: string): Promise<AuthUser>;
  /**
   * `null` = refus (traité comme 404 uniforme). Ordre : `DocumentsService.canAccess` d'abord, puis
   * niveau effectif >= 3 => `write`, sinon `read`. Aucune règle d'espace n'élargit l'accès.
   */
  resolveMode(documentId: number, user: AuthUser): Promise<CollabMode | null>;
}
