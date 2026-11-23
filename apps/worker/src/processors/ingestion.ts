import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { CONSULTATION_LEVEL, type DocuProGrant } from '@archivage/connectors';
import {
  buildDocumentPdf,
  extractPageText,
  loadPdfForRender,
  type PdfDocument,
} from '@archivage/pdf';
import type { DiskFileStore } from '@archivage/storage';
import { prisma } from '../db';
import type { DocumentPlan } from './segment';
import { pageKey } from './page-source';
import { grantConsultation } from './grant-permission';
import { sealFreshDocument } from './seal-document';
import { safeEmitDocumentDeposited } from './workflow-deadlines.events';

/**
 * Empreinte de référence du binaire, posée DÈS l'ingestion (2026-09-15).
 *
 * Avant, aucun chemin de création ne renseignait `hash` : un document fraîchement numérisé arrivait
 * sans référence, et l'onglet « Sécurité et conformité » ne pouvait que la POSER au premier
 * contrôle — c'est-à-dire figer comme faisant foi un état déjà vieux de plusieurs semaines. La
 * protection ne commençait donc que le jour où quelqu'un pensait à cliquer. Mesurée ici, elle
 * couvre le document à partir de la seconde où il entre au coffre.
 *
 * Calculée sur les octets RÉELLEMENT écrits sur le coffre (le PDF assemblé), jamais sur les
 * fichiers d'entrée : c'est le binaire archivé que la vérification relira.
 */
function empreinte(bytes: Uint8Array): { hash: string; hashComputedAt: Date } {
  return { hash: createHash('sha256').update(bytes).digest('hex'), hashComputedAt: new Date() };
}

async function resolveFileTypeWith(
  db: Pick<PrismaClient, 'fileType'>,
  extension: string,
): Promise<{ fileTypeId: number }> {
  return db.fileType.upsert({
    where: { extension },
    update: {},
    create: { extension, friendlyName: extension.replace('.', '').toUpperCase() || 'FILE' },
    select: { fileTypeId: true },
  });
}

async function resolveFileType(extension: string): Promise<{ fileTypeId: number }> {
  return prisma.fileType.upsert({
    where: { extension },
    update: {},
    create: { extension, friendlyName: extension.replace('.', '').toUpperCase() || 'FILE' },
    select: { fileTypeId: true },
  });
}

// ---------------------------------------------------------------------------
// Mode « avec intercalaires » (QR + OCR) — découpe le lot en PLUSIEURS documents
// ---------------------------------------------------------------------------

/** `untyped` porte sur le type RÉSOLU (intercalaire, puis repli du lot) — pas sur le seul QR. */
function buildLabel(seq: number, batchId: number, untyped: boolean): string {
  return untyped
    ? `Lot ${batchId} – document ${seq} (sans type)`
    : `Lot ${batchId} – document ${seq}`;
}

export interface PersistOptions {
  plan: DocumentPlan;
  seq: number;
  batchId: number;
  createdBy: number | null;
  sources: PDFDocument[];
  pageText: Map<string, string>;
  fileStore: DiskFileStore;
  /** Racine du coffre — le cachet y trouve la clé de l'installation (`<racine>/.keys/…`). */
  archivesPath: string;
  /**
   * Classement résolu par l'appelant : type du lot en repli du type lu sur l'intercalaire, et plan
   * du paramétrage de ce type. Passé cuit plutôt que recalculé ici pour n'interroger la base
   * qu'une fois par lot, et non une fois par document.
   */
  documentTypeId: number | null;
  planId: number | null;
  /** Confidentialité par défaut du type retenu (`document_type_setting.confidentialite_id`). */
  confidentialiteId: number | null;
}

/**
 * Crée le document + sa version courante (+ fichier sur disque s'il a des pages de contenu),
 * puis accorde la Consultation au groupe créateur (FR-017, FR-018, FR-029).
 */
export async function persistDocument(opts: PersistOptions): Promise<void> {
  const { plan, seq, batchId, createdBy, sources, pageText, fileStore } = opts;

  const document = await prisma.document.create({
    data: {
      label: buildLabel(seq, batchId, opts.documentTypeId == null),
      documentTypeId: opts.documentTypeId,
      planId: opts.planId,
      confidentialiteId: opts.confidentialiteId,
      locationId: plan.locationId,
      dossierId: plan.dossierId,
      batchId,
      isArchived: false,
      createdBy,
      versions: { create: { versionNumber: 1, isCurrent: true, createdBy } },
    },
    include: { versions: true },
  });

  if (plan.pages.length > 0) {
    const versionId = document.versions[0]!.documentVersionId;
    const bytes = await buildDocumentPdf(sources, plan.pages);
    const fileType = await resolveFileType('.pdf');
    const ocrText = plan.pages
      .map((p) => pageText.get(pageKey(p.fileIndex, p.pageIndex)) ?? '')
      .join('\n')
      .trim();

    const file = await prisma.documentFile.create({
      data: {
        documentVersionId: versionId,
        fileTypeId: fileType.fileTypeId,
        originalName: `${buildLabel(seq, batchId, opts.documentTypeId == null)}.pdf`,
        fileExtension: '.pdf',
        byteLength: BigInt(bytes.length),
        pageCount: plan.pages.length,
        ocrText: ocrText.length > 0 ? ocrText : null,
        sortOrder: 0,
        ...empreinte(bytes),
      },
    });
    await fileStore.write(file.fileId, '.pdf', Buffer.from(bytes));
    // Scellé APRÈS l'écriture sur le coffre : le cachet atteste un binaire réellement présent.
    // L'inverse signerait un fichier qui n'existe pas encore, et qu'un incident d'écriture
    // pourrait ne jamais faire exister.
    await sealFreshDocument(document.documentId, opts.archivesPath);
  }

  if (createdBy != null) {
    await grantConsultation(document.documentId, createdBy);
  }
  // Docu-Flow W3 : document entièrement créé (version, fichier, cachet, droit), hors transaction ; ne lève jamais.
  safeEmitDocumentDeposited(document, { source: 'acquisition', pageCount: plan.pages.length });
}

// ---------------------------------------------------------------------------
// Mode « sans intercalaire » (normal) — TOUS les fichiers fusionnés en UN document
// ---------------------------------------------------------------------------

/**
 * Fusionne plusieurs PDF en un seul (toutes les pages, dans l'ordre des fichiers).
 *
 * Un fichier illisible est ignoré (meilleur effort, comportement historique). Mais si AUCUNE page
 * n'a pu être lue, la fusion échoue (ANO-ARC-T1-02) : produire quand même un document à zéro page,
 * marqué « traité », laissait l'opérateur valider et archiver une coquille vide, sans aucun signal
 * d'erreur. L'échec fait passer le lot à l'état « échoué » (statut 2), que l'écran signale.
 */
export async function mergePdfBytes(
  files: { bytes: Uint8Array }[],
  onMerged?: (filesDone: number) => void | Promise<void>,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const merged = await PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    try {
      const src = await PDFDocument.load(files[i]!.bytes);
      const copied = await merged.copyPages(src, src.getPageIndices());
      copied.forEach((p) => merged.addPage(p));
    } catch {
      /* fichier illisible : ignoré (best-effort) */
    }
    if (onMerged) await onMerged(i + 1);
  }
  if (merged.getPageCount() === 0) {
    throw new Error(
      `Aucune page lisible dans les ${files.length} fichier(s) du lot : aucun document créé.`,
    );
  }
  const out = await merged.save();
  return { bytes: out, pageCount: merged.getPageCount() };
}

export interface PersistMergedOptions {
  files: { bytes: Uint8Array; originalName: string }[];
  batchId: number;
  createdBy: number | null;
  dossierId: number | null;
  /** Classement du lot, résolu par l'appelant depuis le type choisi à l'ouverture. */
  documentTypeId: number | null;
  planId: number | null;
  /** Confidentialité par défaut du type retenu (`document_type_setting.confidentialite_id`). */
  confidentialiteId: number | null;
  fileStore: DiskFileStore;
  /** Racine du coffre — le cachet y trouve la clé de l'installation (`<racine>/.keys/…`). */
  archivesPath: string;
  onFileMerged?: (filesDone: number) => void | Promise<void>;
}

/**
 * Crée UN SEUL document à partir de TOUS les PDF du lot (fusionnés), sans OCR. Le classement du
 * lot (dossier, type, plan) est repris tel quel : depuis que le type se choisit AVANT le
 * téléversement, seules les métadonnées restent à saisir à l'indexation. La Consultation est
 * accordée au groupe créateur (FR-029).
 */
export async function persistMergedDocument(opts: PersistMergedOptions): Promise<void> {
  const {
    files,
    batchId,
    createdBy,
    dossierId,
    documentTypeId,
    planId,
    confidentialiteId,
    fileStore,
    onFileMerged,
  } = opts;
  const { bytes, pageCount } = await mergePdfBytes(files, onFileMerged);

  const firstBase = files[0]?.originalName.replace(/\.pdf$/i, '').trim();
  const label = firstBase && firstBase.length > 0 ? firstBase : `Lot ${batchId} – document`;

  const document = await prisma.document.create({
    data: {
      label,
      dossierId,
      documentTypeId,
      planId,
      confidentialiteId,
      batchId,
      isArchived: false,
      createdBy,
      versions: { create: { versionNumber: 1, isCurrent: true, createdBy } },
    },
    include: { versions: true },
  });

  const versionId = document.versions[0]!.documentVersionId;
  const fileType = await resolveFileType('.pdf');
  const file = await prisma.documentFile.create({
    data: {
      documentVersionId: versionId,
      fileTypeId: fileType.fileTypeId,
      originalName:
        files.length === 1
          ? files[0]!.originalName
          : `Lot ${batchId} (${files.length} fichiers).pdf`,
      fileExtension: '.pdf',
      byteLength: BigInt(bytes.length),
      pageCount,
      ocrText: null,
      sortOrder: 0,
      ...empreinte(bytes),
    },
  });
  await fileStore.write(file.fileId, '.pdf', Buffer.from(bytes));
  await sealFreshDocument(document.documentId, opts.archivesPath);

  if (createdBy != null) {
    await grantConsultation(document.documentId, createdBy);
  }
  // Docu-Flow W3 : document entièrement créé (version, fichier, cachet, droit), hors transaction ; ne lève jamais.
  safeEmitDocumentDeposited(document, { source: 'fusion', pageCount });
}

// ---------------------------------------------------------------------------
// Lot 2a : fichiers entrants d'une SOURCE EXTERNE (connecteurs GED)
// ---------------------------------------------------------------------------

/** Dépendances injectables des ingestions de source (tests : Prisma et coffre simulés). */
export interface ExternalIngestDeps {
  /** Défaut : le client Prisma du worker. */
  prisma?: Pick<PrismaClient, 'fileType' | 'document' | 'documentVersion' | '$transaction'>;
  fileStore: Pick<DiskFileStore, 'write'>;
  /** Racine du coffre — le cachet y trouve la clé de l'installation. */
  archivesPath: string;
  /** Défaut : `sealFreshDocument`. Le scellement n'est jamais bloquant (cf. seal-document.ts). */
  seal?: (documentId: number, archivesPath: string) => Promise<void>;
  now?: () => Date;
}

export interface ExternalFileInput {
  bytes: Buffer;
  /** Nom du fichier d'origine : donne `originalName`, l'extension réelle et le libellé. */
  name: string;
  dossierId: number | null;
  /** Texte déjà extrait ; absent = extraction locale (texte brut, HTML, PDF). */
  ocrText?: string | null;
  /**
   * Élément de source à rattacher au document créé (`ged_source_item.documentId`), dans la MÊME
   * écriture que le document. Sans cela, un arrêt du worker entre la création du document et la mise
   * à jour de l'élément laisserait un document orphelin, et le rejeu en créerait un second.
   */
  sourceItemId?: bigint;
}

export interface ExternalIngestResult {
  documentId: number;
  documentVersionId: number;
  fileId: number;
}

function baseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/**
 * Extension réelle du fichier, en minuscules, point inclus. `.bin` si absente ou démesurée : la
 * colonne `file_extension` est un varchar(16) et une extension vide casserait le nom sur disque.
 */
export function realExtension(name: string): string {
  const ext = extname(baseName(name)).toLowerCase();
  return ext.length > 0 && ext.length <= 16 ? ext : '.bin';
}

/** Plafond du texte extrait d'un PDF : au-delà, la colonne `ocr_text` ne sert plus à la recherche. */
const MAX_EXTRACTED_CHARS = 2_000_000;

/** Postgres refuse le caractère NUL dans un `text` : un fichier binaire déguisé ferait échouer l'insertion. */
function cleanText(text: string): string | null {
  const cleaned = text.split(String.fromCharCode(0)).join('').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Borne d'entrée du nettoyage HTML : au-delà, le reste est ignoré. Un document HTML utile tient
 * très en deçà ; le plafond évite qu'un fichier hostile n'occupe le worker.
 */
export const HTML_MAX_INPUT_CHARS = 2 * 1024 * 1024;

/** Lettre ASCII ou chiffre : prolonge un nom de balise (`<scripts>` n'est pas `<script>`). */
function isNameChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isLetter(code: number): boolean {
  const lower = code | 0x20;
  return lower >= 97 && lower <= 122;
}

/** `html` contient `word` (minuscules ASCII) à `at`, sans tenir compte de la casse. Aucun retour arrière. */
function matchesCI(html: string, at: number, word: string): boolean {
  if (at + word.length > html.length) return false;
  for (let k = 0; k < word.length; k++) {
    if ((html.charCodeAt(at + k) | 0x20) !== word.charCodeAt(k)) return false;
  }
  return true;
}

/** Balise `script` / `style` ouvrant en `at` (juste après `<`), ou `null`. */
function rawTextTag(html: string, at: number): 'script' | 'style' | null {
  for (const name of ['script', 'style'] as const) {
    if (matchesCI(html, at, name) && !isNameChar(html.charCodeAt(at + name.length) || 0)) {
      return name;
    }
  }
  return null;
}

/**
 * HTML → texte, en UN SEUL balayage de gauche à droite (texte / balise / script-style). Les
 * expressions rationnelles précédentes (`<(script|style)[\s\S]*?</\1>` et `<[^>]+>`) étaient
 * quadratiques : 80 000 répétitions bloquaient le worker 26 s. Ici chaque caractère est lu au plus
 * une fois : dès qu'une recherche de `>` échoue il n'y en a plus jusqu'à la fin (drapeau
 * `noMoreGt`), et un script jamais refermé consomme le reste du texte d'un coup.
 */
function htmlToText(rawHtml: string): string {
  const html =
    rawHtml.length > HTML_MAX_INPUT_CHARS ? rawHtml.slice(0, HTML_MAX_INPUT_CHARS) : rawHtml;
  const out: string[] = [];
  let textStart = 0;
  let i = 0;
  let noMoreGt = false;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html.charCodeAt(lt + 1);
    // Ouvre une balise : lettre, `/`, `!` ou `?`. Un `<` isolé (« a < b ») reste du texte.
    if (!(isLetter(next) || next === 47 || next === 33 || next === 63)) {
      i = lt + 1;
      continue;
    }
    const raw = rawTextTag(html, lt + 1);
    let last: number; // dernier caractère consommé par la balise ou le bloc script/style
    if (raw !== null) {
      let close = -1;
      for (let j = html.indexOf('</', lt + 1); j !== -1; j = html.indexOf('</', j + 2)) {
        if (matchesCI(html, j + 2, raw) && !isNameChar(html.charCodeAt(j + 2 + raw.length) || 0)) {
          close = j;
          break;
        }
      }
      const gt = close === -1 ? -1 : html.indexOf('>', close);
      if (gt === -1) {
        // Jamais refermé : tout le reste est du script/style, donc retiré.
        out.push(html.slice(textStart, lt), ' ');
        textStart = html.length;
        break;
      }
      last = gt;
    } else {
      if (noMoreGt) {
        i = lt + 1;
        continue;
      }
      const gt = html.indexOf('>', lt + 1);
      if (gt === -1) {
        noMoreGt = true;
        i = lt + 1;
        continue;
      }
      last = gt;
    }
    out.push(html.slice(textStart, lt), ' ');
    textStart = last + 1;
    i = last + 1;
  }
  out.push(html.slice(textStart));
  return out
    .join('')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
}

/** Extensions dont le texte s'extrait sans dépendance supplémentaire. */
export const TEXT_EXTRACTABLE_EXTENSIONS: readonly string[] = [
  '.txt',
  '.csv',
  '.md',
  '.html',
  '.htm',
  '.pdf',
];

/**
 * Plafond de pages lues pour l'extraction du texte d'un PDF. LIMITE CONNUE (à relever en
 * configuration si un besoin réel apparaît) : au-delà, le texte n'est pas extrait (`null`) mais
 * le nombre de pages reste renseigné ; le fichier est archivé normalement.
 */
export const PDF_TEXT_MAX_PAGES = 500;

/**
 * Délai maximal (ms) de l'extraction du texte d'un PDF, et séparément du comptage de ses pages.
 * LIMITE CONNUE (à relever en configuration si besoin) : un PDF piégé ne doit pas immobiliser le
 * worker ; au dépassement, texte `null` / nombre de pages `null`, l'ingestion se poursuit.
 */
export const PDF_PARSE_TIMEOUT_MS = 30_000;

/** Document PDF tel que l'extraction le manipule (sous-ensemble de pdfjs). */
export interface PdfTextDocument {
  numPages: number;
  destroy?: () => Promise<void> | void;
}

/** Dépendances de l'analyse PDF, injectables (tests : PDF simulé, aucune vraie lecture). */
export interface PdfParseDeps {
  load: (bytes: Uint8Array) => Promise<PdfTextDocument>;
  extractPage: (doc: PdfTextDocument, pageNumber: number) => Promise<string>;
  countPages: (bytes: Uint8Array) => Promise<number>;
  maxPages: number;
  timeoutMs: number;
  /** Journal SANS contenu : jamais de texte ni de nom de fichier, seulement la nature de l'incident. */
  warn: (msg: string) => void;
}

const defaultPdfDeps: PdfParseDeps = {
  load: (bytes) => loadPdfForRender(bytes) as unknown as Promise<PdfTextDocument>,
  extractPage: (doc, page) => extractPageText(doc as unknown as PdfDocument, page),
  countPages: async (bytes) => {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return doc.getPageCount();
  },
  maxPages: PDF_TEXT_MAX_PAGES,
  timeoutMs: PDF_PARSE_TIMEOUT_MS,
  warn: (msg) => {
    // Chargé à la demande : le journal pino n'est nécessaire que dans ce cas rare.
    void import('../logger').then(({ logger }) => logger.warn(msg));
  },
};

const TIMED_OUT = Symbol('pdf-timeout');

/** Course contre une minuterie, TOUJOURS nettoyée (sinon elle retiendrait le processus). */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function extractPdfText(bytes: Uint8Array, deps: PdfParseDeps): Promise<string | null> {
  let doc: PdfTextDocument | null = null;
  let abandoned = false;
  let destroyed = false;
  // Idempotent : appelé par le travail lui-même ET par le délai (un chargement bloqué n'arrive
  // jamais à sa propre fin). pdfjs libère ainsi sa mémoire et son worker quoi qu'il arrive.
  const destroy = async (): Promise<void> => {
    if (doc === null || destroyed) return;
    destroyed = true;
    try {
      await doc.destroy?.();
    } catch {
      // Libération au mieux : elle ne doit jamais masquer le résultat.
    }
  };
  const work = (async (): Promise<string | null> => {
    try {
      // Copie : pdfjs refuse un `Buffer` Node et peut détacher le tampon qu'on lui confie, alors
      // que l'appelant doit encore écrire ces octets sur le coffre.
      const loaded = await deps.load(new Uint8Array(bytes));
      doc = loaded;
      if (abandoned) return null;
      if (loaded.numPages > deps.maxPages) return null;
      const parts: string[] = [];
      let total = 0;
      for (let page = 1; page <= loaded.numPages && total < MAX_EXTRACTED_CHARS; page++) {
        // Le délai a expiré : on cesse de parcourir, personne n'attend plus ce résultat.
        if (abandoned) return null;
        const text = await deps.extractPage(loaded, page);
        parts.push(text);
        total += text.length;
      }
      return cleanText(parts.join('\n').slice(0, MAX_EXTRACTED_CHARS));
    } finally {
      await destroy();
    }
  })();
  try {
    const res = await withTimeout(work, deps.timeoutMs);
    if (res === TIMED_OUT) {
      abandoned = true;
      deps.warn('extraction du texte PDF abandonnée : délai dépassé');
      return null;
    }
    return res;
  } finally {
    abandoned = true;
    await destroy();
  }
}

/**
 * Texte d'un fichier entrant, ou `null` : texte brut (.txt/.csv/.md), HTML (balises retirées) et
 * couche texte des PDF. Les scans (image, PDF sans couche texte) ne passent pas par ici : leur OCR
 * relève de l'acquisition. Meilleur effort — une extraction qui échoue ne bloque jamais l'ingestion.
 */
export async function extractTextFromBytes(
  bytes: Uint8Array,
  extension: string,
  pdfDeps: Partial<PdfParseDeps> = {},
): Promise<string | null> {
  try {
    const ext = extension.toLowerCase();
    if (ext === '.txt' || ext === '.csv' || ext === '.md') {
      const raw = Buffer.from(bytes).toString('utf8');
      // Marque d'ordre des octets (BOM) en tête : retirée, elle polluerait le premier mot indexé.
      return cleanText(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    }
    if (ext === '.html' || ext === '.htm') {
      return cleanText(htmlToText(Buffer.from(bytes).toString('utf8')));
    }
    if (ext === '.pdf') {
      return await extractPdfText(bytes, { ...defaultPdfDeps, ...pdfDeps });
    }
    return null;
  } catch {
    return null;
  }
}

/** Nombre de pages d'un PDF, ou `null` (illisible, ou délai dépassé : journal sans contenu). */
export async function countPdfPages(
  bytes: Uint8Array,
  pdfDeps: Partial<PdfParseDeps> = {},
): Promise<number | null> {
  const deps = { ...defaultPdfDeps, ...pdfDeps };
  try {
    const res = await withTimeout(deps.countPages(bytes), deps.timeoutMs);
    if (res === TIMED_OUT) {
      deps.warn('comptage des pages PDF abandonné : délai dépassé');
      return null;
    }
    return res;
  } catch {
    return null;
  }
}

function labelFromName(name: string): string {
  const base = baseName(name)
    .replace(/\.[^.]{1,15}$/, '')
    .trim();
  return (base.length > 0 ? base : 'Document importé').slice(0, 500);
}

async function buildFileData(input: ExternalFileInput, now: Date) {
  const extension = realExtension(input.name);
  const ocr =
    input.ocrText !== undefined
      ? input.ocrText
      : await extractTextFromBytes(input.bytes, extension);
  return {
    extension,
    data: {
      originalName: baseName(input.name).slice(0, 500),
      fileExtension: extension,
      byteLength: BigInt(input.bytes.length),
      pageCount: extension === '.pdf' ? await countPdfPages(input.bytes) : null,
      ocrText: ocr != null ? cleanText(ocr) : null,
      sortOrder: 0,
      hash: createHash('sha256').update(input.bytes).digest('hex'),
      hashComputedAt: now,
    },
  };
}

/** Défense en profondeur : jamais de document de source sans droit explicite, jamais au-delà de la Consultation. */
function assertSafeGrants(grants: DocuProGrant[]): void {
  if (!Array.isArray(grants) || grants.length === 0) {
    throw new Error(
      'Aucun droit applicable : document non créé (un document sans droit serait visible par tous)',
    );
  }
  for (const g of grants) {
    if (g.permissionLevelId !== CONSULTATION_LEVEL) {
      throw new Error(
        'Droit refusé : seule la Consultation peut être posée sur un document de source',
      );
    }
  }
}

/**
 * Point d'entrée commun des fichiers venant d'une source (copie / synchro) : Document + version
 * courante + fichier (octets sur le coffre, empreinte SHA-256), scellement, puis droits.
 *
 * Les droits sont posés DANS LA MÊME écriture que le document (création imbriquée, donc atomique) :
 * dans DocuPro un document sans permission est visible par tous, il ne doit jamais exister, même
 * une fraction de seconde, sans les droits d'origine. `createdBy` reste NULL (identité système) :
 * le créateur a un passe-droit d'accès, ce qui ajouterait un lecteur absent de la source ; pour la
 * même raison on n'appelle pas `grantConsultation`. Ni type, ni confidentialité par défaut : le
 * type porterait ses propres droits. Le déclenchement du pipeline IA reste à l'appelant (moteur).
 */
export async function ingestExternalFile(
  input: ExternalFileInput,
  grants: DocuProGrant[],
  deps: ExternalIngestDeps,
): Promise<ExternalIngestResult> {
  assertSafeGrants(grants);
  const db = deps.prisma ?? prisma;
  const now = (deps.now ?? (() => new Date()))();
  const { extension, data } = await buildFileData(input, now);
  const fileType = await resolveFileTypeWith(db, extension);

  const document = await db.document.create({
    data: {
      label: labelFromName(input.name),
      dossierId: input.dossierId,
      isArchived: false,
      createdBy: null,
      ...(input.sourceItemId !== undefined
        ? { gedSourceItems: { connect: { gedSourceItemId: input.sourceItemId } } }
        : {}),
      versions: {
        create: {
          versionNumber: 1,
          isCurrent: true,
          createdBy: null,
          files: { create: { ...data, fileTypeId: fileType.fileTypeId } },
        },
      },
      permissions: {
        create: grants.map((g) => ({
          userGroupId: g.userGroupId,
          permissionLevelId: CONSULTATION_LEVEL,
          grantedBy: g.userGroupId,
        })),
      },
    },
    include: { versions: { include: { files: true } } },
  });
  const version = document.versions[0]!;
  const file = version.files[0]!;

  try {
    await deps.fileStore.write(file.fileId, extension, input.bytes);
  } catch (err) {
    // Sans octets sur le coffre, le document serait une coquille : on le retire pour qu'une
    // resynchronisation reparte proprement (cascade sur versions, fichiers et droits).
    await db.document.delete({ where: { documentId: document.documentId } }).catch(() => undefined);
    throw err;
  }
  await (deps.seal ?? sealFreshDocument)(document.documentId, deps.archivesPath);
  // Docu-Flow W3 : document créé avec ses droits, octets écrits et scellé ; hors transaction, ne lève jamais.
  safeEmitDocumentDeposited(document, { source: 'externe', pageCount: file.pageCount });
  return {
    documentId: document.documentId,
    documentVersionId: version.documentVersionId,
    fileId: file.fileId,
  };
}

/**
 * Synchro : nouvelle version COURANTE d'un document existant (ancienne `isCurrent=false`,
 * `versionNumber`+1, nouveau fichier). Les droits du document ne sont PAS touchés : on n'élargit
 * jamais, et un changement de droits d'origine ne se répercute pas silencieusement.
 */
export async function addVersionFromSource(
  documentId: number,
  input: ExternalFileInput,
  deps: ExternalIngestDeps,
): Promise<ExternalIngestResult & { versionNumber: number }> {
  const db = deps.prisma ?? prisma;
  const now = (deps.now ?? (() => new Date()))();
  const last = await db.documentVersion.findFirst({
    where: { documentId },
    orderBy: { versionNumber: 'desc' },
    select: {
      documentVersionId: true,
      versionNumber: true,
      files: { select: { fileId: true, hash: true } },
    },
  });
  if (!last) throw new Error('Document sans version : nouvelle version impossible');
  // IDEMPOTENCE AU REJEU : un arrêt du worker entre cette écriture et la mise à jour de l'élément
  // fait rejouer la synchro avec le même contenu. Si la version la plus récente porte déjà cette
  // empreinte, elle EST le résultat du passage précédent : pas de version en trop.
  const incomingHash = createHash('sha256').update(input.bytes).digest('hex');
  const already = (last.files ?? []).find((f) => f.hash === incomingHash);
  if (already) {
    // Le plantage a pu survenir avant l'écriture des octets : on les réécrit (idempotent, même
    // contenu) plutôt que de laisser une version sans binaire, puis on rescelle.
    await deps.fileStore.write(already.fileId, realExtension(input.name), input.bytes);
    await (deps.seal ?? sealFreshDocument)(documentId, deps.archivesPath);
    return {
      documentId,
      documentVersionId: last.documentVersionId,
      fileId: already.fileId,
      versionNumber: last.versionNumber,
    };
  }
  const { extension, data } = await buildFileData(input, now);
  const fileType = await resolveFileTypeWith(db, extension);

  // Une seule transaction : l'index unique partiel « une seule version courante » impose de
  // décocher l'ancienne avant de créer la nouvelle, et on ne veut jamais un document sans version
  // courante si la création échoue.
  const [, created] = await db.$transaction([
    db.documentVersion.updateMany({
      where: { documentId, isCurrent: true },
      data: { isCurrent: false },
    }),
    db.documentVersion.create({
      data: {
        documentId,
        versionNumber: last.versionNumber + 1,
        isCurrent: true,
        createdBy: null,
        files: { create: { ...data, fileTypeId: fileType.fileTypeId } },
      },
      include: { files: true },
    }),
  ]);
  const file = created.files[0]!;

  try {
    await deps.fileStore.write(file.fileId, extension, input.bytes);
  } catch (err) {
    // Retour à la version précédente : sans octets, la nouvelle version ne doit pas faire foi.
    await db
      .$transaction([
        db.documentVersion.delete({ where: { documentVersionId: created.documentVersionId } }),
        db.documentVersion.update({
          where: { documentVersionId: last.documentVersionId },
          data: { isCurrent: true },
        }),
      ])
      .catch(() => undefined);
    throw err;
  }
  await (deps.seal ?? sealFreshDocument)(documentId, deps.archivesPath);
  return {
    documentId,
    documentVersionId: created.documentVersionId,
    fileId: file.fileId,
    versionNumber: created.versionNumber,
  };
}
