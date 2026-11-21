import JSZip from 'jszip';
import {
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { importDocxToHtml } from './server';

const build = async (children: Array<Paragraph | Table>): Promise<Buffer> =>
  Packer.toBuffer(
    new Document({
      numbering: {
        config: [
          {
            reference: 'puces',
            levels: [{ level: 0, format: LevelFormat.BULLET, text: '•' }],
          },
          {
            reference: 'nums',
            levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.' }],
          },
        ],
      },
      sections: [{ children }],
    }),
  );

describe('importDocxToHtml', () => {
  it('importe titres, paragraphes en gras, listes et tableau', async () => {
    const docx = await build([
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Mon titre')] }),
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Sous-titre')] }),
      new Paragraph({
        children: [new TextRun('Texte '), new TextRun({ text: 'gras', bold: true }), new TextRun({ text: ' souligné', underline: {} })],
      }),
      new Paragraph({ numbering: { reference: 'puces', level: 0 }, children: [new TextRun('Puce A')] }),
      new Paragraph({ numbering: { reference: 'puces', level: 0 }, children: [new TextRun('Puce B')] }),
      new Paragraph({ numbering: { reference: 'nums', level: 0 }, children: [new TextRun('Num 1')] }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph('C1')] }),
              new TableCell({ children: [new Paragraph('C2')] }),
            ],
          }),
        ],
      }),
    ]);
    const { html, warnings } = await importDocxToHtml(docx);
    expect(html).toContain('<h1>Mon titre</h1>');
    expect(html).toContain('<h2>Sous-titre</h2>');
    expect(html).toContain('<strong>gras</strong>');
    expect(html).toContain('<u> souligné</u>');
    expect(html).toMatch(/<ul><li>Puce A<\/li><li>Puce B<\/li><\/ul>/);
    expect(html).toMatch(/<ol><li>Num 1<\/li><\/ol>/);
    expect(html).toMatch(/<table>.*<td><p>C1<\/p><\/td><td><p>C2<\/p><\/td>.*<\/table>/);
    expect(Array.isArray(warnings)).toBe(true);
  });

  it('un HTML/script littéral dans le texte reste inerte (échappé)', async () => {
    const docx = await build([
      new Paragraph({
        children: [
          new TextRun('<script>alert(1)</script> <img src=x onerror=alert(2)> <a href="javascript:alert(3)">x</a>'),
        ],
      }),
    ]);
    const { html } = await importDocxToHtml(docx);
    expect(html).not.toMatch(/<script|<img|<a /i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  it('ignore les images et le signale', async () => {
    const docx = await build([new Paragraph('Texte')]);
    const zip = await JSZip.loadAsync(docx);
    // PNG 1x1 minimal ajouté dans word/media + relation + type de contenu + référence dans le document.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    zip.file('word/media/image1.png', png);
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    zip.file(
      'word/_rels/document.xml.rels',
      rels.replace(
        '</Relationships>',
        '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
      ),
    );
    const ct = await zip.file('[Content_Types].xml')!.async('string');
    zip.file(
      '[Content_Types].xml',
      ct.includes('Extension="png"') ? ct : ct.replace('<Override', '<Default Extension="png" ContentType="image/png"/><Override'),
    );
    const doc = await zip.file('word/document.xml')!.async('string');
    const drawing =
      '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="10" cy="10"/><wp:docPr id="1" name="i"/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="i"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic>' +
      '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    zip.file('word/document.xml', doc.replace('</w:body>', `${drawing}</w:body>`));
    const withImage = await zip.generateAsync({ type: 'nodebuffer' });
    const { html, warnings } = await importDocxToHtml(withImage);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('Texte');
    expect(warnings.join(' ')).toMatch(/images/i);
  });

  it('rejette un fichier qui n’est pas un zip', async () => {
    await expect(importDocxToHtml(Buffer.from('ceci est du texte brut'))).rejects.toThrow(/DOCX/);
    await expect(importDocxToHtml(Buffer.from('%PDF-1.7 ...'))).rejects.toThrow(/pas un document DOCX/);
  });

  it('rejette un tampon vide', async () => {
    await expect(importDocxToHtml(Buffer.alloc(0))).rejects.toThrow(/vide|invalide/);
  });

  it('rejette un zip tronqué / corrompu', async () => {
    const docx = await build([new Paragraph('Texte')]);
    await expect(importDocxToHtml(docx.subarray(0, Math.floor(docx.length / 2)))).rejects.toThrow(
      /DOCX/,
    );
  });

  it('rejette un zip valide qui n’est pas un DOCX', async () => {
    const zip = new JSZip();
    zip.file('lisez-moi.txt', 'bonjour');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(importDocxToHtml(buf)).rejects.toThrow(/introuvable|invalide/);
  });

  it('rejette un fichier trop gros (> 10 Mo)', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    big[0] = 0x50;
    big[1] = 0x4b;
    big[2] = 0x03;
    big[3] = 0x04;
    await expect(importDocxToHtml(big)).rejects.toThrow(/trop volumineux/);
  });

  it('rejette une bombe de décompression (> 20 Mo décompressés)', async () => {
    const docx = await build([new Paragraph('Texte')]);
    const zip = await JSZip.loadAsync(docx);
    // 60 Mo de zéros : se compresse en quelques dizaines de Ko.
    zip.file('word/bombe.bin', Buffer.alloc(25 * 1024 * 1024, 0));
    const bomb = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    expect(bomb.length).toBeLessThan(10 * 1024 * 1024);
    await expect(importDocxToHtml(bomb)).rejects.toThrow(/décompressé|suspecte/);
  }, 120000);

  it('rejette une bombe sur word/document.xml (> 10 Mo décompressés)', async () => {
    const docx = await build([new Paragraph('Texte')]);
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml + ' '.repeat(12 * 1024 * 1024));
    const bomb = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    await expect(importDocxToHtml(bomb)).rejects.toThrow(/décompressé|suspecte/);
  }, 120000);

  it('rejette une archive contenant trop d’entrées', async () => {
    const docx = await build([new Paragraph('Texte')]);
    const zip = await JSZip.loadAsync(docx);
    for (let i = 0; i < 2100; i++) zip.file(`word/x/${i}.txt`, 'a');
    const many = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await expect(importDocxToHtml(many)).rejects.toThrow(/trop de fichiers/);
  });
});
