import * as Y from 'yjs';
import {
  EDITOR_FRAGMENT,
  addComment,
  exportDocx,
  extractMentionIds,
  htmlToYDoc,
  validateYDocStructure,
  yDocToHtml,
  yDocToJson,
  yDocToPlainText,
} from './server';

const fragmentOf = (doc: Y.Doc) => doc.getXmlFragment(EDITOR_FRAGMENT);

const el = (name: string) => new Y.XmlElement(name);

/** Document valide d'un paragraphe « Valide » (base des états empoisonnés). */
const validDoc = () => htmlToYDoc('<p>Valide</p>');

/**
 * Insère `depth` blockquote imbriqués à la position `index` du fragment. Chaque niveau est inséré
 * dans un parent DÉJÀ intégré (sinon Yjs intègre récursivement et déborde la pile dans le test).
 */
const addNestedQuotes = (doc: Y.Doc, index: number, depth: number): void => {
  doc.transact((tr) => {
    const root = el('blockquote');
    fragmentOf(doc).insert(index, [root]);
    let cur = root;
    for (let i = 1; i < depth; i++) {
      const next = el('blockquote');
      cur.insert(0, [next]);
      cur = next;
    }
    // Sans observateur : évite la remontée O(profondeur) de Yjs à chaque nœud modifié (quadratique).
    tr.changed.clear();
    tr.changedParentTypes.clear();
  });
};

const RICH =
  '<h1>Titre</h1><p>Texte <strong>gras</strong> <em>it</em> <u>so</u> <s>ba</s> <code>c</code> ' +
  '<a href="https://exemple.org/x">lien</a> <span data-comment-id="6f1c2b1e-8a3d-4c55-9e0a-1b2c3d4e5f60">cm</span></p>' +
  '<ul><li><p>Un</p><ul><li><p>Sous</p></li></ul></li><li><p>Deux</p></li></ul>' +
  '<ol><li><p>A</p></li></ol><blockquote><p>Cit</p></blockquote><pre><code>x = 1</code></pre>' +
  '<table><tbody><tr><th><p>H</p></th><th><p>H2</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>' +
  '<p>Mention <span data-type="mention" data-id="12" data-label="Alice"></span></p>';

describe('validateYDocStructure', () => {
  it('accepte un document vide, un document HTML et un document riche', () => {
    expect(validateYDocStructure(new Y.Doc())).toEqual({ ok: true });
    expect(validateYDocStructure(validDoc())).toEqual({ ok: true });
    expect(validateYDocStructure(htmlToYDoc(RICH))).toEqual({ ok: true });
  });

  it('accepte un document avec commentaires', () => {
    const doc = htmlToYDoc(RICH);
    addComment(doc, { id: '6f1c2b1e-8a3d-4c55-9e0a-1b2c3d4e5f60', authorUserGroupId: 1, authorName: 'A', body: 'x', anchorText: 'cm', mentions: [] });
    expect(validateYDocStructure(doc)).toEqual({ ok: true });
  });

  it('refuse un Y.XmlText à la racine (mise à jour de 27 octets)', () => {
    const source = new Y.Doc();
    fragmentOf(source).insert(0, [new Y.XmlText('x')]);
    const update = Y.encodeStateAsUpdate(source);
    expect(update.byteLength).toBeLessThan(40);
    const doc = validDoc();
    Y.applyUpdate(doc, update);
    const res = validateYDocStructure(doc);
    expect(res.ok).toBe(false);
  });

  it('refuse un nœud inconnu, un hook et un texte hors contexte', () => {
    const unknown = validDoc();
    fragmentOf(unknown).insert(0, [el('script')]);
    expect(validateYDocStructure(unknown).ok).toBe(false);

    const hook = validDoc();
    fragmentOf(hook).insert(0, [new Y.XmlHook('x') as never]);
    expect(validateYDocStructure(hook).ok).toBe(false);

    const textInQuote = validDoc();
    const q = el('blockquote');
    fragmentOf(textInQuote).insert(0, [q]);
    q.insert(0, [new Y.XmlText('direct')]);
    expect(validateYDocStructure(textInQuote).ok).toBe(false);
  });

  it('refuse un contenu non conforme au schéma et un attribut dangereux', () => {
    const doc = new Y.Doc();
    fragmentOf(doc).insert(0, [el('listItem')]);
    expect(validateYDocStructure(doc).ok).toBe(false);

    const attr = new Y.Doc();
    const h = el('heading');
    fragmentOf(attr).insert(0, [h]);
    h.setAttribute('level', new Y.Map() as unknown as string);
    expect(validateYDocStructure(attr).ok).toBe(false);
  });

  it('refuse 3000 blockquote imbriqués et un document dépassant maxNodes', () => {
    const deep = new Y.Doc();
    addNestedQuotes(deep, 0, 3000);
    expect(validateYDocStructure(deep).ok).toBe(false);

    const wide = new Y.Doc();
    fragmentOf(wide).insert(
      0,
      Array.from({ length: 50 }, () => el('paragraph')),
    );
    expect(validateYDocStructure(wide).ok).toBe(true);
    expect(validateYDocStructure(wide, { maxNodes: 10 }).ok).toBe(false);
  });

  it('ne lève jamais, même avec 100000 niveaux', () => {
    const doc = new Y.Doc();
    addNestedQuotes(doc, 0, 100_000);
    let res: ReturnType<typeof validateYDocStructure> | undefined;
    expect(() => {
      res = validateYDocStructure(doc);
    }).not.toThrow();
    expect(res?.ok).toBe(false);
    // Même avec des bornes énormes : l'analyse reste itérative (pas de dépassement de pile).
    expect(() => validateYDocStructure(doc, { maxDepth: 1_000_000, maxNodes: 1_000_000 })).not.toThrow();
  });

  it('a un coût raisonnable sur un document de plusieurs centaines de Ko', () => {
    const html = Array.from({ length: 3000 }, (_, i) => `<p>Paragraphe ${i} <strong>gras</strong> et du texte</p>`).join('');
    const doc = htmlToYDoc(html);
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBeGreaterThan(50_000);
    const t0 = Date.now();
    expect(validateYDocStructure(doc)).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('conversions tolérantes sur état empoisonné', () => {
  const poisoned = (): Y.Doc => {
    const doc = validDoc();
    fragmentOf(doc).insert(0, [new Y.XmlText('x')]);
    fragmentOf(doc).insert(1, [el('inconnu')]);
    addNestedQuotes(doc, 2, 3000);
    const bad = el('blockquote');
    fragmentOf(doc).insert(3, [bad]);
    bad.insert(0, [new Y.XmlText('direct')]);
    return doc;
  };

  it('yDocToJson / Html / PlainText ne lèvent pas et gardent le contenu valide', () => {
    const doc = poisoned();
    expect(() => yDocToJson(doc)).not.toThrow();
    expect(JSON.stringify(yDocToJson(doc))).toContain('Valide');
    expect(yDocToHtml(doc)).toContain('Valide');
    expect(yDocToPlainText(doc)).toContain('Valide');
    expect(() => extractMentionIds(doc)).not.toThrow();
  });

  it('ne lèvent pas avec 100000 niveaux (profondeur tronquée à 64, contenu valide)', () => {
    const doc = new Y.Doc();
    addNestedQuotes(doc, 0, 100_000);
    expect(() => yDocToJson(doc)).not.toThrow();
    const html = yDocToHtml(doc);
    expect((html.match(/<blockquote>/g) ?? []).length).toBeLessThanOrEqual(64);
    expect(yDocToPlainText(doc)).toBe('');
    expect(() => extractMentionIds(doc)).not.toThrow();
  });

  it('ne modifie pas le Y.Doc', () => {
    const doc = poisoned();
    const before = Y.encodeStateAsUpdate(doc);
    yDocToJson(doc);
    yDocToPlainText(doc);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('sorties cohérentes sur un document valide', () => {
    const doc = htmlToYDoc(RICH);
    expect(yDocToJson(doc).type).toBe('doc');
    expect(yDocToPlainText(doc)).toContain('@Alice');
    expect(yDocToHtml(doc)).toContain('Alice');
  });

  it("exportDocx ne lève pas sur un état empoisonné ni sur un JSON profondément imbriqué", async () => {
    const buf = await exportDocx({ title: 'T', json: yDocToJson(poisoned()) });
    expect(buf.byteLength).toBeGreaterThan(100);

    const deepJson = (type: string, depth: number) => {
      let node: Record<string, unknown> = { type: 'paragraph', content: [{ type: 'text', text: 'fin' }] };
      for (let i = 0; i < depth; i++) node = { type, content: [node] };
      return { type: 'doc', content: [node] };
    };
    for (const type of ['blockquote', 'bulletList', 'unknown', 'span']) {
      const out = await exportDocx({ title: 'T', json: deepJson(type, 100_000) as never });
      expect(out.byteLength).toBeGreaterThan(100);
    }
  });

  it('performances raisonnables sur un état empoisonné large', () => {
    const doc = validDoc();
    fragmentOf(doc).insert(
      0,
      Array.from({ length: 20_000 }, () => el('inconnu')),
    );
    const t0 = Date.now();
    yDocToJson(doc);
    yDocToPlainText(doc);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
