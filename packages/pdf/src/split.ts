// PDF splitting / assembly (T029) via pdf-lib. Builds per-document PDFs from page refs
// that may span several source files (scan stream ordered by file name).
import { PDFDocument } from 'pdf-lib';

export interface PageRef {
  fileIndex: number;
  pageIndex: number;
}

export function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes);
}

export async function getPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

/** Assemble a new PDF from the given (fileIndex, pageIndex) refs across the source documents. */
export async function buildDocumentPdf(
  sources: PDFDocument[],
  refs: PageRef[],
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const ref of refs) {
    const src = sources[ref.fileIndex];
    if (!src || ref.pageIndex >= src.getPageCount()) continue;
    const [copied] = await out.copyPages(src, [ref.pageIndex]);
    if (copied) out.addPage(copied);
  }
  return out.save();
}
