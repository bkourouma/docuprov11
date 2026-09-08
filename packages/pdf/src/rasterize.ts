// PDF page rasterization (T028) and text-layer extraction, via pdfjs-dist + @napi-rs/canvas.
// pdfjs-dist v4 is ESM-only; load it with a real dynamic import (survives CJS downleveling).
import { createCanvas } from '@napi-rs/canvas';

const esmImport = new Function('specifier', 'return import(specifier)') as <T = unknown>(
  specifier: string,
) => Promise<T>;

interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: unknown): { promise: Promise<void> };
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
}
export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}
interface PdfjsLib {
  getDocument(src: unknown): { promise: Promise<PdfDocument> };
}

let pdfjsPromise: Promise<PdfjsLib> | null = null;
function loadPdfjs(): Promise<PdfjsLib> {
  pdfjsPromise ??= esmImport<PdfjsLib>('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

export async function loadPdfForRender(bytes: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
}

export interface RenderedPage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  png: Buffer;
}

/** Render a page (1-based) to an RGBA buffer + PNG, for QR decoding and OCR. */
export async function renderPage(
  doc: PdfDocument,
  pageNumber: number,
  scale = 2,
): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: image.data as unknown as Uint8ClampedArray,
    width: canvas.width,
    height: canvas.height,
    png: canvas.toBuffer('image/png'),
  };
}

/** Extract the embedded text layer of a page (empty string for scanned/image pages). */
export async function extractPageText(doc: PdfDocument, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map((i) => i.str ?? '')
    .join(' ')
    .trim();
}
