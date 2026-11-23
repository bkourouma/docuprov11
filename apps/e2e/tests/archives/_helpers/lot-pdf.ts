/**
 * Fabrication des fichiers de test de l'acquisition, et lecture des fichiers produits.
 *
 * Aucun binaire versionné : chaque test fabrique son lot.
 *  - Les feuilles d'intercalaires viennent de l'API (`POST /intercalaires/generate`), c'est-à-dire
 *    des MÊMES octets que ceux que l'écran « Intercalaires » ouvre à l'impression : le QR lu par le
 *    worker est bien celui que l'application imprime, pas une copie refaite dans le test.
 *  - Les pages de contenu sont dessinées avec pdf-lib, avec une VRAIE couche texte : le worker lit
 *    ce texte sans OCR (cf. `shouldOcr` de `@archivage/ocr`), ce qui rend la recherche plein texte
 *    déterministe et garde les tests hermétiques (Tesseract sans données locales télécharge ses
 *    modèles de langue sur Internet).
 *
 * Dépendance : `pdf-lib` (déjà dans le lockfile via `@archivage/pdf` et le worker, et remonté à la
 * racine par `node-linker=hoisted`). Le lot 0 doit la déclarer en devDependency de `apps/e2e`.
 */
import { inflateRawSync, inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ApiClient } from '../../../fixtures';

export const MIME_PDF = 'application/pdf';

const A4: [number, number] = [595.28, 841.89];

/** Fichier tel que Playwright le transmet (`setInputFiles`, multipart). */
export interface FichierTest {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export type CategorieIntercalaire = 'TYPE_DOCUMENT' | 'PLAN' | 'LOCALISATION' | 'DOSSIER' | 'BLANK';

/**
 * Feuilles d'intercalaires générées par l'API, une page par élément, dans l'ordre de `itemIds`
 * (une seule page pour `BLANK`). Lève avec le statut et le corps si l'API refuse.
 */
export async function genererIntercalaires(
  api: ApiClient,
  category: CategorieIntercalaire,
  itemIds: number[] = [],
): Promise<Buffer> {
  const res = await api.raw.post('/intercalaires/generate', { category, itemIds });
  if (res.status() !== 200) {
    throw new Error(
      `Génération des intercalaires refusée (HTTP ${res.status()}) : ${await res.text()}`,
    );
  }
  return Buffer.from(await res.body());
}

/** Un élément du flux numérisé : une feuille d'intercalaire, ou une page de contenu. */
export type ElementLot =
  /** Page `page` (0 par défaut) d'un PDF d'intercalaires renvoyé par `genererIntercalaires`. */
  | { feuille: Uint8Array; page?: number }
  /** Page de contenu portant ce texte (couche texte réelle, au moins 12 caractères visibles). */
  | { contenu: string };

/** Seuil de `shouldOcr` (`packages/ocr`) : en dessous, le worker lancerait l'OCR. */
const MIN_CARACTERES_SANS_OCR = 12;

function verifierTexte(texte: string): void {
  if (texte.replace(/\s+/g, '').length < MIN_CARACTERES_SANS_OCR) {
    throw new Error(
      `Page de contenu trop courte (« ${texte} ») : sous ${MIN_CARACTERES_SANS_OCR} caractères, ` +
        'le worker lancerait l’OCR (lent, et réseau si les données Tesseract ne sont pas locales).',
    );
  }
  if (/[^\x20-\xFF\n]/.test(texte)) {
    throw new Error(`Texte hors WinAnsi, non encodable par la police standard : « ${texte} »`);
  }
}

function dessinerTexte(page: PDFPage, font: PDFFont, texte: string): void {
  const taille = 14;
  const largeurMax = A4[0] - 120;
  const lignes: string[] = [];
  for (const paragraphe of texte.split('\n')) {
    let courante = '';
    for (const mot of paragraphe.split(/\s+/).filter(Boolean)) {
      const essai = courante ? `${courante} ${mot}` : mot;
      if (courante && font.widthOfTextAtSize(essai, taille) > largeurMax) {
        lignes.push(courante);
        courante = mot;
      } else {
        courante = essai;
      }
    }
    lignes.push(courante);
  }
  lignes.forEach((ligne, i) => {
    page.drawText(ligne, {
      x: 60,
      y: A4[1] - 100 - i * 22,
      size: taille,
      font,
      color: rgb(0, 0, 0),
    });
  });
}

/**
 * Assemble UN PDF de lot dans l'ordre donné — c'est la sortie d'un scanner qui a numérisé la
 * liasse d'un seul tenant (intercalaires compris).
 */
export async function fabriquerLot(elements: ElementLot[]): Promise<Buffer> {
  const lot = await PDFDocument.create();
  const font = await lot.embedFont(StandardFonts.Helvetica);
  const sources = new Map<Uint8Array, PDFDocument>();
  for (const el of elements) {
    if ('feuille' in el) {
      let src = sources.get(el.feuille);
      if (!src) {
        src = await PDFDocument.load(el.feuille);
        sources.set(el.feuille, src);
      }
      const index = el.page ?? 0;
      if (index >= src.getPageCount()) {
        throw new Error(`Feuille d'intercalaire ${index} absente (${src.getPageCount()} page(s))`);
      }
      const [copie] = await lot.copyPages(src, [index]);
      lot.addPage(copie);
    } else {
      verifierTexte(el.contenu);
      dessinerTexte(lot.addPage(A4), font, el.contenu);
    }
  }
  return Buffer.from(await lot.save());
}

/** PDF de pages de contenu seulement (aucun QR). */
export function pdfDeContenu(textes: string[]): Promise<Buffer> {
  return fabriquerLot(textes.map((contenu) => ({ contenu })));
}

/** Nom de fichier accepté tel quel par l'API (elle remplace tout le reste par « _ »). */
export function nomDeFichier(base: string, extension = '.pdf'): string {
  return `${base.replace(/[^A-Za-z0-9._-]/g, '_')}${extension}`;
}

export function fichierPdf(base: string, buffer: Buffer): FichierTest {
  return { name: nomDeFichier(base), mimeType: MIME_PDF, buffer };
}

/** Fichier nommé et typé PDF, mais dont le contenu n'est pas un PDF (pas d'en-tête `%PDF-`). */
export function fichierPdfIllisible(base: string): FichierTest {
  return {
    name: nomDeFichier(base),
    mimeType: MIME_PDF,
    buffer: Buffer.from('Ceci n est pas un PDF : contenu texte deguise en PDF.', 'latin1'),
  };
}

/** Fichier texte (non PDF). */
export function fichierTexte(base: string): FichierTest {
  return {
    name: nomDeFichier(base, '.txt'),
    mimeType: 'text/plain',
    buffer: Buffer.from('Simple fichier texte, pas un PDF.', 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// Lecture des fichiers produits (PDF, Office)
// ---------------------------------------------------------------------------

export function estUnPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

/** Archive ZIP (xlsx, docx) : signature `PK\x03\x04`. */
export function estUnZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function nombreDePages(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

/** Contenu des flux d'un PDF, décompressés quand ils sont en FlateDecode. */
function fluxPdf(bytes: Buffer): string[] {
  const latin = bytes.toString('latin1');
  const out: string[] = [];
  let depuis = 0;
  for (;;) {
    const debut = latin.indexOf('stream', depuis);
    if (debut === -1) break;
    if (latin.slice(debut - 3, debut) === 'end') {
      depuis = debut + 6;
      continue;
    }
    let start = debut + 6;
    if (latin[start] === '\r') start += 1;
    if (latin[start] === '\n') start += 1;
    const fin = latin.indexOf('endstream', start);
    if (fin === -1) break;
    let stop = fin;
    while (stop > start && (latin[stop - 1] === '\n' || latin[stop - 1] === '\r')) stop -= 1;
    const brut = bytes.subarray(start, stop);
    try {
      out.push(inflateSync(brut).toString('latin1'));
    } catch {
      out.push(brut.toString('latin1'));
    }
    depuis = fin + 9;
  }
  return out;
}

/**
 * Le PDF dessine-t-il ce texte ? Vaut pour les PDF de pdf-lib (feuilles d'intercalaires) : le texte
 * y est écrit d'un seul tenant, en chaîne hexadécimale WinAnsi. Ne convient pas aux PDF qui
 * découpent le texte pour le crénage (PDFKit) : pour ceux-là, ne contrôler que la structure.
 */
export function pdfContientTexte(bytes: Uint8Array, texte: string): boolean {
  const buffer = Buffer.from(bytes);
  const hex = Buffer.from(texte, 'latin1').toString('hex').toUpperCase();
  const litteral = `(${texte.replace(/([\\()])/g, '\\$1')})`;
  return fluxPdf(buffer).some((f) => f.toUpperCase().includes(hex) || f.includes(litteral));
}

/** Entrées d'une archive ZIP (xlsx, docx), décompressées. Pas de ZIP64 (fichiers de test). */
export function lireZip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Archive ZIP invalide : fin du répertoire central introuvable');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entrees = new Map<string, Buffer>();
  for (let n = 0; n < total; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Répertoire central ZIP corrompu');
    const methode = buf.readUInt16LE(p + 10);
    const tailleCompressee = buf.readUInt32LE(p + 20);
    const longueurNom = buf.readUInt16LE(p + 28);
    const longueurExtra = buf.readUInt16LE(p + 30);
    const longueurCommentaire = buf.readUInt16LE(p + 32);
    const enTeteLocal = buf.readUInt32LE(p + 42);
    const nom = buf.subarray(p + 46, p + 46 + longueurNom).toString('utf8');
    const debut =
      enTeteLocal + 30 + buf.readUInt16LE(enTeteLocal + 26) + buf.readUInt16LE(enTeteLocal + 28);
    const donnees = buf.subarray(debut, debut + tailleCompressee);
    if (methode === 0) entrees.set(nom, Buffer.from(donnees));
    else if (methode === 8) entrees.set(nom, inflateRawSync(donnees));
    else throw new Error(`Méthode de compression ZIP non gérée (${methode}) pour ${nom}`);
    p += 46 + longueurNom + longueurExtra + longueurCommentaire;
  }
  return entrees;
}

/**
 * Texte visible des parties XML d'un fichier Office (balises retirées sans séparateur, pour qu'un
 * libellé découpé en plusieurs « runs » Word se lise d'un seul tenant ; entités de base décodées).
 */
export function texteOffice(bytes: Uint8Array): string {
  return [...lireZip(bytes).entries()]
    .filter(([nom]) => nom.endsWith('.xml'))
    .map(([, contenu]) =>
      contenu
        .toString('utf8')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&'),
    )
    .join('\n');
}
