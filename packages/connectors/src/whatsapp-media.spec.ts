import { createHash } from 'node:crypto';
import { GED_CONNECTOR_ALLOWED_EXTENSIONS } from '@archivage/types';
import { ConnectorItemRejectedError } from './types';
import {
  WHATSAPP_MAX_FILENAME_CHARS,
  WHATSAPP_OFFICIAL_HOST_SUFFIXES,
  assertOfficialMediaUrl,
  isOfficialWhatsappHost,
  sanitizeWhatsappFileName,
  validateWhatsappMedia,
} from './whatsapp-media';

function rejected(fn: () => unknown): ConnectorItemRejectedError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
    return e as ConnectorItemRejectedError;
  }
  throw new Error('aucune erreur levée');
}

describe('assertOfficialMediaUrl', () => {
  it.each([
    'https://graph.facebook.com/v21.0/123',
    'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123&ext=1&hash=abc',
    'https://scontent.xx.fbcdn.net/v/t61/abc.jpg?oh=1&oe=2',
    'https://mmg.whatsapp.net/d/f/abc.enc',
    'https://media.whatsapp.com/x',
    'https://cdn.fbsbx.com/x',
    'https://www.facebook.com/x',
    'https://LOOKASIDE.FBSBX.COM/x',
    'https://lookaside.fbsbx.com./x',
    'https://lookaside.fbsbx.com:443/x',
  ])('accepte %s', (raw) => {
    const url = assertOfficialMediaUrl(raw);
    expect(url.protocol).toBe('https:');
    expect(url.port).toBe('');
    expect(url.hostname).toBe(url.hostname.toLowerCase());
    expect(url.hostname.endsWith('.')).toBe(false);
  });

  it('retire le fragment et garde chemin et requête', () => {
    const url = assertOfficialMediaUrl('https://lookaside.fbsbx.com/a/b?mid=1&hash=z#frag');
    expect(url.toString()).toBe('https://lookaside.fbsbx.com/a/b?mid=1&hash=z');
  });

  it.each([
    ['http', 'http://lookaside.fbsbx.com/x'],
    ['ftp', 'ftp://lookaside.fbsbx.com/x'],
    ['file', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['port', 'https://lookaside.fbsbx.com:8443/x'],
    ['port 80', 'https://lookaside.fbsbx.com:80/x'],
    ['identifiants', 'https://user:pass@lookaside.fbsbx.com/x'],
    ['identifiant seul', 'https://user@lookaside.fbsbx.com/x'],
    ['IPv4', 'https://127.0.0.1/x'],
    ['IPv4 décimale', 'https://2130706433/x'],
    ['IPv4 hexadécimale', 'https://0x7f.1/x'],
    ['IPv4 octale', 'https://0177.0.0.1/x'],
    ['IPv6', 'https://[::1]/x'],
    ['métadonnées cloud', 'https://169.254.169.254/latest/meta-data/'],
    ['suffixe collé', 'https://evilfbcdn.net/x'],
    ['suffixe officiel en préfixe', 'https://fbcdn.net.evil.com/x'],
    ['hôte officiel en préfixe', 'https://lookaside.fbsbx.com.evil.com/x'],
    ['apex non listé', 'https://fbcdn.net/x'],
    ['domaine voisin', 'https://graph.facebook.co/x'],
    ['accents', 'https://lookaside.fbsbx.cöm/x'],
    ['sous-domaine accentué', 'https://évil.fbcdn.net/x'],
    ['punycode', 'https://xn--vil-9la.fbcdn.net/x'],
    ['hôte vide', 'https:///x'],
    ['vide', ''],
    ['https seul', 'https://'],
    ['espace', 'https://lookaside.fbsbx.com/a b'],
    ['antislash', 'https://evil.com\\@lookaside.fbsbx.com/x'],
    ['nom court', 'https://localhost/x'],
    ['tiret de tête', 'https://-x.fbcdn.net/x'],
    ['soulignement', 'https://a_b.fbcdn.net/x'],
    ['trop long', `https://lookaside.fbsbx.com/${'a'.repeat(5000)}`],
  ])('refuse (%s)', (_label, raw) => {
    const e = rejected(() => assertOfficialMediaUrl(raw));
    // Message générique : jamais l'URL ni l'hôte.
    if (raw.length > 12) expect(e.message).not.toContain(raw);
    expect(e.message).not.toMatch(/evil|127\.0|fbcdn\.net\/|user|pass/);
  });

  it('refuse une entrée non chaîne', () => {
    rejected(() => assertOfficialMediaUrl(undefined as unknown as string));
  });

  it('la liste officielle est figée', () => {
    expect(Object.isFrozen(WHATSAPP_OFFICIAL_HOST_SUFFIXES)).toBe(true);
    expect(() => (WHATSAPP_OFFICIAL_HOST_SUFFIXES as string[]).push('*.evil.com')).toThrow();
  });

  it('isOfficialWhatsappHost exige une frontière de label', () => {
    expect(isOfficialWhatsappHost('a.fbcdn.net')).toBe(true);
    expect(isOfficialWhatsappHost('fbcdn.net')).toBe(false);
    expect(isOfficialWhatsappHost('afbcdn.net')).toBe(false);
    expect(isOfficialWhatsappHost('graph.facebook.com')).toBe(true);
    expect(isOfficialWhatsappHost('lookaside.fbsbx.com')).toBe(true);
  });
});

describe('sanitizeWhatsappFileName', () => {
  const now = new Date(Date.UTC(2026, 10, 20, 9, 5, 7));
  const doc = { messageType: 'document' as const, now };

  it('garde un nom ordinaire', () => {
    expect(sanitizeWhatsappFileName('Facture 2026.pdf', { ...doc, mimeType: 'application/pdf' })).toBe(
      'Facture 2026.pdf',
    );
  });

  it('retire les chemins', () => {
    const out = sanitizeWhatsappFileName('../../etc/passwd', doc);
    expect(out).toBe('passwd');
    expect(out).not.toMatch(/[\\/]|\.\./);
    expect(sanitizeWhatsappFileName('..\\..\\Windows\\win.ini', doc)).toBe('win.ini');
    expect(sanitizeWhatsappFileName('../../etc/passwd', { ...doc, mimeType: 'application/pdf' })).toBe(
      'passwd.pdf',
    );
  });

  it('neutralise les extensions intermédiaires', () => {
    expect(sanitizeWhatsappFileName('a.exe.pdf', doc)).toBe('a_exe.pdf');
    expect(sanitizeWhatsappFileName('rapport.final.v2.DOCX', doc)).toBe('rapport_final_v2.docx');
  });

  it('retire les caractères bidi (RLO) et de contrôle', () => {
    const out = sanitizeWhatsappFileName('facture‮fdp.exe', doc);
    expect(out).toBe('facturefdp.exe');
    for (const c of ['‪', '‫', '‬', '‭', '⁦', '⁧', '⁨', '⁩', '‎', '‏']) {
      expect(sanitizeWhatsappFileName(`a${c}b.pdf`, doc)).toBe('ab.pdf');
    }
    expect(sanitizeWhatsappFileName('a\u0000b\nc\u007f.pdf', doc)).toBe('abc.pdf');
  });

  it('retire les caractères interdits par Windows', () => {
    expect(sanitizeWhatsappFileName('a:b*c?d"e<f>g|h.pdf', doc)).toBe('abcdefgh.pdf');
  });

  it('retire points et espaces de tête et de queue', () => {
    expect(sanitizeWhatsappFileName('  ..note.pdf.. ', doc)).toBe('note.pdf');
    expect(sanitizeWhatsappFileName('rapport .pdf', doc)).toBe('rapport.pdf');
  });

  it('préfixe les noms réservés Windows', () => {
    expect(sanitizeWhatsappFileName('CON.pdf', doc)).toBe('_CON.pdf');
    expect(sanitizeWhatsappFileName('nul.txt', doc)).toBe('_nul.txt');
    expect(sanitizeWhatsappFileName('COM1.docx', doc)).toBe('_COM1.docx');
    expect(sanitizeWhatsappFileName('LPT9', doc)).toBe('_LPT9');
    expect(sanitizeWhatsappFileName('CONSOLE.pdf', doc)).toBe('CONSOLE.pdf');
  });

  it('normalise en NFC', () => {
    const decomposed = 'Résumé.pdf';
    expect(sanitizeWhatsappFileName(decomposed, doc)).toBe('Résumé.pdf');
  });

  it('borne à 120 caractères en gardant l’extension', () => {
    const out = sanitizeWhatsappFileName(`${'é'.repeat(300)}.pdf`, doc);
    expect(Array.from(out).length).toBe(WHATSAPP_MAX_FILENAME_CHARS);
    expect(out.endsWith('.pdf')).toBe(true);
    // Pas de demi-paire de substitution après coupe.
    const emoji = sanitizeWhatsappFileName(`${'😀'.repeat(200)}.pdf`, doc);
    expect(emoji.endsWith('.pdf')).toBe(true);
    expect(emoji).toBe(emoji.normalize('NFC'));
    expect(/\p{Cs}/u.test(emoji)).toBe(false);
  });

  it('génère un nom pour une photo sans nom (UTC)', () => {
    expect(sanitizeWhatsappFileName(undefined, { messageType: 'image', mimeType: 'image/jpeg', now })).toBe(
      'photo-20261120-090507.jpg',
    );
    expect(sanitizeWhatsappFileName('', { messageType: 'image', mimeType: 'image/png', now })).toBe(
      'photo-20261120-090507.png',
    );
  });

  it('génère un nom pour un document inexploitable', () => {
    expect(sanitizeWhatsappFileName('...', { ...doc, mimeType: 'application/pdf' })).toBe(
      'document-20261120-090507.pdf',
    );
    expect(sanitizeWhatsappFileName('‮\u0000', { ...doc, mimeType: 'application/pdf; charset=x' })).toBe(
      'document-20261120-090507.pdf',
    );
    expect(sanitizeWhatsappFileName('/', doc)).toBe('document-20261120-090507');
    expect(sanitizeWhatsappFileName('.pdf', { ...doc, mimeType: 'application/pdf' })).toBe('pdf.pdf');
  });

  it('déduit l’extension du type MIME si le nom n’en a pas', () => {
    expect(
      sanitizeWhatsappFileName('contrat', {
        ...doc,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe('contrat.docx');
    expect(sanitizeWhatsappFileName('contrat', { ...doc, mimeType: 'application/x-unknown' })).toBe('contrat');
  });
});

describe('validateWhatsappMedia', () => {
  const allowed = [...GED_CONNECTOR_ALLOWED_EXTENSIONS];
  const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'latin1');
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);
  const TIFF = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(8, 3)]);
  const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16, 4)]);
  const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(16, 5)]);
  const RTF = Buffer.from('{\\rtf1\\ansi bonjour}', 'latin1');
  const TXT = Buffer.from('bonjour\nmonde\n', 'utf8');
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

  const base = { maxBytes: 1024 * 1024, allowedExtensions: allowed };

  it('accepte un PDF cohérent et renvoie l’empreinte calculée', () => {
    const out = validateWhatsappMedia({ ...base, bytes: PDF, fileName: 'a.pdf', mimeType: 'application/pdf' });
    expect(out).toEqual({ fileName: 'a.pdf', extension: '.pdf', mimeType: 'application/pdf', sha256: sha(PDF) });
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['b.png', 'image/png', PNG],
    ['c.jpg', 'image/jpeg', JPG],
    ['c.jpeg', 'image/jpeg', JPG],
    ['d.tif', 'image/tiff', TIFF],
    ['e.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
    ['f.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
    ['g.odt', 'application/vnd.oasis.opendocument.text', ZIP],
    ['h.doc', 'application/msword', OLE],
    ['i.xls', 'application/vnd.ms-excel', OLE],
    ['j.msg', 'application/vnd.ms-outlook', OLE],
    ['k.rtf', 'application/rtf', RTF],
    ['l.txt', 'text/plain', TXT],
    ['m.csv', 'text/csv', TXT],
    ['m2.csv', 'application/vnd.ms-excel', TXT],
    ['n.md', 'text/markdown', TXT],
    ['o.eml', 'message/rfc822', TXT],
    ['p.html', 'text/html; charset=utf-8', TXT],
  ])('accepte %s (%s)', (fileName, mimeType, bytes) => {
    const out = validateWhatsappMedia({ ...base, bytes, fileName, mimeType });
    expect(out.sha256).toBe(sha(bytes));
  });

  it('tolère application/octet-stream si la signature concorde, et renvoie le type canonique', () => {
    const out = validateWhatsappMedia({ ...base, bytes: PDF, fileName: 'a.pdf', mimeType: 'application/octet-stream' });
    expect(out.mimeType).toBe('application/pdf');
    expect(validateWhatsappMedia({ ...base, bytes: ZIP, fileName: 'a.docx' }).mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('refuse application/octet-stream pour un format sans signature (texte)', () => {
    rejected(() => validateWhatsappMedia({ ...base, bytes: TXT, fileName: 'a.txt', mimeType: 'application/octet-stream' }));
    rejected(() => validateWhatsappMedia({ ...base, bytes: TXT, fileName: 'a.html' }));
  });

  it('refuse application/octet-stream si la signature ne concorde pas', () => {
    rejected(() => validateWhatsappMedia({ ...base, bytes: TXT, fileName: 'a.pdf', mimeType: 'application/octet-stream' }));
  });

  it('refuse un fichier vide ou trop volumineux', () => {
    expect(rejected(() => validateWhatsappMedia({ ...base, bytes: Buffer.alloc(0), fileName: 'a.pdf' })).message).toMatch(
      /vide/,
    );
    expect(
      rejected(() => validateWhatsappMedia({ ...base, maxBytes: 10, bytes: PDF, fileName: 'a.pdf', mimeType: 'application/pdf' }))
        .message,
    ).toMatch(/volumineux/);
  });

  it.each([
    ['virus.exe', 'application/x-msdownload', Buffer.from('MZ\x90\x00', 'latin1')],
    ['image.svg', 'image/svg+xml', Buffer.from('<svg/>')],
    ['script.js', 'text/javascript', Buffer.from('alert(1)')],
    ['sans-extension', 'application/pdf', PDF],
    ['archive.zip', 'application/zip', ZIP],
  ])('refuse le type %s', (fileName, mimeType, bytes) => {
    const e = rejected(() => validateWhatsappMedia({ ...base, bytes, fileName, mimeType }));
    expect(e.message).not.toContain(fileName);
  });

  it('refuse .html si la configuration ne l’autorise pas', () => {
    rejected(() =>
      validateWhatsappMedia({ ...base, allowedExtensions: ['.pdf'], bytes: TXT, fileName: 'a.html', mimeType: 'text/html' }),
    );
  });

  it('la configuration ne peut pas élargir la liste globale', () => {
    rejected(() =>
      validateWhatsappMedia({
        ...base,
        allowedExtensions: ['.svg', '.exe'],
        bytes: Buffer.from('<svg/>'),
        fileName: 'a.svg',
        mimeType: 'image/svg+xml',
      }),
    );
  });

  it.each([
    ['a.pdf', 'image/png', PDF],
    ['a.png', 'application/pdf', PNG],
    ['a.docx', 'application/msword', ZIP],
    ['a.txt', 'text/html', TXT],
    ['a.pdf', 'pas un type', PDF],
  ])('refuse l’incohérence type/extension (%s / %s)', (fileName, mimeType, bytes) => {
    expect(rejected(() => validateWhatsappMedia({ ...base, bytes, fileName, mimeType })).message).toMatch(/incohérent/);
  });

  it.each([
    ['a.pdf', 'application/pdf', PNG],
    ['a.png', 'image/png', JPG],
    ['a.jpg', 'image/jpeg', PDF],
    ['a.tif', 'image/tiff', PDF],
    ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', OLE],
    ['a.doc', 'application/msword', ZIP],
    ['a.rtf', 'application/rtf', TXT],
    ['a.txt', 'text/plain', Buffer.from('MZ\x00\x00binaire', 'latin1')],
    ['a.csv', 'text/csv', Buffer.from([0x61, 0x00, 0x62])],
  ])('refuse une signature binaire fausse (%s)', (fileName, mimeType, bytes) => {
    expect(rejected(() => validateWhatsappMedia({ ...base, bytes, fileName, mimeType })).message).toMatch(/Contenu/);
  });

  it('vérifie l’empreinte annoncée (hex, insensible à la casse, ou base64)', () => {
    const hex = sha(PDF);
    const ok = { ...base, bytes: PDF, fileName: 'a.pdf', mimeType: 'application/pdf' };
    expect(validateWhatsappMedia({ ...ok, declaredSha256: hex.toUpperCase() }).sha256).toBe(hex);
    expect(validateWhatsappMedia({ ...ok, declaredSha256: Buffer.from(hex, 'hex').toString('base64') }).sha256).toBe(hex);
  });

  it('refuse une empreinte annoncée différente', () => {
    const e = rejected(() =>
      validateWhatsappMedia({
        ...base,
        bytes: PDF,
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
        declaredSha256: sha(Buffer.from('autre')),
      }),
    );
    expect(e.message).toMatch(/Empreinte inattendue/);
  });

  it('refuse une empreinte annoncée illisible', () => {
    rejected(() =>
      validateWhatsappMedia({ ...base, bytes: PDF, fileName: 'a.pdf', mimeType: 'application/pdf', declaredSha256: 'zzz' }),
    );
  });

  it('refuse un nom non assaini', () => {
    rejected(() => validateWhatsappMedia({ ...base, bytes: PDF, fileName: '../a.pdf', mimeType: 'application/pdf' }));
    rejected(() => validateWhatsappMedia({ ...base, bytes: PDF, fileName: 'a‮.pdf', mimeType: 'application/pdf' }));
  });

  it('chaîne complète : nom piégé assaini puis refusé par la validation', () => {
    const fileName = sanitizeWhatsappFileName('facture‮fdp.exe', {
      messageType: 'document',
      mimeType: 'application/pdf',
      now: new Date(0),
    });
    rejected(() => validateWhatsappMedia({ ...base, bytes: PDF, fileName, mimeType: 'application/pdf' }));
    const neutralised = sanitizeWhatsappFileName('a.exe.pdf', { messageType: 'document', now: new Date(0) });
    expect(validateWhatsappMedia({ ...base, bytes: PDF, fileName: neutralised, mimeType: 'application/pdf' }).extension).toBe(
      '.pdf',
    );
  });
});
