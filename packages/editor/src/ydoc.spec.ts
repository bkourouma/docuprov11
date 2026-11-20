import * as Y from 'yjs';
import {
  EDITOR_FRAGMENT,
  EDITOR_LIMITS,
  addComment,
  applyHtmlToYDoc,
  createEditorExtensions,
  decodeState,
  encodeState,
  extractMentionIds,
  getEditorSchema,
  htmlToYDoc,
  listComments,
  yDocToHtml,
  yDocToJson,
  yDocToPlainText,
} from './server';

const HTML =
  '<h1>Titre</h1><p>Texte <strong>gras</strong> <em>it</em> <u>so</u> <s>ba</s> <code>c</code> ' +
  '<a href="https://exemple.org/x">lien</a></p>' +
  '<ul><li><p>Un</p><ul><li><p>Sous</p></li></ul></li><li><p>Deux</p></li></ul>' +
  '<ol><li><p>A</p></li></ol><blockquote><p>Cit</p></blockquote><pre><code>x = 1</code></pre>' +
  '<table><tbody><tr><th><p>H</p></th><th><p>H2</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>';

describe('schéma', () => {
  it('ne contient ni image ni iframe, et contient mention, comment et tableaux', () => {
    const schema = getEditorSchema();
    expect(schema.nodes.image).toBeUndefined();
    expect(schema.nodes.iframe).toBeUndefined();
    for (const n of ['mention', 'table', 'tableRow', 'tableCell', 'tableHeader', 'heading']) {
      expect(schema.nodes[n]).toBeDefined();
    }
    expect(schema.marks.comment).toBeDefined();
    expect(schema.marks.underline).toBeDefined();
    expect(schema.marks.link).toBeDefined();
  });

  it("n'inclut pas l'historique (undoRedo)", () => {
    const names = createEditorExtensions().map((e) => e.name);
    expect(names).not.toContain('undoRedo');
    expect(names).toContain('mention');
    expect(names).toContain('comment');
  });

  it('transmet mentionSuggestion tel quel', () => {
    const suggestion = { char: '@', items: () => [] };
    const mention = createEditorExtensions({ mentionSuggestion: suggestion }).find((e) => e.name === 'mention');
    const recu = (mention?.options as { suggestion: { char: string; items: unknown } }).suggestion;
    expect(recu.char).toBe('@');
    expect(recu.items).toBe(suggestion.items);
  });
});

describe('HTML -> Y.Doc -> JSON -> HTML', () => {
  it('fait un aller-retour stable', () => {
    const ydoc = htmlToYDoc(HTML);
    const json = yDocToJson(ydoc);
    expect(json.type).toBe('doc');
    expect(json.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    const html = yDocToHtml(ydoc);
    expect(html).toContain('<h1>Titre</h1>');
    expect(html).toContain('<strong>gras</strong>');
    expect(html).toContain('<em>it</em>');
    expect(html).toContain('<u>so</u>');
    expect(html).toContain('<s>ba</s>');
    expect(html).toContain('<code>c</code>');
    expect(html).toContain('href="https://exemple.org/x"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('target=');
    expect(html).toMatch(/<ul><li><p>Un<\/p><ul><li><p>Sous<\/p><\/li><\/ul><\/li><li><p>Deux<\/p><\/li><\/ul>/);
    expect(html).toContain('<blockquote><p>Cit</p></blockquote>');
    expect(html).toContain('<pre><code>x = 1</code></pre>');
    expect(html).toMatch(/<table>[\s\S]*<th>[\s\S]*H2[\s\S]*<td>[\s\S]*2[\s\S]*<\/table>/);
    // Second tour : HTML -> Y.Doc -> HTML produit le même HTML (point fixe).
    expect(yDocToHtml(htmlToYDoc(html))).toBe(html);
    expect(yDocToJson(htmlToYDoc(html))).toEqual(json);
  });

  it('conserve les mentions et les ancres de commentaire', () => {
    const ydoc = htmlToYDoc(
      '<p>Bonjour <span data-type="mention" data-id="12" data-label="Alice">@Alice</span> ' +
        '<span data-comment-id="3f2b8c10-aaaa-bbbb-cccc-123456789012">ancré</span></p>',
    );
    const html = yDocToHtml(ydoc);
    expect(html).toContain('data-type="mention"');
    expect(html).toContain('data-id="12"');
    expect(html).toContain('data-label="Alice"');
    expect(html).toContain('data-comment-id="3f2b8c10-aaaa-bbbb-cccc-123456789012"');
    expect(extractMentionIds(ydoc)).toEqual([12]);
    expect(yDocToPlainText(ydoc)).toBe('Bonjour @Alice ancré');
  });

  it("assainit à l'entrée : aucun script/img/handler ne survit", () => {
    const ydoc = htmlToYDoc(
      '<p onclick="x()">a</p><script>alert(1)</script><img src="data:image/png;base64,AA"><a href="javascript:alert(1)">l</a><iframe src="x"></iframe>',
    );
    const html = yDocToHtml(ydoc);
    expect(html).not.toMatch(/script|img|onclick|javascript|iframe|alert/i);
    expect(yDocToPlainText(ydoc)).toBe('a\nl');
  });

  it('un document vide donne un paragraphe vide et un HTML vide', () => {
    const ydoc = htmlToYDoc('');
    expect(yDocToJson(ydoc).content).toEqual([{ type: 'paragraph' }]);
    expect(yDocToPlainText(ydoc)).toBe('');
  });

  it('applyHtmlToYDoc remplace le contenu sans toucher aux commentaires', () => {
    const ydoc = htmlToYDoc('<p>ancien</p>');
    addComment(ydoc, {
      id: '3f2b8c10-aaaa-bbbb-cccc-123456789012',
      authorUserGroupId: 1,
      authorName: 'A',
      body: 'garde-moi',
      anchorText: 'ancien',
      mentions: [],
    });
    let transactions = 0;
    ydoc.on('afterTransaction', () => transactions++);
    applyHtmlToYDoc(ydoc, '<h2>nouveau</h2><p>contenu</p>');
    expect(transactions).toBe(1);
    expect(yDocToPlainText(ydoc)).toBe('nouveau\ncontenu');
    expect(yDocToHtml(ydoc)).not.toContain('ancien');
    expect(listComments(ydoc).map((c) => c.body)).toEqual(['garde-moi']);
  });

  it('le texte de yDocToPlainText ignore les balises des marques Yjs', () => {
    const ydoc = htmlToYDoc('<p>un <strong>deux <em>trois</em></strong> quatre</p><ul><li><p>a</p></li><li><p>b</p></li></ul>');
    expect(yDocToPlainText(ydoc)).toBe('un deux trois quatre\na\nb');
  });
});

describe('encodeState / decodeState', () => {
  it("restitue le même document (contenu et commentaires)", () => {
    const ydoc = htmlToYDoc(HTML);
    addComment(ydoc, {
      id: '3f2b8c10-aaaa-bbbb-cccc-123456789012',
      authorUserGroupId: 1,
      authorName: 'A',
      body: 'c',
      anchorText: '',
      mentions: [4],
    });
    const copie = decodeState(encodeState(ydoc));
    expect(yDocToJson(copie)).toEqual(yDocToJson(ydoc));
    expect(listComments(copie)).toEqual(listComments(ydoc));
    expect(copie.getXmlFragment(EDITOR_FRAGMENT).length).toBe(ydoc.getXmlFragment(EDITOR_FRAGMENT).length);
  });

  it('accepte un document vide', () => {
    expect(() => decodeState(encodeState(new Y.Doc()))).not.toThrow();
  });

  it(`rejette plus de ${EDITOR_LIMITS.MAX_STATE_BYTES} octets`, () => {
    expect(() => decodeState(new Uint8Array(EDITOR_LIMITS.MAX_STATE_BYTES + 1))).toThrow(/trop volumineux/);
  });

  it('rejette des octets corrompus ou tronqués', () => {
    expect(() => decodeState(new Uint8Array([255, 255, 255, 1, 2, 3]))).toThrow(/corrompu/);
    expect(() => decodeState(new Uint8Array([]))).toThrow(/corrompu/);
    const bytes = encodeState(htmlToYDoc(HTML));
    expect(() => decodeState(bytes.subarray(0, Math.floor(bytes.length / 2)))).toThrow(/corrompu/);
    expect(() => decodeState('x' as unknown as Uint8Array)).toThrow(/invalide/);
  });
});
