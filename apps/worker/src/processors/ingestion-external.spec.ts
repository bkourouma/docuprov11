// ingestExternalFile / addVersionFromSource : Prisma et coffre simulés (aucun disque, aucune base).
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// `../db` instancie un vrai PrismaClient à l'import ; le seam d'injection rend ce client inutile ici.
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('./seal-document', () => ({ sealFreshDocument: jest.fn() }));
jest.mock('./grant-permission', () => ({ grantConsultation: jest.fn() }));

import { grantConsultation } from './grant-permission';
import {
  PDF_TEXT_MAX_PAGES,
  addVersionFromSource,
  countPdfPages,
  extractTextFromBytes,
  ingestExternalFile,
  realExtension,
  type ExternalIngestDeps,
} from './ingestion';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function fakeDeps(overrides: Partial<ExternalIngestDeps> = {}) {
  const order: string[] = [];
  const prisma = {
    fileType: { upsert: jest.fn().mockResolvedValue({ fileTypeId: 9 }) },
    document: {
      create: jest.fn(async () => {
        order.push('document.create');
        return {
          documentId: 100,
          versions: [{ documentVersionId: 200, files: [{ fileId: 300 }] }],
        };
      }),
      delete: jest.fn().mockResolvedValue({}),
    },
    documentVersion: {
      findFirst: jest.fn().mockResolvedValue({ documentVersionId: 200, versionNumber: 1 }),
      updateMany: jest.fn(() => {
        order.push('version.updateMany');
        return Promise.resolve({ count: 1 });
      }),
      create: jest.fn(async () => {
        order.push('version.create');
        return { documentVersionId: 201, versionNumber: 2, files: [{ fileId: 301 }] };
      }),
      delete: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const fileStore = {
    write: jest.fn(async () => {
      order.push('write');
      return '/coffre/x';
    }),
  };
  const seal = jest.fn(async () => {
    order.push('seal');
  });
  const deps: ExternalIngestDeps = {
    prisma: prisma as never,
    fileStore: fileStore as never,
    archivesPath: '/coffre',
    seal,
    now: () => new Date('2026-11-20T10:00:00Z'),
    ...overrides,
  };
  return { prisma, fileStore, seal, deps, order };
}

const GRANTS = [
  { userGroupId: 11, permissionLevelId: 2 },
  { userGroupId: 12, permissionLevelId: 2 },
];

describe('ingestExternalFile', () => {
  it('crée document + version courante + fichier avec empreinte, droits et createdBy nul', async () => {
    const { prisma, fileStore, seal, deps, order } = fakeDeps();
    const bytes = Buffer.from('Bonjour le monde');
    const res = await ingestExternalFile(
      { bytes, name: 'dossier/Note Client.TXT', dossierId: 5 },
      GRANTS,
      deps,
    );
    expect(res).toEqual({ documentId: 100, documentVersionId: 200, fileId: 300 });

    const data = (
      prisma.document.create.mock.calls as unknown as [{ data: Record<string, any> }][]
    )[0]![0].data;
    expect(data).toMatchObject({
      label: 'Note Client',
      dossierId: 5,
      isArchived: false,
      createdBy: null,
    });
    // Ni type ni confidentialité par défaut : le type porterait ses propres droits.
    expect(data).not.toHaveProperty('documentTypeId');
    expect(data).not.toHaveProperty('confidentialiteId');
    const version = data.versions.create;
    expect(version).toMatchObject({ versionNumber: 1, isCurrent: true, createdBy: null });
    expect(version.files.create).toMatchObject({
      fileTypeId: 9,
      originalName: 'Note Client.TXT',
      fileExtension: '.txt',
      byteLength: BigInt(bytes.length),
      pageCount: null,
      ocrText: 'Bonjour le monde',
      hash: sha(bytes),
      hashComputedAt: new Date('2026-11-20T10:00:00Z'),
    });
    // Droits posés dans la MÊME écriture que le document : jamais de document sans droit.
    expect(data.permissions.create).toEqual([
      { userGroupId: 11, permissionLevelId: 2, grantedBy: 11 },
      { userGroupId: 12, permissionLevelId: 2, grantedBy: 12 },
    ]);
    expect(fileStore.write).toHaveBeenCalledWith(300, '.txt', bytes);
    expect(seal).toHaveBeenCalledWith(100, '/coffre');
    expect(order).toEqual(['document.create', 'write', 'seal']);
    // Le créateur n'est pas ajouté comme lecteur.
    expect(grantConsultation).not.toHaveBeenCalled();
  });

  it('refuse un document sans droit ou au-delà de la Consultation (rien n’est écrit)', async () => {
    const { prisma, fileStore, deps } = fakeDeps();
    const input = { bytes: Buffer.from('x'), name: 'a.txt', dossierId: null };
    await expect(ingestExternalFile(input, [], deps)).rejects.toThrow(/Aucun droit/);
    await expect(
      ingestExternalFile(input, [{ userGroupId: 1, permissionLevelId: 1 }], deps),
    ).rejects.toThrow(/Consultation/);
    await expect(
      ingestExternalFile(input, [{ userGroupId: 1, permissionLevelId: 3 }], deps),
    ).rejects.toThrow(/Consultation/);
    expect(prisma.document.create).not.toHaveBeenCalled();
    expect(fileStore.write).not.toHaveBeenCalled();
  });

  it('échec d’écriture sur le coffre : le document créé est retiré, l’erreur remonte', async () => {
    const { prisma, fileStore, seal, deps } = fakeDeps();
    fileStore.write.mockRejectedValueOnce(new Error('disque plein'));
    await expect(
      ingestExternalFile({ bytes: Buffer.from('x'), name: 'a.txt', dossierId: null }, GRANTS, deps),
    ).rejects.toThrow('disque plein');
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { documentId: 100 } });
    expect(seal).not.toHaveBeenCalled();
  });

  it('PDF : nombre de pages et texte de la couche texte', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Bonjour DocuPro', { x: 50, y: 700, size: 18, font });
    pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    const { prisma, deps } = fakeDeps();
    await ingestExternalFile({ bytes, name: 'contrat.pdf', dossierId: null }, GRANTS, deps);
    const file = (
      prisma.document.create.mock.calls as unknown as [{ data: Record<string, any> }][]
    )[0]![0].data.versions.create.files.create;
    expect(file.fileExtension).toBe('.pdf');
    expect(file.pageCount).toBe(2);
    expect(file.ocrText).toContain('Bonjour DocuPro');
  });

  it('le texte fourni par l’appelant prime ; le caractère NUL est retiré', async () => {
    const { prisma, deps } = fakeDeps();
    await ingestExternalFile(
      { bytes: Buffer.from('x'), name: 'a.txt', dossierId: null, ocrText: 'a\u0000b' },
      GRANTS,
      deps,
    );
    const file = (
      prisma.document.create.mock.calls as unknown as [{ data: Record<string, any> }][]
    )[0]![0].data.versions.create.files.create;
    expect(file.ocrText).toBe('ab');
  });
});

describe('addVersionFromSource', () => {
  it('décoche l’ancienne version avant de créer la nouvelle (numéro +1), puis écrit et scelle', async () => {
    const { prisma, fileStore, seal, deps, order } = fakeDeps();
    const bytes = Buffer.from('v2');
    const res = await addVersionFromSource(100, { bytes, name: 'a.txt', dossierId: null }, deps);
    expect(res).toMatchObject({
      documentId: 100,
      documentVersionId: 201,
      versionNumber: 2,
      fileId: 301,
    });
    expect(prisma.documentVersion.updateMany).toHaveBeenCalledWith({
      where: { documentId: 100, isCurrent: true },
      data: { isCurrent: false },
    });
    const created = (
      prisma.documentVersion.create.mock.calls as unknown as [{ data: Record<string, any> }][]
    )[0]![0].data;
    expect(created).toMatchObject({
      documentId: 100,
      versionNumber: 2,
      isCurrent: true,
      createdBy: null,
    });
    expect(created.files.create).toMatchObject({ hash: sha(bytes), fileExtension: '.txt' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['version.updateMany', 'version.create', 'write', 'seal']);
    expect(fileStore.write).toHaveBeenCalledWith(301, '.txt', bytes);
    expect(seal).toHaveBeenCalledWith(100, '/coffre');
    // Les droits du document ne sont pas touchés.
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it('échec d’écriture : retour à la version précédente', async () => {
    const { prisma, fileStore, deps } = fakeDeps();
    fileStore.write.mockRejectedValueOnce(new Error('disque plein'));
    await expect(
      addVersionFromSource(100, { bytes: Buffer.from('v2'), name: 'a.txt', dossierId: null }, deps),
    ).rejects.toThrow('disque plein');
    expect(prisma.documentVersion.delete).toHaveBeenCalledWith({
      where: { documentVersionId: 201 },
    });
    expect(prisma.documentVersion.update).toHaveBeenCalledWith({
      where: { documentVersionId: 200 },
      data: { isCurrent: true },
    });
  });

  it('document sans version : refus', async () => {
    const { prisma, deps } = fakeDeps();
    prisma.documentVersion.findFirst.mockResolvedValue(null as never);
    await expect(
      addVersionFromSource(100, { bytes: Buffer.from('x'), name: 'a.txt', dossierId: null }, deps),
    ).rejects.toThrow(/sans version/);
  });
});

describe('extractTextFromBytes / realExtension', () => {
  it('texte brut (BOM retiré), HTML (balises, scripts, entités), types non extractibles', async () => {
    expect(await extractTextFromBytes(Buffer.from('﻿ligne 1\nligne 2'), '.md')).toBe(
      'ligne 1\nligne 2',
    );
    const html =
      '<html><style>p{}</style><body><script>alert(1)</script><p>Tom &amp; Jerry</p></body></html>';
    expect(await extractTextFromBytes(Buffer.from(html), '.html')).toBe('Tom & Jerry');
    expect(await extractTextFromBytes(Buffer.from('   '), '.txt')).toBeNull();
    expect(await extractTextFromBytes(Buffer.from('xx'), '.docx')).toBeNull();
    expect(await extractTextFromBytes(Buffer.from('pas un pdf'), '.pdf')).toBeNull();
  });

  it('extension réelle en minuscules, .bin à défaut', () => {
    expect(realExtension('a/b/Rapport.PDF')).toBe('.pdf');
    expect(realExtension('sans-extension')).toBe('.bin');
    expect(realExtension('x.' + 'a'.repeat(30))).toBe('.bin');
  });
});

describe('extraction HTML : balayage linéaire', () => {
  const html = (s: string) => extractTextFromBytes(Buffer.from(s), '.html');
  /** Mesure en ms ; la borne est large (les anciennes expressions rationnelles prenaient ~26 s). */
  async function timed(input: string) {
    const t0 = performance.now();
    const out = await html(input);
    return { out, ms: performance.now() - t0 };
  }

  it.each([
    ['80 000 × <script>', '<script>'.repeat(80_000)],
    ['80 000 × <', '<'.repeat(80_000)],
    ['80 000 × <a  sans >', '<a '.repeat(80_000)],
    ['balise jamais fermée', '<p>début<div class="' + 'x'.repeat(200_000)],
    ['80 000 × <style> avec </x>', '<style></x>'.repeat(80_000)],
  ])('entrée pathologique (%s) : traitée en moins de 500 ms', async (_nom, input) => {
    const { ms } = await timed(input);
    expect(ms).toBeLessThan(500);
  });

  it('entrée au-delà de 2 Mo : seule la tête est lue', async () => {
    const head = '<p>tête</p>';
    const out = await html(head + 'a '.repeat(2_000_000) + '<b>queue-introuvable</b>');
    expect(out).toContain('tête');
    expect(out).not.toContain('queue-introuvable');
  });

  it('non-régression : balises, script/style (casse libre), entités', async () => {
    expect(
      await html(
        '<DIV>un</DIV><Script type="x">var a = "<b>";</SCRIPT>deux<STYLE>p{}</STYLE>trois',
      ),
    ).toBe('un deux trois');
    expect(await html('<p>Tom &amp; Jerry &lt;3 &quot;ok&quot; &#39;x&#39;&nbsp;fin</p>')).toBe(
      'Tom & Jerry <3 "ok" \'x\' fin',
    );
    // Doctype et balise multiligne.
    expect(await html('<!DOCTYPE html><a\nhref="x"\n>lien</a>')).toBe('lien');
    // `<scripts>` n'est pas un script ; un `<` isolé reste du texte.
    expect(await html('a < b <scripts>c</scripts>')).toBe('a < b c');
    // Script jamais refermé : le reste est du script.
    expect(await html('avant<script>alert(1)')).toBe('avant');
  });
});

describe('extraction PDF : plafonds, délai, destruction', () => {
  const bytes = Buffer.from('%PDF-simulé');
  function fakePdf(numPages: number, extractPage?: (n: number) => Promise<string>) {
    const destroy = jest.fn().mockResolvedValue(undefined);
    const doc = { numPages, destroy };
    return {
      destroy,
      deps: {
        load: jest.fn().mockResolvedValue(doc),
        extractPage: jest.fn(async (_d: unknown, n: number) =>
          extractPage ? extractPage(n) : `page ${n}`,
        ),
        warn: jest.fn(),
      },
    };
  }

  it('au plus 500 pages : texte extrait, document détruit', async () => {
    const { deps, destroy } = fakePdf(PDF_TEXT_MAX_PAGES);
    const text = await extractTextFromBytes(bytes, '.pdf', deps);
    expect(text).toContain('page 500');
    expect(deps.extractPage).toHaveBeenCalledTimes(PDF_TEXT_MAX_PAGES);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('plus de 500 pages : texte null sans aucun parcours de page, document détruit', async () => {
    const { deps, destroy } = fakePdf(PDF_TEXT_MAX_PAGES + 1);
    expect(await extractTextFromBytes(bytes, '.pdf', deps)).toBeNull();
    expect(deps.extractPage).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('PDF réel de 501 pages : texte null et nombre de pages correct dans le fichier créé', async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < PDF_TEXT_MAX_PAGES + 1; i++) pdf.addPage();
    const big = Buffer.from(await pdf.save());
    const { prisma, deps } = fakeDeps();
    await ingestExternalFile({ bytes: big, name: 'gros.pdf', dossierId: null }, GRANTS, deps);
    const file = (
      prisma.document.create.mock.calls as unknown as [
        {
          data: {
            versions: {
              create: { files: { create: { pageCount: number; ocrText: string | null } } };
            };
          };
        },
      ][]
    )[0]![0].data.versions.create.files.create;
    expect(file.pageCount).toBe(PDF_TEXT_MAX_PAGES + 1);
    expect(file.ocrText).toBeNull();
  }, 30_000);

  it('délai dépassé pendant le parcours : null sans bloquer, destruction, journal sans contenu', async () => {
    const { deps, destroy } = fakePdf(3, (n) =>
      n === 1 ? new Promise<string>(() => {}) : Promise.resolve('secret'),
    );
    const t0 = performance.now();
    const text = await extractTextFromBytes(bytes, '.pdf', { ...deps, timeoutMs: 50 });
    expect(text).toBeNull();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deps.warn.mock.calls)).not.toMatch(/secret|simulé/);
  });

  it('chargement qui ne finit jamais : null au délai, rien à détruire', async () => {
    const warn = jest.fn();
    const text = await extractTextFromBytes(bytes, '.pdf', {
      load: () => new Promise(() => {}),
      timeoutMs: 50,
      warn,
    });
    expect(text).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("document détruit aussi quand la lecture d'une page échoue", async () => {
    const { deps, destroy } = fakePdf(2, () => Promise.reject(new Error('corrompu')));
    expect(await extractTextFromBytes(bytes, '.pdf', deps)).toBeNull();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('comptage de pages : valeur nominale, null sur erreur, null au délai (journal sans contenu)', async () => {
    expect(await countPdfPages(bytes, { countPages: async () => 7 })).toBe(7);
    expect(
      await countPdfPages(bytes, { countPages: () => Promise.reject(new Error('x')) }),
    ).toBeNull();
    const warn = jest.fn();
    const t0 = performance.now();
    expect(
      await countPdfPages(bytes, { countPages: () => new Promise(() => {}), timeoutMs: 50, warn }),
    ).toBeNull();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('idempotence au rejeu (ingestion)', () => {
  it("le document est créé déjà rattaché à l'élément de source", async () => {
    const { prisma, deps } = fakeDeps();
    await ingestExternalFile(
      { bytes: Buffer.from('x'), name: 'a.txt', dossierId: null, sourceItemId: 42n },
      GRANTS,
      deps,
    );
    const data = (
      prisma.document.create.mock.calls as unknown as [{ data: { gedSourceItems?: unknown } }][]
    )[0]![0].data;
    expect(data.gedSourceItems).toEqual({ connect: { gedSourceItemId: 42n } });
  });

  it("nouvelle version à l'empreinte déjà portée par la dernière version : aucune version de trop, octets réécrits", async () => {
    const bytes = Buffer.from('v2');
    const { prisma, fileStore, seal, deps } = fakeDeps();
    prisma.documentVersion.findFirst.mockResolvedValue({
      documentVersionId: 201,
      versionNumber: 2,
      files: [{ fileId: 301, hash: sha(bytes) }],
    } as never);
    const res = await addVersionFromSource(100, { bytes, name: 'a.txt', dossierId: null }, deps);
    expect(res).toEqual({ documentId: 100, documentVersionId: 201, fileId: 301, versionNumber: 2 });
    expect(prisma.documentVersion.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(fileStore.write).toHaveBeenCalledWith(301, '.txt', bytes);
    expect(seal).toHaveBeenCalledWith(100, '/coffre');
  });
});
