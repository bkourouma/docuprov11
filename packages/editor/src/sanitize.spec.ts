import { sanitizeEditorHtml } from './server';

const clean = sanitizeEditorHtml;

describe('sanitizeEditorHtml - balises dangereuses', () => {
  it('supprime script ET son contenu', () => {
    const out = clean('<p>avant</p><script>alert(1)</script><p>après</p>');
    expect(out).toBe('<p>avant</p><p>après</p>');
    expect(out).not.toMatch(/alert|script/i);
  });

  it('supprime style ET son contenu', () => {
    const out = clean('<style>body{background:url(javascript:alert(1))}</style><p>ok</p>');
    expect(out).toBe('<p>ok</p>');
  });

  it.each([
    ['iframe', '<iframe src="https://evil.example"></iframe><p>x</p>'],
    ['iframe avec contenu', '<iframe src="x">TEXTE-CACHE</iframe><p>x</p>'],
    ['object', '<object data="x.swf"><param name="a" value="b"></object><p>x</p>'],
    ['embed', '<embed src="x.swf"><p>x</p>'],
    ['form', '<form action="https://evil.example"><input name="a"><button>go</button></form><p>x</p>'],
    ['svg', '<svg onload="alert(1)"><script>alert(2)</script><circle r="1"/></svg><p>x</p>'],
    ['math', '<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math><p>x</p>'],
    ['base', '<base href="https://evil.example"><p>x</p>'],
    ['link', '<link rel="stylesheet" href="https://evil.example/a.css"><p>x</p>'],
    ['meta', '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>x</p>'],
  ])('neutralise <%s>', (_nom, html) => {
    const out = clean(html);
    expect(out).toContain('<p>x</p>');
    expect(out).not.toMatch(/<(iframe|object|embed|form|input|button|svg|math|base|link|meta|param|script|style)/i);
    expect(out).not.toMatch(/TEXTE-CACHE|alert|evil\.example/);
  });

  it('supprime toute image, y compris data:', () => {
    const out = clean(
      '<p>a</p><img src="https://x.example/a.png"><img src="data:image/png;base64,AAAA"><img src=x onerror=alert(1)>',
    );
    expect(out).toBe('<p>a</p>');
  });

  it('supprime audio, video, source, canvas', () => {
    const out = clean('<video src="a.mp4" onerror="x()"></video><audio src="a.mp3"></audio><canvas></canvas><p>z</p>');
    expect(out).toBe('<p>z</p>');
  });
});

describe('sanitizeEditorHtml - attributs', () => {
  it('retire tous les attributs on*', () => {
    const out = clean('<p onclick="alert(1)" onmouseover="alert(2)" ONLOAD="x">t</p><a href="https://a.example" onfocus="x()">l</a>');
    expect(out).not.toMatch(/on[a-z]+=/i);
    expect(out).toContain('<p>t</p>');
  });

  it('retire style, id, class (hors mention), data-* inconnus et tout attribut non listé', () => {
    const out = clean('<p style="position:fixed" id="x" class="evil" data-x="1" title="t" contenteditable>t</p>');
    expect(out).toBe('<p>t</p>');
  });

  it('retire les attributs style des cellules de tableau', () => {
    const out = clean('<table><tr><td style="background:url(x)" width="9">c</td></tr></table>');
    expect(out).not.toMatch(/style|width/);
    expect(out).toContain('<td>c</td>');
  });
});

describe('sanitizeEditorHtml - liens', () => {
  it('conserve http, https et mailto avec rel noopener noreferrer, sans target', () => {
    const out = clean(
      '<a href="https://a.example/p?q=1" target="_blank">1</a><a href="http://b.example">2</a><a href="mailto:x@y.example">3</a>',
    );
    expect(out).toContain('<a rel="noopener noreferrer" href="https://a.example/p?q=1">1</a>');
    expect(out).toContain('href="http://b.example"');
    expect(out).toContain('href="mailto:x@y.example"');
    expect(out).not.toMatch(/target/);
  });

  it('écrase un rel malveillant ou absent', () => {
    const out = clean('<a href="https://a.example" rel="opener">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('rel="opener"');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '&#106;avascript:alert(1)',
    'jav&#x61;script:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example/x',
  ])('retire le href dangereux %j mais garde le texte', (href) => {
    const out = clean(`<a href="${href}">cliquez</a>`);
    expect(out).toContain('cliquez');
    expect(out).not.toMatch(/href/i);
    expect(out).not.toMatch(/javascript|vbscript|data:|file:|evil/i);
  });
});

describe('sanitizeEditorHtml - structure conservée', () => {
  it('conserve la liste blanche de mise en forme', () => {
    const html =
      '<h1>T</h1><h6>t6</h6><p>a<br />b <strong>g</strong><em>i</em><u>u</u><s>s</s><code>c</code></p>' +
      '<ul><li>x<ol><li>y</li></ol></li></ul><blockquote><p>q</p></blockquote><pre><code>code</code></pre>';
    expect(clean(html)).toBe(html);
  });

  it('conserve les tableaux et borne colspan/rowspan', () => {
    const out = clean(
      '<table><thead><tr><th colspan="2">H</th></tr></thead><tbody><tr><td colspan="9999" rowspan="3">A</td><td colspan="-1" rowspan="abc">B</td></tr></tbody></table>',
    );
    expect(out).toContain('<th colspan="2">H</th>');
    expect(out).toContain('colspan="50"');
    expect(out).toContain('rowspan="3"');
    expect(out).not.toMatch(/9999|-1|abc/);
  });

  it('conserve les ancres de commentaire valides et rejette les ids douteux', () => {
    const ok = clean('<p><span data-comment-id="3f2b8c10-aaaa-bbbb-cccc-123456789012">t</span></p>');
    expect(ok).toContain('data-comment-id="3f2b8c10-aaaa-bbbb-cccc-123456789012"');
    const ko = clean('<p><span data-comment-id="&quot; onmouseover=&quot;x">t</span></p>');
    expect(ko).not.toMatch(/data-comment-id|onmouseover/);
    expect(ko).toContain('t');
  });

  it('conserve une mention bien formée et rejette une mention douteuse', () => {
    const ok = clean('<p><span data-type="mention" data-id="12" data-label="Alice" class="mention" style="x">@Alice</span></p>');
    expect(ok).toBe('<p><span data-type="mention" data-id="12" data-label="Alice" class="mention">@Alice</span></p>');
    const ko = clean('<p><span data-type="mention" data-id="1 OR 1=1" data-label="x">@x</span></p>');
    expect(ko).not.toMatch(/data-type|data-id/);
    const autre = clean('<p><span data-type="script" data-id="1">y</span></p>');
    expect(autre).not.toMatch(/data-type/);
  });
});

describe('sanitizeEditorHtml - balises imbriquées / malformées / obfuscation', () => {
  it('neutralise les balises mal fermées et les contournements classiques', () => {
    const attaques = [
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
      '<img src="x"onerror="alert(1)">',
      '<img/src=x/onerror=alert(1)>',
      '<a href="javascript:alert(1)"><img src=x onerror=alert(2)></a>',
      '<p <script>alert(1)</script>>t</p>',
      '<<script>alert(1)//<</script>',
      '<div><p>ouvert<script>alert(1)',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<svg><p><style><img src="</style><img src=x onerror=alert(1)>">',
      '<details open ontoggle=alert(1)>',
      '<body onload=alert(1)>',
      '<math href="javascript:alert(1)">x</math>',
      '<a href="https://ok.example" onclick="alert(1)" style="x">l</a>',
    ];
    for (const a of attaques) {
      const out = clean(a);
      expect(out).not.toMatch(/<\s*(script|img|svg|style|iframe|body|details|math|noscript)/i);
      expect(out).not.toMatch(/\son[a-z]+\s*=/i);
      expect(out).not.toMatch(/javascript:/i);
      // Un reste de texte (« alert(1) » échappé) est inerte : aucune balise ni attribut exécutable ne subsiste.
      expect(out).not.toMatch(/<[^>]*alert/i);
    }
  });

  it('est idempotent', () => {
    const entree =
      '<p onclick="x">a <a href="javascript:x">l</a> <strong>g</strong></p><script>1</script><table><tr><td colspan="2">c</td></tr></table>';
    const une = clean(entree);
    expect(clean(une)).toBe(une);
  });

  it('reste inerte : le texte HTML littéral est échappé, jamais interprété', () => {
    const out = clean('<p>&lt;script&gt;alert(1)&lt;/script&gt; et &lt;img src=x onerror=alert(1)&gt;</p>');
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; et &lt;img src=x onerror=alert(1)&gt;</p>');
    expect(out).not.toMatch(/<script|<img/i);
  });

  it('conserve le texte inerte des balises inconnues retirées', () => {
    expect(clean('<div><section><font color="red">visible</font></section></div>')).toBe('visible');
  });

  it('gère les entrées vides ou non textuelles', () => {
    expect(clean('')).toBe('');
    expect(clean('   ')).toBe('');
    expect(clean(undefined as unknown as string)).toBe('');
  });
});
