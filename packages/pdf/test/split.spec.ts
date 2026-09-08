import { PDFDocument } from 'pdf-lib';
import { buildDocumentPdf, getPageCount, loadPdf, type PageRef } from '../src/split';

async function makePdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`page ${i}`, { x: 20, y: 100, size: 12 });
  }
  return doc.save();
}

describe('pdf split / assembly (pdf-lib)', () => {
  it('counts pages', async () => {
    expect(await getPageCount(await makePdf(5))).toBe(5);
  });

  it('assembles a document from refs spanning two source files', async () => {
    const fileA = await makePdf(3);
    const fileB = await makePdf(2);
    const sources = [await loadPdf(fileA), await loadPdf(fileB)];

    const refs: PageRef[] = [
      { fileIndex: 0, pageIndex: 0 },
      { fileIndex: 0, pageIndex: 2 },
      { fileIndex: 1, pageIndex: 1 },
    ];
    const out = await buildDocumentPdf(sources, refs);
    expect(await getPageCount(out)).toBe(3);
  });

  it('skips out-of-range refs safely', async () => {
    const sources = [await loadPdf(await makePdf(1))];
    const out = await buildDocumentPdf(sources, [
      { fileIndex: 0, pageIndex: 0 },
      { fileIndex: 0, pageIndex: 9 }, // out of range -> skipped
      { fileIndex: 5, pageIndex: 0 }, // missing file -> skipped
    ]);
    expect(await getPageCount(out)).toBe(1);
  });
});
