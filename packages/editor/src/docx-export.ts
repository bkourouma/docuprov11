import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { ILevelsOptions, IRunOptions, ParagraphChild } from 'docx';
import type { JSONContent } from '@tiptap/core';
import type { EditorComment } from './constants';

export interface ExportDocxInput {
  title: string;
  json: JSONContent;
  comments?: EditorComment[];
  author?: string;
}

type Block = Paragraph | Table;

const FONT = 'Calibri';
const MONO = 'Consolas';
const BULLET_REF = 'docupro-bullets';
const ORDERED_REF = 'docupro-ordered';
const MAX_DEPTH = 40;

/** Tableau sûr : un contenu JSON mal formé (non-tableau) est traité comme vide. */
const asNodes = (value: unknown): JSONContent[] =>
  Array.isArray(value) ? (value.filter((n) => typeof n === 'object' && n !== null) as JSONContent[]) : [];

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** Retire les caractères interdits en XML 1.0 (sinon le DOCX serait illisible dans Word). */
const xmlSafe = (text: string): string =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

const isSafeHref = (href: unknown): href is string =>
  typeof href === 'string' && /^(https?:\/\/|mailto:)/i.test(href.trim());

const numberingLevels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], bullet: boolean) => {
  const levels: ILevelsOptions[] = [];
  for (let i = 0; i < 9; i++) {
    levels.push({
      level: i,
      format,
      text: bullet ? (i % 2 === 0 ? '•' : '◦') : `%${i + 1}.`,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } },
    });
  }
  return levels;
};

interface Ctx {
  orderedInstance: number;
}

const textRuns = (text: string, base: Omit<IRunOptions, 'text' | 'break'>): TextRun[] => {
  const lines = xmlSafe(text).split(/\r\n|\r|\n/);
  const runs: TextRun[] = [];
  lines.forEach((line, i) => {
    runs.push(new TextRun({ ...base, text: line, ...(i > 0 ? { break: 1 } : {}) }));
  });
  return runs;
};

/** Contenu en ligne (texte avec marques, mentions, sauts de ligne) d'un nœud. */
const inlineChildren = (node: JSONContent, forceBold = false, depth = 0): ParagraphChild[] => {
  const out: ParagraphChild[] = [];
  // Au-delà de MAX_DEPTH on tronque (pas de récursion non bornée sur un JSON profondément imbriqué).
  if (depth > MAX_DEPTH) return out;
  for (const child of asNodes(node.content)) {
    if (child.type === 'text') {
      const marks = child.marks ?? [];
      const has = (name: string) => marks.some((m) => m.type === name);
      const link = marks.find((m) => m.type === 'link');
      const href = link?.attrs?.href;
      const style = {
        bold: forceBold || has('bold') || undefined,
        italics: has('italic') || undefined,
        underline: has('underline') ? {} : undefined,
        strike: has('strike') || undefined,
        font: has('code') ? MONO : undefined,
        shading: has('code') ? { type: ShadingType.CLEAR, fill: 'EEEEEE', color: 'auto' } : undefined,
      };
      const runs = textRuns(typeof child.text === 'string' ? child.text : '', link && isSafeHref(href) ? {
        ...style,
        color: '0563C1',
        underline: {},
      } : style);
      if (link && isSafeHref(href)) {
        out.push(new ExternalHyperlink({ link: href.trim(), children: runs }));
      } else {
        out.push(...runs);
      }
    } else if (child.type === 'mention') {
      const label = String(child.attrs?.label ?? child.attrs?.id ?? '');
      out.push(new TextRun({ text: xmlSafe(`@${label}`), bold: true, color: '1F4E79' }));
    } else if (child.type === 'hardBreak') {
      out.push(new TextRun({ break: 1 }));
    } else if (child.content) {
      out.push(...inlineChildren(child, forceBold, depth + 1));
    }
  }
  return out;
};

const blocksOf = (
  nodes: JSONContent[] | undefined,
  ctx: Ctx,
  opts: { quote?: boolean; bold?: boolean },
  depth: number,
): Block[] => {
  if (depth > MAX_DEPTH) return [];
  const out: Block[] = [];
  for (const node of asNodes(nodes)) out.push(...blockOf(node, ctx, opts, depth + 1));
  return out;
};

const listBlocks = (
  node: JSONContent,
  ordered: boolean,
  level: number,
  ctx: Ctx,
  depth: number,
): Block[] => {
  if (depth > MAX_DEPTH) return [];
  const out: Block[] = [];
  const instance = ordered ? ++ctx.orderedInstance : 0;
  const numberingLevel = Math.min(level, 8);
  for (const item of asNodes(node.content)) {
    let numbered = false;
    for (const part of asNodes(item.content)) {
      if (part.type === 'bulletList' || part.type === 'orderedList') {
        out.push(...listBlocks(part, part.type === 'orderedList', level + 1, ctx, depth + 1));
      } else if (part.type === 'paragraph' || part.type === 'heading') {
        out.push(
          new Paragraph({
            children: inlineChildren(part),
            ...(numbered
              ? { indent: { left: 720 * (numberingLevel + 1) } }
              : {
                  numbering: ordered
                    ? { reference: ORDERED_REF, level: numberingLevel, instance }
                    : { reference: BULLET_REF, level: numberingLevel },
                }),
          }),
        );
        numbered = true;
      } else {
        out.push(...blockOf(part, ctx, {}, depth + 1));
      }
    }
  }
  return out;
};

const tableBlock = (node: JSONContent, ctx: Ctx, depth: number): Table | null => {
  const rows: TableRow[] = [];
  for (const row of asNodes(node.content)) {
    if (row.type !== 'tableRow') continue;
    const cells: TableCell[] = [];
    for (const cell of asNodes(row.content)) {
      const header = cell.type === 'tableHeader';
      let children = blocksOf(cell.content, ctx, { bold: header }, depth + 1).filter(
        (b): b is Paragraph => b instanceof Paragraph,
      );
      if (children.length === 0) children = [new Paragraph({})];
      const colspan = Number(cell.attrs?.colspan ?? 1);
      const rowspan = Number(cell.attrs?.rowspan ?? 1);
      cells.push(
        new TableCell({
          children,
          ...(colspan > 1 && colspan <= 50 ? { columnSpan: Math.floor(colspan) } : {}),
          ...(rowspan > 1 && rowspan <= 1000 ? { rowSpan: Math.floor(rowspan) } : {}),
          ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'E7E6E6', color: 'auto' } } : {}),
        }),
      );
    }
    if (cells.length > 0) rows.push(new TableRow({ children: cells }));
  }
  if (rows.length === 0) return null;
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
};

const blockOf = (
  node: JSONContent,
  ctx: Ctx,
  opts: { quote?: boolean; bold?: boolean },
  depth: number,
): Block[] => {
  switch (node.type) {
    case 'paragraph':
      return [
        new Paragraph({
          children: inlineChildren(node, opts.bold),
          ...(opts.quote ? { style: 'Quote' } : {}),
        }),
      ];
    case 'heading': {
      const lvl = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      return [new Paragraph({ heading: HEADINGS[lvl - 1], children: inlineChildren(node) })];
    }
    case 'bulletList':
      return listBlocks(node, false, 0, ctx, depth);
    case 'orderedList':
      return listBlocks(node, true, 0, ctx, depth);
    case 'blockquote':
      return blocksOf(node.content, ctx, { ...opts, quote: true }, depth);
    case 'codeBlock': {
      const text = asNodes(node.content).map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
      return xmlSafe(text)
        .split(/\r\n|\r|\n/)
        .map(
          (line) =>
            new Paragraph({ style: 'Code', children: [new TextRun({ text: line, font: MONO })] }),
        );
    }
    case 'horizontalRule':
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } },
        }),
      ];
    case 'table': {
      const table = tableBlock(node, ctx, depth);
      // Un paragraphe vide après un tableau évite que Word fusionne deux tableaux adjacents.
      return table ? [table, new Paragraph({})] : [];
    }
    case 'text':
    case 'mention':
    case 'hardBreak':
      return [new Paragraph({ children: inlineChildren({ type: 'p', content: [node] }) })];
    default:
      return blocksOf(node.content, ctx, opts, depth);
  }
};

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return xmlSafe(iso);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

const commentsAnnex = (comments: EditorComment[]): Block[] => {
  const out: Block[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun('Commentaires')] }),
  ];
  for (const c of comments) {
    out.push(
      new Paragraph({
        spacing: { before: 240 },
        children: [
          new TextRun({ text: xmlSafe(c.authorName), bold: true }),
          new TextRun({ text: ` — ${formatDate(c.createdAt)} — ` }),
          new TextRun({
            text: c.resolved ? 'Résolu' : 'Ouvert',
            bold: true,
            color: c.resolved ? '2E7D32' : 'C62828',
          }),
        ],
      }),
    );
    if (c.anchorText) {
      out.push(
        new Paragraph({
          style: 'Quote',
          children: [new TextRun({ text: `« ${xmlSafe(c.anchorText)} »`, italics: true })],
        }),
      );
    }
    out.push(new Paragraph({ children: textRuns(c.body, {}) }));
    if (c.resolved && c.resolvedByName) {
      out.push(
        new Paragraph({
          children: [
            new TextRun({
              text: xmlSafe(`Résolu par ${c.resolvedByName}${c.resolvedAt ? ` le ${formatDate(c.resolvedAt)}` : ''}`),
              italics: true,
            }),
          ],
        }),
      );
    }
    for (const r of c.replies) {
      out.push(
        new Paragraph({
          indent: { left: 720 },
          children: [
            new TextRun({ text: xmlSafe(r.authorName), bold: true }),
            new TextRun({ text: ` — ${formatDate(r.createdAt)} : ` }),
            ...textRuns(r.body, {}),
          ],
        }),
      );
    }
  }
  return out;
};

/** JSON Tiptap -> DOCX (bibliothèque `docx`). Titres, listes, gras/italique/souligné, liens, tableaux, citations, code. */
export const exportDocx = async (input: ExportDocxInput): Promise<Buffer> => {
  const title = xmlSafe(input.title?.trim() || 'Document');
  const author = xmlSafe(input.author?.trim() || 'DocuPro');
  const ctx: Ctx = { orderedInstance: 0 };

  const children: Block[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
    ...blocksOf(input.json?.content, ctx, {}, 0),
  ];
  if (input.comments && input.comments.length > 0) children.push(...commentsAnnex(input.comments));

  const doc = new Document({
    creator: author,
    lastModifiedBy: author,
    title,
    styles: {
      default: { document: { run: { font: FONT, size: 22 } } },
      paragraphStyles: [
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          quickFormat: true,
          run: { italics: true, color: '595959' },
          paragraph: {
            indent: { left: 720 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 8 } },
          },
        },
        {
          id: 'Code',
          name: 'Code',
          basedOn: 'Normal',
          quickFormat: true,
          run: { font: MONO, size: 20 },
          paragraph: {
            shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' },
            spacing: { after: 0 },
          },
        },
      ],
    },
    numbering: {
      config: [
        { reference: BULLET_REF, levels: numberingLevels(LevelFormat.BULLET, true) },
        { reference: ORDERED_REF, levels: numberingLevels(LevelFormat.DECIMAL, false) },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
};
