import { PDFDocument } from 'pdf-lib';
import { composeIntercalairesPdf, type IntercalaireSheet } from '../src/intercalaire';

// A 1x1 transparent PNG, enough to validate embedding + page count.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('intercalaire PDF composition', () => {
  it('produces one A4 page per sheet', async () => {
    const sheets: IntercalaireSheet[] = [
      { categoryLabel: 'Type de document', itemLabel: 'Facture', qrPng: PNG_1x1 },
      { categoryLabel: 'Type de document', itemLabel: 'Contrat', qrPng: PNG_1x1 },
      { categoryLabel: 'Séparateur vierge', itemLabel: '(séparateur vierge)', qrPng: PNG_1x1 },
    ];
    const bytes = await composeIntercalairesPdf(sheets);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);

    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(Math.round(w)).toBe(595);
    expect(Math.round(h)).toBe(842);
  });

  it('handles accented labels without throwing', async () => {
    const bytes = await composeIntercalairesPdf([
      { categoryLabel: 'Localisation', itemLabel: 'Étagère réservée n°4 — accentué', qrPng: PNG_1x1 },
    ]);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});
