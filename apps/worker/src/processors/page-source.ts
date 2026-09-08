import type { PDFDocument } from 'pdf-lib';
import { loadPdf, loadPdfForRender, renderPage, extractPageText } from '@archivage/pdf';
import {
  decodeQrFromImage,
  parsePayload,
  isOpeningCategory,
  type IntercalairePayload,
} from '@archivage/qr';
import { TesseractOcr, shouldOcr } from '@archivage/ocr';
import type { OpeningCategory, PageClassification } from './segment';

export interface IncomingFile {
  bytes: Uint8Array;
}

export interface PageStream {
  classifications: PageClassification[];
  /** content-page text keyed by `${fileIndex}:${pageIndex}` (text layer or OCR). */
  pageText: Map<string, string>;
  /** pdf-lib documents indexed by fileIndex, for assembling per-document PDFs. */
  sources: PDFDocument[];
}

export function pageKey(fileIndex: number, pageIndex: number): string {
  return `${fileIndex}:${pageIndex}`;
}

function firstIntercalaire(texts: string[]): IntercalairePayload | null {
  for (const text of texts) {
    const parsed = parsePayload(text);
    if (parsed.status === 'ok') return parsed.payload;
  }
  return null;
}

/**
 * Walk every page of every file (ordered), decode its QR, and classify it
 * (opening / blank / content). For content pages, capture text (layer or OCR).
 */
export async function buildPageStream(
  files: IncomingFile[],
  tesseractLang: string,
  onFileProcessed?: (filesDone: number) => void | Promise<void>,
): Promise<PageStream> {
  const sources: PDFDocument[] = [];
  const classifications: PageClassification[] = [];
  const pageText = new Map<string, string>();
  const ocr = new TesseractOcr(tesseractLang);

  try {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const bytes = files[fileIndex]!.bytes;
      sources.push(await loadPdf(bytes));
      const renderDoc = await loadPdfForRender(bytes);

      for (let pageIndex = 0; pageIndex < renderDoc.numPages; pageIndex++) {
        const rendered = await renderPage(renderDoc, pageIndex + 1);
        const decoded = await decodeQrFromImage({
          data: rendered.data,
          width: rendered.width,
          height: rendered.height,
        });
        const intercalaire = firstIntercalaire(decoded);
        const page = { fileIndex, pageIndex };

        if (intercalaire && intercalaire.category === 'BLANK') {
          classifications.push({ kind: 'blank', page });
        } else if (intercalaire && isOpeningCategory(intercalaire.category)) {
          classifications.push({
            kind: 'opening',
            category: intercalaire.category as OpeningCategory,
            targetId: intercalaire.id,
            page,
          });
        } else {
          let text = await extractPageText(renderDoc, pageIndex + 1);
          if (shouldOcr(text)) {
            try {
              text = await ocr.recognize(rendered.png);
            } catch {
              /* keep whatever text-layer we have */
            }
          }
          pageText.set(pageKey(fileIndex, pageIndex), text);
          classifications.push({ kind: 'content', page });
        }
      }
      if (onFileProcessed) await onFileProcessed(fileIndex + 1);
    }
  } finally {
    await ocr.dispose();
  }

  return { classifications, pageText, sources };
}
