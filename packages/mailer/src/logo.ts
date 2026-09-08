import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

/**
 * Logo embarqué dans l'e-mail en pièce jointe « inline » (CID), plutôt que référencé par une URL.
 *
 * C'est le seul moyen fiable d'afficher un logo déposé sur le serveur : une URL `http://localhost…`
 * n'est joignable ni depuis la boîte du destinataire, ni depuis le proxy d'images de Gmail/Outlook
 * (qui va chercher l'image côté serveur du fournisseur). Les octets voyagent donc DANS le message.
 */
export interface InlineLogo {
  content: Buffer;
  contentType: string;
  filename: string;
}

/** Extension → type MIME. Miroir des formats acceptés au dépôt côté API. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Lit le binaire du logo sous `brandingDir` pour l'embarquer. Renvoie `null` — jamais une erreur —
 * si aucun logo n'est paramétré ou si le fichier a disparu du disque : un logo manquant ne doit
 * jamais empêcher l'envoi, l'e-mail part alors sans image.
 */
export async function loadInlineLogo(
  brandingDir: string,
  fileName: string | null | undefined,
): Promise<InlineLogo | null> {
  const name = fileName?.trim();
  if (!name) return null;
  const ext = extname(name).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return null;
  try {
    const content = await readFile(join(brandingDir, name));
    return { content, contentType, filename: name };
  } catch {
    return null;
  }
}
