// @archivage/exports — P3 grid exports (T051): xlsx (ExcelJS), csv (fast-csv),
// docx (docx), pdf (PDFKit). Each reflects exactly the rows/columns it is given.
//
// Remplissage d'un gabarit .docx existant : voir ./docx-template (la lib `docx` ci-dessous CRÉE
// des documents, elle ne sait pas remplir un modèle).
export { fillDocxTemplate, findDocxTokens } from './docx-template';
export { fichePdfDoc, renderFichePdf, type FichePdfDoc, type FicheSection } from './fiche-pdf';
import ExcelJS from 'exceljs';
import { writeToBuffer } from 'fast-csv';
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  HeadingLevel,
} from 'docx';
import PDFDocument from 'pdfkit';

export interface ExportColumn {
  key: string;
  header: string;
}

export interface ExportRequest {
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
  title?: string;
}

export type ExportFormat = 'xlsx' | 'csv' | 'docx' | 'pdf';

/**
 * Identité « Plus Admin » (relook 002) reportée ici en valeurs littérales.
 *
 * Ce paquet tourne côté Node (API et worker) : il ne peut pas importer `apps/web/app/theme/tokens.ts`
 * (module du front), et ni ExcelJS ni PDFKit ne savent lire une variable CSS — ils veulent un ARGB
 * ou un hex. Les valeurs sont donc RECOPIÉES depuis les tokens et doivent être mises à jour à la
 * main si les tokens évoluent. Volontairement sobre : ces fichiers sont imprimés et archivés, pas
 * consultés dans un navigateur — pas d'aplat massif, pas de dégradé.
 *
 * primary #0033c4 · border #e4e9f0 · text #030303 · borderControl #8d95a5 (cf. design-tokens.md).
 */
const BRAND = {
  /** Bleu roi : en-tête de tableau Excel, titres de document. */
  primary: '#0033c4',
  primaryArgb: 'FF0033C4',
  /** Blanc posé sur le bleu roi : 9,25:1. */
  onPrimaryArgb: 'FFFFFFFF',
  /** Filets et bordures de cellules (token `border`). */
  rule: '#e4e9f0',
  ruleArgb: 'FFE4E9F0',
  /** Corps de texte (token `text`). */
  text: '#030303',
} as const;

function cell(value: unknown): string {
  return value == null ? '' : String(value);
}

export async function toXlsx(req: ExportRequest): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(req.title ?? 'Documents');
  ws.columns = req.columns.map((c) => ({ header: c.header, key: c.key, width: 24 }));
  for (const row of req.rows) {
    ws.addRow(Object.fromEntries(req.columns.map((c) => [c.key, cell(row[c.key])])));
  }

  // Habillage : ligne 1 en bleu roi / blanc gras, filets fins sur toutes les cellules. Aucune
  // donnée ni colonne n'est touchée — uniquement le style des cellules déjà écrites.
  const thin = { style: 'thin' as const, color: { argb: BRAND.ruleArgb } };
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (c) => {
      c.border = { top: thin, left: thin, bottom: thin, right: thin };
      if (rowNumber === 1) {
        c.font = { bold: true, color: { argb: BRAND.onPrimaryArgb } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.primaryArgb } };
        c.alignment = { vertical: 'middle' };
      }
    });
  });
  ws.getRow(1).height = 20;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toCsv(req: ExportRequest): Promise<Buffer> {
  const data: string[][] = [
    req.columns.map((c) => c.header),
    ...req.rows.map((r) => req.columns.map((c) => cell(r[c.key]))),
  ];
  return writeToBuffer(data);
}

export async function toDocx(req: ExportRequest): Promise<Buffer> {
  const headerRow = new TableRow({
    children: req.columns.map(
      (c) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: c.header, bold: true })] })],
        }),
    ),
  });
  const bodyRows = req.rows.map(
    (r) =>
      new TableRow({
        children: req.columns.map(
          (c) => new TableCell({ children: [new Paragraph(cell(r[c.key]))] }),
        ),
      }),
  );
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: req.title ?? 'Documents', heading: HeadingLevel.HEADING_1 }),
          new Table({ rows: [headerRow, ...bodyRows] }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export function toPdf(req: ExportRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 30, layout: 'landscape' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Titre en bleu roi, puis filet de séparation sur toute la largeur utile : le seul habillage
    // du document (mêmes colonnes, mêmes libellés, même ordre qu'avant).
    doc.font('Helvetica-Bold').fontSize(16).fillColor(BRAND.primary);
    doc.text(req.title ?? 'Documents');
    doc.moveDown(0.35);

    const ruleY = doc.y;
    doc
      .moveTo(doc.page.margins.left, ruleY)
      .lineTo(doc.page.width - doc.page.margins.right, ruleY)
      .lineWidth(0.5)
      .strokeColor(BRAND.rule)
      .stroke();
    doc.moveDown(0.5);

    doc.fillColor(BRAND.text).fontSize(9);
    doc.font('Helvetica-Bold').text(req.columns.map((c) => c.header).join('  |  '));
    doc.font('Helvetica');
    for (const row of req.rows) {
      doc.text(req.columns.map((c) => cell(row[c.key])).join('  |  '));
    }
    doc.end();
  });
}

export async function exportRows(
  format: ExportFormat,
  req: ExportRequest,
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  switch (format) {
    case 'xlsx':
      return {
        buffer: await toXlsx(req),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'documents.xlsx',
      };
    case 'csv':
      return {
        buffer: await toCsv(req),
        contentType: 'text/csv; charset=utf-8',
        filename: 'documents.csv',
      };
    case 'docx':
      return {
        buffer: await toDocx(req),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'documents.docx',
      };
    case 'pdf':
      return {
        buffer: await toPdf(req),
        contentType: 'application/pdf',
        filename: 'documents.pdf',
      };
  }
}
