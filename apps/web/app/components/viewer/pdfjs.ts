'use client';

import type * as PdfJs from 'pdfjs-dist';

/**
 * Chargement paresseux de pdf.js.
 *
 * pdf.js touche au DOM et à `Worker` dès l'import : on ne l'importe donc jamais au
 * niveau module (le rendu serveur de Next planterait), mais à la première ouverture
 * d'un document. Le module est mis en cache par le bundler, l'attente n'est payée
 * qu'une fois par session.
 *
 * Le worker est référencé via `new URL(..., import.meta.url)` : webpack l'émet comme
 * asset et sert le fichier depuis `/_next/static`, sans dépendre d'un CDN (contrainte
 * 100 % OSS auto-hébergé du projet).
 */
let pdfjsPromise: Promise<typeof PdfJs> | null = null;

/**
 * Ressources runtime servies depuis `public/pdfjs/` (voir `scripts/copy-pdfjs-assets.mjs`).
 * Sans `standardFontDataUrl`, un PDF qui référence les 14 polices standard (Helvetica,
 * Times…) sans les embarquer — le cas de tous nos PDF générés — n'est jamais peint : le
 * rendu attend indéfiniment des fichiers de police introuvables.
 */
export const PDFJS_ASSETS = {
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
} as const;

export function loadPdfJs(): Promise<typeof PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
    return lib;
  });
  return pdfjsPromise;
}
