import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { TesseractOcr, shouldOcr } from '@archivage/ocr';
import { extractPageText, loadPdfForRender, renderPage } from '@archivage/pdf';

/** Plafond du texte transmis à l'IA : au-delà, le surplus n'apporte rien à l'enregistrement. */
export const MAX_TEXT_CHARS = 20_000;

/** Nombre de pages lues au maximum (couche texte comme OCR) : l'en-tête et l'objet sont en tête. */
export const MAX_PAGES = 10;

export interface MailTextSource {
  buffer: Buffer;
  /** Type MIME déjà validé par l'appelant (pdf, jpeg, png, gif, webp). */
  mediaType: string;
}

/**
 * Lecture LOCALE d'un courrier numérisé : le binaire ne quitte jamais le serveur, seul le texte
 * en sort. PDF : couche texte d'abord, OCR (Tesseract) en repli sur les pages sans texte.
 * Image : OCR direct.
 */
@Injectable()
export class MailTextExtractor {
  private readonly logger = new Logger(MailTextExtractor.name);

  constructor(private readonly config: ConfigService) {}

  private get lang(): string {
    return this.config.get<string>('TESSERACT_LANG') ?? 'fra+eng';
  }

  private get dataPath(): string | undefined {
    return this.config.get<string>('TESSERACT_DATA_PATH') || undefined;
  }

  /**
   * Outillage local utilisable : si un dossier de données Tesseract est configuré, il doit exister
   * (sans lui, tesseract.js tenterait un téléchargement, impossible en production fermée).
   */
  isOperational(): boolean {
    const path = this.dataPath;
    return !path || existsSync(path);
  }

  /** Texte lisible du courrier, plafonné à `MAX_TEXT_CHARS`. Lève 400 si rien n'est lisible. */
  async extractText(source: MailTextSource): Promise<string> {
    if (!this.isOperational()) {
      throw new BadRequestException(
        'La lecture locale du document est indisponible (données OCR introuvables). Saisissez le courrier manuellement.',
      );
    }
    const ocr = new TesseractOcr(this.lang, this.dataPath);
    try {
      const raw =
        source.mediaType === 'application/pdf'
          ? await this.fromPdf(source.buffer, ocr)
          : await this.fromImage(source, ocr);
      const text = raw.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) {
        throw new BadRequestException(
          'Aucun texte lisible dans ce document : saisissez le courrier manuellement.',
        );
      }
      return text.slice(0, MAX_TEXT_CHARS);
    } finally {
      await ocr.dispose().catch(() => undefined);
    }
  }

  private async fromPdf(bytes: Buffer, ocr: TesseractOcr): Promise<string> {
    let doc;
    try {
      doc = await loadPdfForRender(new Uint8Array(bytes));
    } catch (e) {
      this.logger.warn(`PDF illisible (${e instanceof Error ? e.name : 'erreur'}).`);
      throw new BadRequestException('Format non lisible localement : ce PDF est corrompu ou protégé.');
    }
    const pages = Math.min(doc.numPages, MAX_PAGES);
    const parts: string[] = [];
    let total = 0;
    for (let n = 1; n <= pages && total < MAX_TEXT_CHARS; n++) {
      let text = await extractPageText(doc, n);
      if (shouldOcr(text)) {
        try {
          text = await ocr.recognize((await renderPage(doc, n)).png);
        } catch (e) {
          this.logger.warn(`OCR de la page ${n} en échec (${e instanceof Error ? e.name : 'erreur'}).`);
        }
      }
      parts.push(text);
      total += text.length;
    }
    return parts.join('\n\n');
  }

  private async fromImage(source: MailTextSource, ocr: TesseractOcr): Promise<string> {
    let png = source.buffer;
    // Tesseract lit JPEG/PNG ; GIF et WebP sont convertis en PNG via le canvas natif du dépôt.
    if (source.mediaType === 'image/gif' || source.mediaType === 'image/webp') {
      try {
        const img = await loadImage(source.buffer);
        const canvas = createCanvas(img.width, img.height);
        canvas.getContext('2d').drawImage(img, 0, 0);
        png = canvas.toBuffer('image/png');
      } catch {
        throw new BadRequestException("Format non lisible localement : convertissez l'image en JPG ou PNG.");
      }
    }
    try {
      return await ocr.recognize(png);
    } catch (e) {
      this.logger.warn(`OCR de l'image en échec (${e instanceof Error ? e.name : 'erreur'}).`);
      throw new BadRequestException('Format non lisible localement : image illisible.');
    }
  }
}
