import type { IntercalaireCategoryCode } from '@archivage/qr';

/** A page's position in the ordered scan stream (files sorted by name, pages in order). */
export interface PageRef {
  fileIndex: number;
  pageIndex: number;
}

export type OpeningCategory = Exclude<IntercalaireCategoryCode, 'BLANK'>;

/** Classification of a single scanned page (after QR decode). */
export type PageClassification =
  | { kind: 'opening'; category: OpeningCategory; targetId: number; page: PageRef }
  | { kind: 'blank'; page: PageRef }
  | { kind: 'content'; page: PageRef };

/** A document to create, with its classifying attributes and its content pages. */
export interface DocumentPlan {
  documentTypeId: number | null;
  planId: number | null;
  locationId: number | null;
  dossierId: number | null;
  /** Real (content) pages composing this document; intercalaire pages are excluded. */
  pages: PageRef[];
  /** true when the document is opened without a TYPE_DOCUMENT intercalaire in scope (FR-015). */
  untyped: boolean;
}

/**
 * Split an ordered page stream into documents per the QR-piloted rules.
 *
 * Intercalaires carry a *running context* — the attributes that describe the document(s) that
 * follow. They do NOT by themselves create a document:
 *  - DOSSIER / LOCALISATION / PLAN / TYPE_DOCUMENT each set their running attribute. Attributes
 *    are *sticky*: they stay in effect until a new intercalaire of the same category changes
 *    them (a DOSSIER also prevails over the batch default, FR-016). So a single run of
 *    intercalaires can describe one document, or several consecutive ones.
 *
 * A document is materialised by *content* pages:
 *  - a content page is appended to the current document; if none is open, it opens a new one
 *    stamped with a snapshot of the running context;
 *  - consecutive content pages accumulate into the same document (a multi-page scan).
 *
 * A new-document boundary occurs once content has already been collected, when:
 *  - a BLANK separator is seen (closes the current document; the running context is kept), or
 *  - a new opening intercalaire is seen (it describes the next document).
 *
 * The default dossier (chosen at batch open, EF-P2-1) seeds the running dossier.
 */
export function segmentPages(
  pages: PageClassification[],
  defaultDossierId: number | null,
): DocumentPlan[] {
  const documents: DocumentPlan[] = [];
  let current: DocumentPlan | null = null;

  // Sticky attributes carried by intercalaires; the batch default seeds the dossier.
  const ctx = {
    dossierId: defaultDossierId,
    locationId: null as number | null,
    planId: null as number | null,
    documentTypeId: null as number | null,
  };

  const openWithContext = (): DocumentPlan => {
    const doc: DocumentPlan = {
      documentTypeId: ctx.documentTypeId,
      planId: ctx.planId,
      locationId: ctx.locationId,
      dossierId: ctx.dossierId,
      pages: [],
      untyped: ctx.documentTypeId == null,
    };
    documents.push(doc);
    return doc;
  };

  for (const item of pages) {
    if (item.kind === 'opening') {
      // A new descriptor seen after content has started means the previous document is complete.
      if (current && current.pages.length > 0) current = null;
      switch (item.category) {
        case 'DOSSIER':
          ctx.dossierId = item.targetId;
          break;
        case 'LOCALISATION':
          ctx.locationId = item.targetId;
          break;
        case 'PLAN':
          ctx.planId = item.targetId;
          break;
        case 'TYPE_DOCUMENT':
          ctx.documentTypeId = item.targetId;
          break;
      }
    } else if (item.kind === 'blank') {
      current = null; // separator: the next content page starts a new document
    } else {
      if (!current) current = openWithContext();
      current.pages.push(item.page);
    }
  }

  return documents;
}
