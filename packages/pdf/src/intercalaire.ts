// Intercalaire A4 sheet composition (T042) via pdf-lib: one page per element with the
// category label, a unique QR code, and the element label.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export interface IntercalaireSheet {
  categoryLabel: string;
  itemLabel: string;
  qrPng: Uint8Array;
}

const A4: [number, number] = [595.28, 841.89];

/** Keep only characters the StandardFont (WinAnsi) can encode, to avoid throwing. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x20-\xFF]/g, '?');
}

function drawCentered(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  y: number,
  pageWidth: number,
): void {
  const safe = sanitize(text);
  const width = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, { x: (pageWidth - width) / 2, y, size, font, color: rgb(0, 0, 0) });
}

/** Build a printable PDF — one A4 page per sheet. */
export async function composeIntercalairesPdf(sheets: IntercalaireSheet[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const sheet of sheets) {
    const page = doc.addPage(A4);
    const { width, height } = page.getSize();

    drawCentered(page, sheet.categoryLabel.toUpperCase(), bold, 22, height - 140, width);

    const qr = await doc.embedPng(sheet.qrPng);
    const qrSize = 280;
    page.drawImage(qr, {
      x: (width - qrSize) / 2,
      y: (height - qrSize) / 2,
      width: qrSize,
      height: qrSize,
    });

    drawCentered(page, sheet.itemLabel, font, 16, (height - qrSize) / 2 - 48, width);
  }

  return doc.save();
}
