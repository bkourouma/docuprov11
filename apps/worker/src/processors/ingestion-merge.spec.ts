// mergePdfBytes (mode « sans intercalaire ») : fusion de tous les PDF d'un lot en un seul.
// ANO-ARC-T1-02 : un lot dont aucun fichier n'est lisible ne doit plus produire de document vide.
import { PDFDocument, StandardFonts } from 'pdf-lib';

// `../db` instancie un vrai PrismaClient à l'import ; la fusion n'en a pas besoin.
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('./seal-document', () => ({ sealFreshDocument: jest.fn() }));
jest.mock('./grant-permission', () => ({ grantConsultation: jest.fn() }));

import { mergePdfBytes } from './ingestion';

async function pdfOfPages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    doc.addPage([595.28, 841.89]).drawText(`Page ${i + 1} du fichier de test`, {
      x: 60,
      y: 740,
      size: 14,
      font,
    });
  }
  return doc.save();
}

const unreadable = (): Uint8Array => new TextEncoder().encode('Ceci n’est pas un PDF.');

describe('mergePdfBytes', () => {
  it('fusionne toutes les pages, dans l’ordre des fichiers, et compte la progression', async () => {
    const progress: number[] = [];
    const { bytes, pageCount } = await mergePdfBytes(
      [{ bytes: await pdfOfPages(2) }, { bytes: await pdfOfPages(3) }],
      (done) => {
        progress.push(done);
      },
    );
    expect(pageCount).toBe(5);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(5);
    expect(progress).toEqual([1, 2]);
  });

  it('ignore un fichier illisible quand d’autres pages sont lisibles (meilleur effort conservé)', async () => {
    const { pageCount } = await mergePdfBytes([
      { bytes: unreadable() },
      { bytes: await pdfOfPages(1) },
    ]);
    expect(pageCount).toBe(1);
  });

  it('échoue quand aucune page n’est lisible : pas de document à zéro page', async () => {
    const progress: number[] = [];
    await expect(
      mergePdfBytes([{ bytes: unreadable() }, { bytes: unreadable() }], (done) => {
        progress.push(done);
      }),
    ).rejects.toThrow(/Aucune page lisible dans les 2 fichier\(s\)/);
    // La progression a bien été remontée avant l'échec : la barre de l'écran ne reste pas figée.
    expect(progress).toEqual([1, 2]);
  });
});
