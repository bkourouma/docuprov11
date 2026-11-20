import type { GedDocumentVersionRow } from '@archivage/types';
import { API_BASE, apiJson } from './api';

/**
 * Client des versions d'un document (historique, nouvelle version, restauration).
 *
 * Les types viennent du contrat partagé (`@archivage/types`) : l'API et le web ne peuvent pas
 * diverger sur la forme d'une ligne de version.
 */

function authHeader(): Record<string, string> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Message d'erreur de l'API (409 contenu identique, 403…) plutôt qu'un « HTTP 4xx » muet. */
async function readError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  return new Error(typeof body.message === 'string' ? body.message : `HTTP ${res.status}`);
}

const contentPath = (documentId: number, versionId: number, fileId: number) =>
  `${API_BASE}/documents/${documentId}/versions/${versionId}/files/${fileId}/content`;

export const docVersionsApi = {
  list: (documentId: number) =>
    apiJson<GedDocumentVersionRow[]>(`/documents/${documentId}/versions`),

  /**
   * Dépose un nouveau PDF (multipart). Pas d'`apiJson` : il force `Content-Type: application/json`,
   * alors que le navigateur doit poser lui-même celui du FormData (avec son boundary). On
   * n'utilise pas non plus `apiUpload`, qui perd le message de l'API (indispensable pour le 409).
   */
  async create(
    documentId: number,
    file: File,
    opts: { changeSummary?: string; comment?: string } = {},
  ): Promise<GedDocumentVersionRow> {
    const body = new FormData();
    body.append('file', file);
    const summary = opts.changeSummary?.trim();
    const comment = opts.comment?.trim();
    if (summary) body.append('changeSummary', summary);
    if (comment) body.append('comment', comment);
    const res = await fetch(`${API_BASE}/documents/${documentId}/versions`, {
      method: 'POST',
      headers: authHeader(),
      body,
    });
    if (!res.ok) throw await readError(res);
    return res.json() as Promise<GedDocumentVersionRow>;
  },

  restore: (documentId: number, versionId: number, changeSummary?: string) =>
    apiJson<GedDocumentVersionRow>(`/documents/${documentId}/versions/${versionId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ changeSummary: changeSummary?.trim() || undefined }),
    }),

  contentPath,

  /**
   * Ouvre le PDF d'une version dans un nouvel onglet. Le jeton est dans le localStorage (pas de
   * cookie) : un simple lien `<a href>` serait refusé en 401, on récupère donc le binaire avec
   * l'en-tête puis on ouvre une object-URL, comme la visionneuse de la fiche.
   * L'onglet est ouvert AVANT le `fetch` : après un `await`, le navigateur ne considère plus le
   * geste comme un clic et bloquerait la fenêtre.
   */
  async open(documentId: number, versionId: number, fileId: number): Promise<void> {
    const tab = window.open('', '_blank');
    try {
      const res = await fetch(contentPath(documentId, versionId, fileId), {
        headers: authHeader(),
      });
      if (!res.ok) throw await readError(res);
      const url = URL.createObjectURL(await res.blob());
      if (tab) tab.location.href = url;
      else window.open(url, '_blank');
      // Révocation différée : l'onglet doit avoir fini de lire le blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      throw e;
    }
  },
};
