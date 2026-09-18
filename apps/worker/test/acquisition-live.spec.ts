import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { formatPayload, generateQrPng } from '@archivage/qr';
import { prisma } from '../src/db';
import { incomingDir, processBatch } from '../src/processors/acquisition.processor';

const A4: [number, number] = [595.28, 841.89];

/** Build a single scanned-bundle PDF: [QR TYPE] page, content, [QR BLANK], content. */
async function buildFixture(typeId: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const qrPage = async (payload: string) => {
    const png = await generateQrPng(payload, { scale: 6, margin: 4 });
    const img = await doc.embedPng(png);
    const page = doc.addPage(A4);
    page.drawImage(img, { x: 160, y: 380, width: 280, height: 280 });
  };
  const textPage = (text: string) => {
    doc.addPage(A4).drawText(text, { x: 60, y: 740, size: 16, font });
  };

  await qrPage(formatPayload('TYPE_DOCUMENT', typeId));
  textPage('Contenu du document numero un. Mot cle tournesol present dans le texte.');
  await qrPage(formatPayload('BLANK', 0));
  textPage('Page apres le separateur vierge, sans type.');

  return doc.save();
}

describe('Acquisition pipeline — live fixture run', () => {
  const tag = Math.floor(Math.random() * 1e9);
  const archivesPath = join(tmpdir(), `archivage-live-${tag}`);
  /** Un lot par mode : les deux branches de `processBatch` sont couvertes séparément. */
  const batchIds: number[] = [];

  /** Crée un lot dans le mode voulu et y dépose le PDF fixture. */
  async function stageBatch(useIntercalaires: boolean, typeId: number): Promise<number> {
    const batch = await prisma.acquisitionBatch.create({ data: { status: 0, useIntercalaires } });
    batchIds.push(batch.batchId);
    const dir = incomingDir(archivesPath, batch.batchId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '0001_fixture.pdf'), Buffer.from(await buildFixture(typeId)));
    return batch.batchId;
  }

  async function activeDocumentTypeId(): Promise<number> {
    const docType = await prisma.documentType.findFirst({ where: { isActive: true } });
    if (!docType) throw new Error('Aucun type de document actif : lancez le seed (db:seed).');
    return docType.documentTypeId;
  }

  afterAll(async () => {
    if (batchIds.length) {
      await prisma.document.deleteMany({ where: { batchId: { in: batchIds } } });
      await prisma.acquisitionBatch.deleteMany({ where: { batchId: { in: batchIds } } });
    }
    await rm(archivesPath, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  // Le découpage QR + OCR n'est PAS le comportement par défaut : c'est l'ancien système, activé
  // lot par lot via `use_intercalaires`. Le lot doit donc le demander explicitement — sans quoi
  // `processBatch` prend l'autre branche et fusionne, ce qui faisait échouer ce test.
  it('splits a QR-piloted PDF into the expected documents with text (SC-001)', async () => {
    const typeId = await activeDocumentTypeId();
    const batchId = await stageBatch(true, typeId);

    await processBatch(batchId, { archivesPath, tesseractLang: 'eng' });

    const docs = await prisma.document.findMany({
      where: { batchId },
      orderBy: { documentId: 'asc' },
      include: { versions: { include: { files: true } } },
    });

    // [TYPE] sets the running type; content -> doc1; [BLANK] separates; content -> doc2.
    // Attributes are sticky, so doc2 keeps the same type. => 2 documents.
    expect(docs).toHaveLength(2);
    expect(docs[0]!.documentTypeId).toBe(typeId);
    expect(docs[0]!.versions[0]!.files).toHaveLength(1);
    expect(docs[0]!.versions[0]!.files[0]!.ocrText ?? '').toContain('tournesol');
    expect(docs[1]!.documentTypeId).toBe(typeId);

    const updated = await prisma.acquisitionBatch.findUnique({ where: { batchId } });
    expect(updated!.status).toBe(1);
    expect(updated!.documentCount).toBe(2);
  }, 180000);

  // Mode PAR DÉFAUT, celui qu'empruntent les lots réels. Il n'avait aucune couverture vivante :
  // c'est précisément pour cela que le test ci-dessus a pu basculer dessus sans qu'on le voie —
  // il produisait un résultat valide, mais pour l'autre mode.
  it('merges the whole batch into a single un-OCRed document when intercalaires are off', async () => {
    const typeId = await activeDocumentTypeId();
    const batchId = await stageBatch(false, typeId);

    await processBatch(batchId, { archivesPath, tesseractLang: 'eng' });

    const docs = await prisma.document.findMany({
      where: { batchId },
      include: { versions: { include: { files: true } } },
    });

    expect(docs).toHaveLength(1);
    // Ni découpage ni lecture des QR : le type reste à indexer à la main.
    expect(docs[0]!.documentTypeId).toBeNull();
    // Libellé repris du nom de fichier, préfixe de tri retiré.
    expect(docs[0]!.label).toBe('fixture');

    const files = docs[0]!.versions[0]!.files;
    expect(files).toHaveLength(1);
    // Les 4 pages du fixture sont conservées telles quelles, intercalaires compris.
    expect(files[0]!.pageCount).toBe(4);
    // Pas d'OCR dans ce mode — c'est ce qui le rend rapide.
    expect(files[0]!.ocrText).toBeNull();

    const updated = await prisma.acquisitionBatch.findUnique({ where: { batchId } });
    expect(updated!.status).toBe(1);
    expect(updated!.documentCount).toBe(1);
    expect(updated!.processedFiles).toBe(1);
  }, 180000);

  // Retraiter commence par supprimer les documents du lot et leurs binaires, sans transaction.
  // Tant que la lecture du dépôt venait APRÈS, un dossier `_incoming` manquant détruisait le lot
  // puis échouait : perte sèche. L'échec doit désormais survenir avant toute suppression.
  it('refuses to reprocess a batch whose staging dir is gone, without destroying it', async () => {
    const typeId = await activeDocumentTypeId();
    const batchId = await stageBatch(false, typeId);

    await processBatch(batchId, { archivesPath, tesseractLang: 'eng' });

    const avant = await prisma.document.findMany({
      where: { batchId },
      include: { versions: { include: { files: true } } },
    });
    expect(avant).toHaveLength(1);
    const fichierAvant = avant[0]!.versions[0]!.files[0]!;

    // Le cas reel : lot restaure sans ses depots, ou `_incoming` purge.
    await rm(incomingDir(archivesPath, batchId), { recursive: true, force: true });

    await expect(processBatch(batchId, { archivesPath, tesseractLang: 'eng' })).rejects.toThrow(
      /dépôt introuvable/,
    );

    // Le coeur du test : le lot est intact, en base comme sur disque.
    const apres = await prisma.document.findMany({
      where: { batchId },
      include: { versions: { include: { files: true } } },
    });
    expect(apres).toHaveLength(1);
    expect(apres[0]!.documentId).toBe(avant[0]!.documentId);
    const fichierApres = apres[0]!.versions[0]!.files[0]!;
    expect(fichierApres.fileId).toBe(fichierAvant.fileId);
    await expect(
      stat(join(archivesPath, `${fichierApres.fileId}${fichierApres.fileExtension}`)),
    ).resolves.toBeDefined();
  }, 180000);
});
