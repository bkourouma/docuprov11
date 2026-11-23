/**
 * Aides GED : documents ARCHIVÉS (`document.is_archived = true`) fabriqués par l'API, sans
 * dépendre des aides d'un autre lot.
 *
 * Chemin retenu (le plus court et synchrone) : un PDF déposé dans la file « Documents scannés »
 * puis promu par un courrier Départ (`createPdfDocument`), puis validé par l'indexation
 * (`PATCH /documents/:id/indexation { validate: true }`, qui bascule `is_archived = true` — c'est
 * le geste de QA de l'acquisition). La validation pose aussi le cachet serveur (`sealIfNeeded`).
 *
 * Seuls les documents archivés entrent dans la recherche documentaire (repli plein texte de la
 * recherche IA compris) et dans l'analyse de gouvernance (`ANALYZABLE` du worker).
 */
import { createPdfDocument, minimalPdf, type GedDocsApi, type TestDocument } from './documents';

/** Valide (archive) un document existant. */
export async function validateDocument(api: GedDocsApi, documentId: number): Promise<void> {
  await api.patch(`/documents/${documentId}/indexation`, { validate: true });
  const detail = await api.get<{ isArchived?: boolean }>(`/documents/${documentId}`);
  if (detail.isArchived === false) {
    throw new Error(`Document ${documentId} toujours non archivé après validation`);
  }
}

/** Document PDF archivé ; `pdf` fixe son contenu (deux appels avec le même PDF : doublons exacts). */
export async function createArchivedDocument(
  api: GedDocsApi,
  label: string,
  pdf: Buffer = minimalPdf(label),
): Promise<TestDocument> {
  const doc = await createPdfDocument(api, label, pdf);
  await validateDocument(api, doc.documentId);
  return doc;
}

/** Terme de recherche d'un seul mot (lettres et chiffres), unique : `uniq()` sans séparateurs. */
export function searchTerm(uniqValue: string): string {
  return uniqValue.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}
