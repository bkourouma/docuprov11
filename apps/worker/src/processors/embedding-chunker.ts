// Lot 3 — segmentation du texte d'un document en segments d'environ GED_CHUNK_TARGET_CHARS caractères
// avec chevauchement, prêts à être vectorisés. Module PUR : aucune entrée/sortie, déterministe.
import { createHash } from 'node:crypto';
import { GED_CHUNK_OVERLAP_CHARS, GED_CHUNK_TARGET_CHARS } from '@archivage/types';

/** Une page de texte ; `page` vaut `null` quand le numéro de page n'est pas connu. */
export interface ChunkInputPage {
  page: number | null;
  text: string;
}

export interface TextChunk {
  chunkIndex: number;
  content: string;
  /** SHA-256 hexadécimal minuscule de `content` (CHECK `^[0-9a-f]{64}$`). */
  contentHash: string;
  /** Estimation grossière : ~ 1 jeton pour 4 caractères. */
  tokenCount: number;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface ChunkOptions {
  targetChars?: number;
  overlapChars?: number;
}

/** Part minimale de la cible qu'un segment doit atteindre avant qu'on accepte une coupe propre. */
const MIN_FILL_RATIO = 0.5;

const WS = /\s/;
const SENTENCE_END = /[.!?…;:]/;

/**
 * Normalise un bloc de texte : retire les caractères de contrôle (dont NUL, que PostgreSQL refuse),
 * condense les blancs, conserve les ruptures de paragraphe (`\n\n`) et replie les retours à la
 * ligne simples en espaces.
 */
export function normalizeChunkText(raw: string): string {
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/[^\S\n]+/g, ' ');
  return cleaned
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim())
    .filter((p) => p.length > 0)
    .join('\n\n');
}

interface PageSpan {
  page: number | null;
  start: number;
  end: number;
}

/** Plus grande coupe propre `c` dans `[lo, hi]` (c = fin exclusive du segment), ou -1. */
function findCut(text: string, from: number, lo: number, hi: number): number {
  // 1) fin de paragraphe
  const para = text.lastIndexOf('\n\n', hi);
  if (para >= lo && para > from) return para;
  // 2) fin de phrase : ponctuation suivie d'un blanc
  for (let c = hi; c >= lo && c > from; c--) {
    if (c < text.length && WS.test(text[c]!) && SENTENCE_END.test(text[c - 1]!)) return c;
  }
  // 3) fin de mot : n'importe quel blanc, même sous le seuil de remplissage
  for (let c = hi; c > from; c--) {
    if (c < text.length && WS.test(text[c]!) && !WS.test(text[c - 1]!)) return c;
  }
  return -1;
}

/**
 * Découpe en segments. Les pages vides sont ignorées. Garanties : chaque itération avance
 * strictement (terminaison), aucun segment vide, coupe au milieu d'un mot uniquement pour un mot
 * plus long que la cible.
 */
export function chunkText(pages: readonly ChunkInputPage[], opts: ChunkOptions = {}): TextChunk[] {
  const target =
    Number.isInteger(opts.targetChars) && (opts.targetChars as number) > 0
      ? (opts.targetChars as number)
      : GED_CHUNK_TARGET_CHARS;
  const rawOverlap =
    Number.isInteger(opts.overlapChars) && (opts.overlapChars as number) >= 0
      ? (opts.overlapChars as number)
      : GED_CHUNK_OVERLAP_CHARS;
  // Un chevauchement >= taille ne ferait jamais avancer la fenêtre : on le borne.
  const overlap = Math.min(rawOverlap, target - 1);

  // Texte global (pages normalisées séparées par un paragraphe) + empreinte de chaque page.
  let text = '';
  const spans: PageSpan[] = [];
  for (const p of pages) {
    const norm = normalizeChunkText(p.text ?? '');
    if (norm === '') continue;
    if (text !== '') text += '\n\n';
    spans.push({ page: p.page, start: text.length, end: text.length + norm.length });
    text += norm;
  }

  const chunks: TextChunk[] = [];
  const len = text.length;
  let start = 0;
  while (start < len) {
    while (start < len && WS.test(text[start]!)) start++;
    if (start >= len) break;

    let end = Math.min(start + target, len);
    if (end < len) {
      const lo = start + Math.floor(target * MIN_FILL_RATIO);
      const cut = findCut(text, start, lo, end);
      // Aucune coupe propre : mot géant (> cible) => coupe franche à la cible.
      if (cut > start) end = cut;
    }

    const content = text.slice(start, end).trim();
    if (content !== '') {
      chunks.push(makeChunk(chunks.length, content, start, end, spans));
    }
    if (end >= len) break;

    // Début du segment suivant : recul de `overlap`, mais toujours au moins la moitié du segment
    // courant (progression garantie), recalé sur un début de mot.
    let next = Math.max(end - overlap, start + Math.ceil((end - start) / 2));
    if (next > start && next < end && !WS.test(text[next - 1]!) && !WS.test(text[next]!)) {
      let j = next;
      while (j < end && !WS.test(text[j]!)) j++;
      // Mot géant sans blanc avant `end` : on garde la coupe franche.
      if (j < end) next = j;
    }
    start = Math.max(next, start + 1);
  }
  return chunks;
}

function makeChunk(
  chunkIndex: number,
  content: string,
  start: number,
  end: number,
  spans: readonly PageSpan[],
): TextChunk {
  const covered = spans.filter((s) => s.start < end && s.end > start);
  let pageFrom: number | null = null;
  let pageTo: number | null = null;
  if (covered.length > 0 && covered.every((s) => s.page !== null)) {
    const nums = covered.map((s) => s.page as number);
    pageFrom = Math.min(...nums);
    pageTo = Math.max(...nums);
  }
  return {
    chunkIndex,
    content,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    tokenCount: Math.ceil(content.length / 4),
    pageFrom,
    pageTo,
  };
}

/** Fichier d'une version tel que lu pour l'indexation. */
export interface ChunkSourceFile {
  ocrText: string | null;
  pageCount: number | null;
}

/** Séparateur de page reconnu dans un texte agrégé (saut de page ASCII). */
export const PAGE_SEPARATOR = '\f';

/**
 * Attribue des numéros de page aux textes des fichiers d'une version (ordre `sort_order`).
 *
 * `ocr_text` est agrégé SANS séparateur de page à l'ingestion (pages jointes par `\n`) : le numéro
 * n'est donc connu que dans deux cas sûrs — le texte contient des sauts de page `\f` dont le nombre de
 * blocs égale `page_count` (ou `page_count` est inconnu pour un fichier unique), ou le fichier ne
 * compte qu'une page. Sinon `page = null` (jamais de page devinée). Le décalage de pages se
 * poursuit d'un fichier à l'autre tant que chaque `page_count` est connu.
 */
export function pagesFromFiles(files: readonly ChunkSourceFile[]): ChunkInputPage[] {
  const out: ChunkInputPage[] = [];
  let offset: number | null = 0; // numéro de la dernière page déjà attribuée ; null = inconnu
  for (const f of files) {
    const text = f.ocrText ?? '';
    const count = f.pageCount !== null && f.pageCount > 0 ? f.pageCount : null;
    const parts = text.split(PAGE_SEPARATOR);
    if (parts.length > 1 && offset !== null && (count === null || parts.length === count)) {
      parts.forEach((t, i) => out.push({ page: (offset as number) + i + 1, text: t }));
      offset = count === null ? null : offset + count;
    } else if (parts.length === 1 && count === 1 && offset !== null) {
      out.push({ page: offset + 1, text });
      offset += 1;
    } else {
      // Pages inconnues pour ce fichier (texte agrégé sans séparateur, ou décompte incohérent).
      for (const t of parts) out.push({ page: null, text: t });
      offset = offset !== null && count !== null ? offset + count : null;
    }
  }
  return out;
}
