/**
 * @archivage/editor/server — conversions node-only (import/export DOCX, assainissement, état Yjs).
 * CONTRAT posé par le chef de lot ; signatures stables.
 */
export * from './index';

/** Assainit du HTML (liste blanche stricte : pas de script, style, on*, javascript:, iframe…). */
export { sanitizeEditorHtml } from './sanitize';

/** DOCX (Buffer) -> HTML assaini. Rejette (Error) un fichier trop gros / non-zip / bombe de décompression. */
export { importDocxToHtml } from './docx-import';
export type { DocxImportResult } from './docx-import';

export {
  applyHtmlToYDoc,
  htmlToYDoc,
  yDocToJson,
  yDocToHtml,
  encodeState,
  decodeState,
} from './ydoc';

/**
 * Valide la structure d'un Y.Doc (ProseMirror) : non récursive, ne lève jamais.
 * À appeler sur toute mise à jour reçue d'un écrivain avant de la persister.
 */
export { validateYDocStructure } from './structure';

/** JSON Tiptap -> DOCX (bibliothèque `docx`). Titres, listes, gras/italique/souligné, liens, tableaux, citations, code. */
export { exportDocx } from './docx-export';
export type { ExportDocxInput } from './docx-export';
