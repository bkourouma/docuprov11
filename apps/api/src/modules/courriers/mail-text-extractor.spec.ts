import { BadRequestException } from '@nestjs/common';
import { MAX_PAGES, MAX_TEXT_CHARS, MailTextExtractor } from './mail-text-extractor';

const recognize = jest.fn();
const dispose = jest.fn().mockResolvedValue(undefined);
jest.mock('@archivage/ocr', () => ({
  TesseractOcr: jest.fn().mockImplementation(() => ({ recognize, dispose })),
  shouldOcr: (t: string) => t.replace(/\s+/g, '').length < 12,
}));

const extractPageText = jest.fn();
const renderPage = jest.fn();
const loadPdfForRender = jest.fn();
jest.mock('@archivage/pdf', () => ({
  extractPageText: (...a: unknown[]) => extractPageText(...a),
  renderPage: (...a: unknown[]) => renderPage(...a),
  loadPdfForRender: (...a: unknown[]) => loadPdfForRender(...a),
}));

jest.mock('@napi-rs/canvas', () => ({
  createCanvas: () => ({
    getContext: () => ({ drawImage: jest.fn() }),
    toBuffer: () => Buffer.from('png-converti'),
  }),
  loadImage: jest.fn().mockResolvedValue({ width: 2, height: 2 }),
}));

const config = (env: Record<string, string | undefined> = {}) => ({ get: (k: string) => env[k] });
const make = (env?: Record<string, string | undefined>) => new MailTextExtractor(config(env) as never);
const pdf = { buffer: Buffer.from('x'), mediaType: 'application/pdf' };

describe('MailTextExtractor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadPdfForRender.mockResolvedValue({ numPages: 1 });
    renderPage.mockResolvedValue({ png: Buffer.from('png') });
  });

  it("PDF avec couche texte : pas d'OCR", async () => {
    extractPageText.mockResolvedValue('Objet : demande de subvention exercice 2026');
    const text = await make().extractText(pdf);
    expect(text).toContain('demande de subvention');
    expect(recognize).not.toHaveBeenCalled();
    expect(renderPage).not.toHaveBeenCalled();
  });

  it('PDF sans texte : rasterise puis OCR', async () => {
    extractPageText.mockResolvedValue('');
    recognize.mockResolvedValue('Texte lu par OCR sur le scan');
    const text = await make().extractText(pdf);
    expect(text).toBe('Texte lu par OCR sur le scan');
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(recognize).toHaveBeenCalledTimes(1);
  });

  it('limite le nombre de pages lues', async () => {
    loadPdfForRender.mockResolvedValue({ numPages: 50 });
    extractPageText.mockResolvedValue('page avec un texte suffisant');
    await make().extractText(pdf);
    expect(extractPageText).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it('image PNG : OCR direct sur le binaire', async () => {
    recognize.mockResolvedValue('Courrier image');
    const buffer = Buffer.from('img');
    const text = await make().extractText({ buffer, mediaType: 'image/png' });
    expect(text).toBe('Courrier image');
    expect(recognize).toHaveBeenCalledWith(buffer);
  });

  it('image WebP : convertie en PNG avant OCR', async () => {
    recognize.mockResolvedValue('Courrier webp');
    await make().extractText({ buffer: Buffer.from('w'), mediaType: 'image/webp' });
    expect(recognize).toHaveBeenCalledWith(Buffer.from('png-converti'));
  });

  it('plafonne la longueur du texte', async () => {
    extractPageText.mockResolvedValue('a'.repeat(MAX_TEXT_CHARS + 5000));
    const text = await make().extractText(pdf);
    expect(text).toHaveLength(MAX_TEXT_CHARS);
  });

  it('texte vide => 400 aucun texte lisible', async () => {
    extractPageText.mockResolvedValue('');
    recognize.mockResolvedValue('   ');
    const p = make().extractText(pdf);
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(p).rejects.toThrow(/Aucun texte lisible/);
  });

  it('PDF illisible => 400', async () => {
    loadPdfForRender.mockRejectedValue(new Error('corrompu'));
    await expect(make().extractText(pdf)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('isOperational : faux si le dossier de données OCR est absent', () => {
    expect(make().isOperational()).toBe(true);
    expect(make({ TESSERACT_DATA_PATH: '/chemin/inexistant/ocr' }).isOperational()).toBe(false);
    expect(make({ TESSERACT_DATA_PATH: __dirname }).isOperational()).toBe(true);
  });
});
