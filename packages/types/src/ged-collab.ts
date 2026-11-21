// Contrat REST de l'éditeur natif collaboratif (lot 4b). Ajouts non cassants.
import type { GedDocumentVersionRow } from './ged-spaces';

/** Extension de la pièce « état Yjs » : sa présence dans la version courante identifie un document texte natif. */
export const GED_COLLAB_STATE_EXTENSION = '.ydoc';
/** Extension de la pièce « instantané HTML assaini » de la même version. */
export const GED_COLLAB_SNAPSHOT_EXTENSION = '.html';
/** Chemin WebSocket (Hocuspocus) ; le jeton JWT est envoyé dans le protocole, jamais dans l'URL. */
export const GED_COLLAB_WS_PATH = '/api/collab';

export type GedCollabMode = 'write' | 'read';

/** GET /collab/documents/:id/session */
export interface GedCollabSession {
  documentId: number;
  label: string;
  mode: GedCollabMode;
  wsPath: string;
  currentVersionNumber: number;
  /** Identité d'édition (curseur, commentaires, mentions). */
  me: { userGroupId: number; name: string };
}

/** POST /collab/documents  { spaceId, label } */
export interface GedCollabCreateRequest {
  spaceId: number;
  label: string;
}
/** Réponse de POST /collab/documents et de POST /collab/documents/import (multipart : file, spaceId, label?). */
export interface GedCollabCreated {
  documentId: number;
  label: string;
  warnings: string[];
}

/** POST /collab/documents/:id/versions  { changeSummary? } */
export interface GedCollabSaveVersionRequest {
  changeSummary?: string;
}
export interface GedCollabSaveVersionResult {
  /** false = contenu identique à la version courante, rien créé. */
  created: boolean;
  version: GedDocumentVersionRow | null;
}

/** POST /collab/documents/:id/restore  { versionId, changeSummary? } -> GedDocumentVersionRow */
export interface GedCollabRestoreRequest {
  versionId: number;
  changeSummary?: string;
}

/** POST /collab/documents/:id/import (multipart : file) — remplace le contenu après instantané « avant import ». */
export interface GedCollabImportResult {
  warnings: string[];
}

/** GET /collab/documents/:id/mention-candidates?q= — au plus 10, uniquement des acteurs ayant déjà accès au document. */
export interface GedCollabMentionCandidate {
  userGroupId: number;
  name: string;
}
