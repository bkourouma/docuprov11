import * as mammoth from 'mammoth';
import JSZip from 'jszip';
import { sanitizeEditorHtml } from './sanitize';

export interface DocxImportResult {
  /** HTML assaini, prêt pour `applyHtmlToYDoc`. */
  html: string;
  warnings: string[];
}

/** Taille maximale du fichier DOCX compressé. */
export const DOCX_MAX_BYTES = 10 * 1024 * 1024;
/** Taille décompressée totale maximale (protection contre les bombes de décompression). */
export const DOCX_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
/** Taille décompressée maximale de `word/document.xml` (le corps du document). */
export const DOCX_MAX_DOCUMENT_XML_BYTES = 10 * 1024 * 1024;
/** Nombre maximal d'entrées dans l'archive. */
export const DOCX_MAX_ENTRIES = 2000;

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Titre'] => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh",
  "p[style-name='Sous-titre'] => p:fresh",
  "p[style-name='Titre 1'] => h1:fresh",
  "p[style-name='Titre 2'] => h2:fresh",
  "p[style-name='Titre 3'] => h3:fresh",
  "p[style-name='Titre 4'] => h4:fresh",
  "p[style-name='Titre 5'] => h5:fresh",
  "p[style-name='Titre 6'] => h6:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Citation'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
  "p[style-name='Citation intense'] => blockquote:fresh",
  "p[style-name='Code'] => pre:fresh",
  "p[style-name='Source Code'] => pre:fresh",
  'u => u',
  'strike => s',
];

/** Mesure la taille réellement décompressée (sans se fier aux en-têtes) et borne le total. */
const inspectArchive = async (buffer: Buffer): Promise<{ hasMedia: boolean }> => {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("Fichier DOCX invalide : l'archive est illisible ou corrompue.");
  }
  const entries = Object.values(zip.files);
  if (entries.length > DOCX_MAX_ENTRIES) {
    throw new Error('Fichier DOCX refusé : archive contenant trop de fichiers.');
  }
  if (!zip.file('word/document.xml')) {
    throw new Error("Fichier DOCX invalide : le contenu du document est introuvable.");
  }

  let total = 0;
  let hasMedia = false;
  for (const entry of entries) {
    if (entry.dir) continue;
    if (entry.name.startsWith('word/media/')) hasMedia = true;
    const isBody = entry.name === 'word/document.xml';
    let entryBytes = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream();
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        entryBytes += chunk.length;
        if (
          total > DOCX_MAX_UNCOMPRESSED_BYTES ||
          (isBody && entryBytes > DOCX_MAX_DOCUMENT_XML_BYTES)
        ) {
          stream.pause();
          reject(
            new Error('Fichier DOCX refusé : contenu décompressé trop volumineux (archive suspecte).'),
          );
        }
      });
      stream.on('end', () => resolve());
      stream.on('error', () =>
        reject(new Error("Fichier DOCX invalide : l'archive est corrompue.")),
      );
    });
  }
  return { hasMedia };
};

const toFrenchWarning = (message: { type: string; message: string }): string => {
  if (/Unrecognised paragraph style/i.test(message.message)) {
    return 'Un style de paragraphe non reconnu a été converti en paragraphe simple.';
  }
  if (/Unrecognised run style/i.test(message.message)) {
    return 'Un style de texte non reconnu a été ignoré.';
  }
  return message.type === 'error'
    ? "Un élément du document n'a pas pu être converti."
    : 'Un élément non pris en charge a été ignoré lors de l’import.';
};

/** DOCX (Buffer) -> HTML assaini. Rejette (Error) un fichier trop gros / non-zip / bombe de décompression. */
export const importDocxToHtml = async (docx: Buffer): Promise<DocxImportResult> => {
  if (!Buffer.isBuffer(docx) || docx.length === 0) {
    throw new Error('Fichier DOCX vide ou invalide.');
  }
  if (docx.length > DOCX_MAX_BYTES) {
    throw new Error(
      `Fichier DOCX trop volumineux (maximum ${DOCX_MAX_BYTES / (1024 * 1024)} Mo).`,
    );
  }
  if (docx.length < 4 || !ZIP_SIGNATURE.every((b, i) => docx[i] === b)) {
    throw new Error("Fichier invalide : ce n'est pas un document DOCX (archive ZIP attendue).");
  }

  const { hasMedia } = await inspectArchive(docx);

  let result: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
  try {
    result = await mammoth.convertToHtml(
      { buffer: docx },
      {
        styleMap: STYLE_MAP,
        // Les images ne sont jamais importées (aucun nœud image dans le schéma).
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      },
    );
  } catch {
    throw new Error('Impossible de lire ce document DOCX : fichier invalide ou non pris en charge.');
  }

  const warnings = new Set<string>();
  for (const m of result.messages) warnings.add(toFrenchWarning(m));
  if (hasMedia) warnings.add('Les images du document ne sont pas importées.');

  return { html: sanitizeEditorHtml(result.value), warnings: Array.from(warnings) };
};
