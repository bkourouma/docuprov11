// @archivage/ocr — OCR adapter (T030). Default engine is tesseract.js (pure-Node, fra/eng);
// an optional Tesseract CLI path can be added later for throughput (D-09).
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';

export interface OcrEngine {
  recognize(png: Buffer): Promise<string>;
  dispose(): Promise<void>;
}

/** Reusable tesseract.js engine (lazily initialized; reuse across pages to avoid re-init cost). */
export class TesseractOcr implements OcrEngine {
  private workerPromise: Promise<TesseractWorker> | null = null;

  constructor(private readonly lang = 'fra+eng') {}

  private worker(): Promise<TesseractWorker> {
    this.workerPromise ??= createWorker(this.lang);
    return this.workerPromise;
  }

  async recognize(png: Buffer): Promise<string> {
    const worker = await this.worker();
    const { data } = await worker.recognize(png);
    return data.text.trim();
  }

  async dispose(): Promise<void> {
    if (this.workerPromise) {
      const worker = await this.workerPromise;
      await worker.terminate();
      this.workerPromise = null;
    }
  }
}

/** Decide a page's text: prefer the embedded text layer, fall back to OCR when too thin. */
export function shouldOcr(textLayer: string, minChars = 12): boolean {
  return textLayer.replace(/\s+/g, '').length < minChars;
}
