import type { APIResponse } from '@playwright/test';

/**
 * Fichiers de test générés en mémoire (aucun binaire versionné). Forme Playwright
 * `{ name, mimeType, buffer }`, acceptée telle quelle par `api.upload(...)` et `setInputFiles(...)`.
 */
export interface FichierTest {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** PNG 1 × 1 px valide (68 octets) — décodable par le navigateur, donc affichable en aperçu. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Poids maximal d'un logo d'e-mail côté API (`MAX_LOGO_BYTES`, 1 Mo). */
export const LOGO_MAX_BYTES = 1024 * 1024;

export const tinyPng = (name = 'logo.png'): FichierTest => ({
  name,
  mimeType: 'image/png',
  buffer: PNG_1PX,
});

/** PNG d'un octet au-dessus de la limite : l'en-tête est valide, seul le poids est fautif. */
export const oversizedPng = (name = 'logo-lourd.png'): FichierTest => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.concat([PNG_1PX, Buffer.alloc(LOGO_MAX_BYTES + 1 - PNG_1PX.length)]),
});

/** SVG minimal — format refusé sciemment par l'API (script possible, servi publiquement). */
export const svgFile = (name = 'logo.svg'): FichierTest => ({
  name,
  mimeType: 'image/svg+xml',
  buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
});

/**
 * Dépôt multipart SANS lever sur un statut d'erreur, pour les tests de refus.
 *
 * Isolé ici : le contrat des fixtures garantit `api.raw.<verbe>` mais ne nomme pas explicitement
 * `raw.upload`. Si la phase B l'expose autrement, seule cette fonction est à adapter.
 */
export interface RawUploader {
  raw: {
    upload(
      path: string,
      opts: { field: string; file: FichierTest; fields?: Record<string, string> },
    ): Promise<APIResponse>;
  };
}

export function uploadRaw(
  client: RawUploader,
  path: string,
  file: FichierTest,
  field = 'file',
): Promise<APIResponse> {
  return client.raw.upload(path, { field, file });
}
