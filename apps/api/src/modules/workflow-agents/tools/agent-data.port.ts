import type { AuthUser } from '../../auth/auth.types';

/** Jeton d'injection du port de données des outils. */
export const WF_AGENT_DATA = 'WF_AGENT_DATA';

export interface AgentDocumentHit {
  documentId: number;
  label: string;
  excerpt: string;
}

export interface AgentDocumentView {
  documentId: number;
  label: string;
  documentTypeLabel: string | null;
  documentDate: string | null;
  cote: string | null;
  overview: string | null;
  excerpts: string[];
}

export interface AgentMailView {
  mailId: number;
  reference: string | null;
  title: string | null;
  date: string | null;
  senderLabel: string | null;
  natureLabel: string | null;
  objetLabel: string | null;
  confidentialiteLabel: string | null;
  documents: Array<{ documentId: number; label: string }>;
  text: string | null;
}

/**
 * Accès de l'agent aux données, TOUJOURS au nom de l'utilisateur lanceur (`user`).
 * Règle : `null` signifie « refus OU introuvable », sans jamais les distinguer (même réponse).
 */
export interface WfAgentDataPort {
  searchDocuments(user: AuthUser, query: string, limit: number): Promise<AgentDocumentHit[]>;
  readDocument(user: AuthUser, documentId: number, maxChars: number): Promise<AgentDocumentView | null>;
  readMail(user: AuthUser, mailId: number, maxChars: number): Promise<AgentMailView | null>;
  targetExists(kind: 'user' | 'role', id: number): Promise<boolean>;
}
