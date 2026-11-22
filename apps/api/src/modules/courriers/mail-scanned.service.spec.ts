import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailScannedDocumentsService } from './mail-scanned.service';
import type { AuthUser } from '../auth/auth.types';

const user: AuthUser = { userId: 1, username: 'op', isAdmin: false, userGroupId: 9 };

describe('MailScannedDocumentsService', () => {
  let prisma: {
    mailScannedDocument: {
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
    };
    fileType: { findUnique: jest.Mock };
    documentFile: { findFirstOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    document: { create: jest.Mock };
    documentVersion: { create: jest.Mock };
    documentFile: { create: jest.Mock };
  };
  let config: { getOrThrow: jest.Mock };
  let archives: string;
  let service: MailScannedDocumentsService;

  beforeEach(async () => {
    archives = await mkdtemp(join(tmpdir(), 'archives-test-'));
    tx = {
      document: { create: jest.fn().mockResolvedValue({ documentId: 55 }) },
      documentVersion: { create: jest.fn().mockResolvedValue({ documentVersionId: 66 }) },
      documentFile: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      mailScannedDocument: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
      },
      fileType: { findUnique: jest.fn().mockResolvedValue({ fileTypeId: 1 }) },
      documentFile: { findFirstOrThrow: jest.fn().mockResolvedValue({ fileId: 77 }) },
      $transaction: jest.fn().mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    config = { getOrThrow: jest.fn().mockReturnValue(archives) };
    service = new MailScannedDocumentsService(prisma as never, config as never);
  });

  it('listPending ne renvoie que les scans non traités, les plus récents d’abord', async () => {
    prisma.mailScannedDocument.count.mockResolvedValue(3);
    prisma.mailScannedDocument.findMany.mockResolvedValue([{ mailScannedDocumentId: 7 }]);

    const res = await service.listPending({ page: 1, pageSize: 25 });

    expect(res).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(prisma.mailScannedDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isTraite: false },
        orderBy: { dateScanned: 'desc' },
        skip: 0,
        take: 25,
      }),
    );
  });

  it('getById lève NotFound si le scan n’existe pas', async () => {
    prisma.mailScannedDocument.findUnique.mockResolvedValue(null);
    await expect(service.getById(42)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('upload (§07)', () => {
    it('écrit le binaire sous ARCHIVES et crée la ligne non traitée', async () => {
      const file = { originalname: 'courrier.pdf', buffer: Buffer.from('%PDF-1.4'), size: 8 };

      const row = await service.upload(file, 'POSTE-01', user);

      expect(row).toMatchObject({
        fileName: 'courrier.pdf',
        machineName: 'POSTE-01',
        isTraite: false,
        createdBy: 9,
      });
      // Le binaire est réellement sur le disque, sous un nom opaque (pas le nom fourni).
      expect(row.filePath).toContain('_courriers-scans');
      expect(row.filePath).not.toContain('courrier.pdf');
      await expect(readFile(row.filePath as string, 'utf8')).resolves.toBe('%PDF-1.4');
    });

    it('refuse une extension non gérée', async () => {
      const file = { originalname: 'virus.exe', buffer: Buffer.from('MZ'), size: 2 };
      await expect(service.upload(file, null, user)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.mailScannedDocument.create).not.toHaveBeenCalled();
    });

    it('refuse un dépôt vide', async () => {
      await expect(service.upload(undefined, null, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('promoteToDocument (§05/§07)', () => {
    it('crée Document + version 1 + fichier et copie le binaire dans le coffre', async () => {
      const src = join(archives, 'scan-src.pdf');
      await writeFile(src, '%PDF-scan');
      prisma.mailScannedDocument.findUnique.mockResolvedValue({
        mailScannedDocumentId: 3,
        fileName: 'lettre.pdf',
        filePath: src,
        isTraite: false,
      });

      const documentId = await service.promoteToDocument(3, 'Lettre du préfet', user);

      expect(documentId).toBe(55);
      expect(tx.document.create).toHaveBeenCalledWith({
        data: { label: 'Lettre du préfet', createdBy: 9 },
      });
      expect(tx.documentVersion.create).toHaveBeenCalledWith({
        data: { documentId: 55, versionNumber: 1, isCurrent: true, createdBy: 9 },
      });
      expect(tx.documentFile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          documentVersionId: 66,
          fileTypeId: 1,
          originalName: 'lettre.pdf',
          fileExtension: '.pdf',
          byteLength: BigInt(9),
        }),
      });
      // Le coffre nomme le binaire d'après son fileId (convention DiskFileStore).
      await expect(readFile(join(archives, '77.pdf'), 'utf8')).resolves.toBe('%PDF-scan');
    });

    it('émet document.deposited (origine scan) après l’écriture, sans texte libre ; un bus qui lève ne casse rien', async () => {
      const src = join(archives, 'scan-evt.pdf');
      await writeFile(src, '%PDF-scan');
      prisma.mailScannedDocument.findUnique.mockResolvedValue({
        mailScannedDocumentId: 6,
        fileName: 'lettre.pdf',
        filePath: src,
        isTraite: false,
      });
      const events: Record<string, unknown>[] = [];
      const withBus = new MailScannedDocumentsService(prisma as never, config as never, {
        emit: (e: unknown) => events.push(e as Record<string, unknown>),
      } as never);
      await expect(withBus.promoteToDocument(6, 'Libellé confidentiel', user)).resolves.toBe(55);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'document.deposited', subjectId: '55' });
      expect((events[0].fields as Record<string, unknown>).source).toBe('scan');
      expect(JSON.stringify(events[0])).not.toContain('confidentiel');

      const broken = new MailScannedDocumentsService(prisma as never, config as never, {
        emit: () => {
          throw new Error('bus en panne');
        },
      } as never);
      await expect(broken.promoteToDocument(6, 'X', user)).resolves.toBe(55);
    });

    it('normalise .jpeg en .jpg pour retrouver le file_type', async () => {
      const src = join(archives, 'scan.jpeg');
      await writeFile(src, 'JPEG');
      prisma.mailScannedDocument.findUnique.mockResolvedValue({
        mailScannedDocumentId: 4,
        fileName: 'photo.jpeg',
        filePath: src,
        isTraite: false,
      });

      await service.promoteToDocument(4, 'Photo', user);

      expect(prisma.fileType.findUnique).toHaveBeenCalledWith({ where: { extension: '.jpg' } });
    });

    it('refuse si le scan n’a aucun fichier', async () => {
      prisma.mailScannedDocument.findUnique.mockResolvedValue({
        mailScannedDocumentId: 5,
        fileName: null,
        filePath: null,
      });
      await expect(service.promoteToDocument(5, 'X', user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
