import JSZip from 'jszip';
import * as mammoth from 'mammoth';
import type { JSONContent } from '@tiptap/core';
import { exportDocx, importDocxToHtml, type EditorComment } from './server';

const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({
  type: 'text',
  text: t,
  ...(marks ? { marks } : {}),
});
const p = (...c: JSONContent[]): JSONContent => ({ type: 'paragraph', content: c });

const json: JSONContent = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [text('Titre principal')] },
    { type: 'heading', attrs: { level: 2 }, content: [text('Section A')] },
    p(
      text('Du '),
      text('gras', [{ type: 'bold' }]),
      text(', de l’'),
      text('italique', [{ type: 'italic' }]),
      text(', du '),
      text('souligné', [{ type: 'underline' }]),
      text(' et du '),
      text('barré', [{ type: 'strike' }]),
      text('.'),
    ),
    p(
      text('Un '),
      text('lien', [{ type: 'link', attrs: { href: 'https://exemple.org/page?a=1&b=2' } }]),
      text(' et un '),
      text('piégé', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
      text(' puis '),
      { type: 'mention', attrs: { id: '12', label: 'Alice Martin' } },
      text(' et '),
      text('ancré', [{ type: 'comment', attrs: { commentId: '3f2b8c10-aaaa-bbbb-cccc-123456789012' } }]),
    ),
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [p(text('Puce un')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('Sous-puce'))] }] }],
        },
        { type: 'listItem', content: [p(text('Puce deux'))] },
      ],
    },
    {
      type: 'orderedList',
      content: [
        { type: 'listItem', content: [p(text('Étape 1'))] },
        { type: 'listItem', content: [p(text('Étape 2'))] },
      ],
    },
    { type: 'blockquote', content: [p(text('Une citation importante'))] },
    { type: 'codeBlock', content: [text('const a = 1;\nconst b = "<x> & y";')] },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [p(text('Colonne 1'))] },
            { type: 'tableHeader', attrs: { colspan: 1, rowspan: 1 }, content: [p(text('Colonne 2'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p(text('a & b'))] },
            { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [p(text('<c>'))] },
          ],
        },
      ],
    },
    p(text('Caractères spéciaux : <balise> & "guillemets" \'apostrophes\' ]]> \u0001\u0008 fin')),
  ],
};

const comments: EditorComment[] = [
  {
    id: '3f2b8c10-aaaa-bbbb-cccc-123456789012',
    authorUserGroupId: 5,
    authorName: 'Bob <Admin> & Cie',
    createdAt: '2026-11-20T10:30:00.000Z',
    body: 'Merci de vérifier ce passage & la <source>.',
    anchorText: 'ancré',
    mentions: [12],
    resolved: false,
    resolvedByName: null,
    resolvedAt: null,
    replies: [
      {
        id: '4f2b8c10-aaaa-bbbb-cccc-123456789012',
        authorUserGroupId: 12,
        authorName: 'Alice Martin',
        createdAt: '2026-11-20T11:00:00.000Z',
        body: 'Fait.',
        mentions: [],
      },
    ],
  },
  {
    id: '5f2b8c10-aaaa-bbbb-cccc-123456789012',
    authorUserGroupId: 12,
    authorName: 'Alice Martin',
    createdAt: '2026-11-21T08:00:00.000Z',
    body: 'Point clos.',
    anchorText: '',
    mentions: [],
    resolved: true,
    resolvedByName: 'Bob',
    resolvedAt: '2026-11-21T09:00:00.000Z',
    replies: [],
  },
];

const documentXml = async (buf: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buf);
  return zip.file('word/document.xml')!.async('string');
};

describe('exportDocx', () => {
  it('produit un DOCX valide (zip, parties OOXML, métadonnées)', async () => {
    const buf = await exportDocx({ title: 'Mon <rapport> & plus', json, author: 'Alice Martin' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    expect(zip.file('word/document.xml')).not.toBeNull();
    expect(zip.file('word/numbering.xml')).not.toBeNull();
    const core = await zip.file('docProps/core.xml')!.async('string');
    expect(core).toContain('Alice Martin');
    expect(core).toContain('Mon &lt;rapport&gt; &amp; plus');
  });

  it('word/document.xml est un XML bien formé, échappé, sans caractère interdit', async () => {
    const xml = await documentXml(await exportDocx({ title: 'T', json }));
    expect(xml.startsWith('<?xml')).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(xml).toContain('&lt;balise&gt; &amp; &quot;guillemets&quot;');
    expect(xml).not.toContain('<balise>');
    expect(xml).not.toContain('<c>');
    expect(xml).toContain('a &amp; b');
    expect(xml).toContain('&lt;c&gt;');
    // Les mentions deviennent @Nom, la marque de commentaire disparaît, le lien piégé n'est pas un hyperlien.
    expect(xml).toContain('@Alice Martin');
    expect(xml).not.toContain('3f2b8c10-aaaa');
    expect(xml).not.toContain('javascript:');
    // Balises principales présentes.
    for (const tag of ['<w:tbl>', '<w:b/>', '<w:i/>', '<w:strike/>', '<w:u ', '<w:hyperlink', '<w:numPr>']) {
      expect(xml).toContain(tag);
    }
    // Le lien http valide existe dans les relations.
    const zip = await JSZip.loadAsync(await exportDocx({ title: 'T', json }));
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).toContain('https://exemple.org/page?a=1&amp;b=2');
  });

  it('se ré-ouvre avec mammoth et retrouve titres, listes, tableau et texte', async () => {
    const buf = await exportDocx({ title: 'Rapport annuel', json });
    const raw = await mammoth.convertToHtml({ buffer: buf });
    expect(raw.value).toContain('Rapport annuel');
    const { html } = await importDocxToHtml(buf);
    expect(html).toContain('<h1>Rapport annuel</h1>'); // titre du document (style Title)
    expect(html).toMatch(/<h1>Titre principal<\/h1>/);
    expect(html).toMatch(/<h2>Section A<\/h2>/);
    expect(html).toContain('<strong>gras</strong>');
    expect(html).toContain('<em>italique</em>');
    expect(html).toContain('<u>souligné</u>');
    expect(html).toContain('<s>barré</s>');
    expect(html).toContain('href="https://exemple.org/page?a=1&amp;b=2"');
    expect(html).toContain('@Alice Martin');
    expect(html).toMatch(/<ul><li>Puce un<ul><li>Sous-puce<\/li><\/ul><\/li><li>Puce deux<\/li><\/ul>/);
    expect(html).toMatch(/<ol><li>Étape 1<\/li><li>Étape 2<\/li><\/ol>/);
    expect(html).toContain('<blockquote>Une citation importante</blockquote>');
    expect(html).toContain('const a = 1;');
    expect(html).toMatch(/<table>[\s\S]*Colonne 1[\s\S]*a &amp; b[\s\S]*&lt;c&gt;[\s\S]*<\/table>/);
    expect(html).not.toMatch(/<script/i);
  });

  it('ajoute l’annexe « Commentaires » (auteur, date, texte, état, réponses)', async () => {
    const buf = await exportDocx({ title: 'Avec annexe', json, comments });
    const xml = await documentXml(buf);
    expect(xml).toContain('Commentaires');
    expect(xml).toContain('Bob &lt;Admin&gt; &amp; Cie');
    expect(xml).toContain('2026-11-20 10:30 UTC');
    expect(xml).toContain('Merci de vérifier ce passage &amp; la &lt;source&gt;.');
    expect(xml).toContain('Ouvert');
    expect(xml).toContain('Résolu');
    expect(xml).toContain('Résolu par Bob');
    expect(xml).toContain('Fait.');
    const { html } = await importDocxToHtml(buf);
    expect(html).toContain('<h1>Commentaires</h1>');
    expect(html).toContain('Point clos.');
  });

  it('sans commentaires, aucune annexe', async () => {
    const xml = await documentXml(await exportDocx({ title: 'Sans', json, comments: [] }));
    expect(xml).not.toContain('>Commentaires<');
  });

  it('tolère un document vide, un titre vide et des nœuds inconnus', async () => {
    const buf = await exportDocx({
      title: '   ',
      json: { type: 'doc', content: [{ type: 'inconnu', content: [p(text('dans inconnu'))] }, { type: 'bulletList' }] },
    });
    const { html } = await importDocxToHtml(buf);
    expect(html).toContain('<h1>Document</h1>');
    expect(html).toContain('dans inconnu');
    const vide = await exportDocx({ title: 'V', json: { type: 'doc' } });
    expect((await importDocxToHtml(vide)).html).toContain('<h1>V</h1>');
  });
});
