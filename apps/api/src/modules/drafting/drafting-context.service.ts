import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DocumentState,
  GED_DRAFT_CONTEXT_DOC_MAX_CHARS,
  GED_DRAFT_MAX_CONTEXT_DOCUMENTS,
} from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { DocumentsService } from '../documents/documents.service';
import { PrismaService } from '../prisma/prisma.service';
import type { DraftContextDocument } from './drafting-prompt';

/** Plus grand identifiant admis (entier 32 bits signé). */
const MAX_ID = 2_147_483_647;
/** Lignes d'un dossier lues AVANT filtrage par droits : de quoi en garder 5 même si beaucoup sont refusées. */
const DOSSIER_SCAN_ROWS = 60;
/** Contrôles de droits menés en parallèle (chaque `canAccess` fait plusieurs requêtes). */
const ACCESS_CONCURRENCY = 5;
/** Segments lus au plus par document : ~800 caractères chacun, de quoi remplir 4 000 caractères. */
const CHUNK_READ_LIMIT = 12;

const DOCUMENT_SELECT = {
  documentId: true,
  label: true,
  documentDate: true,
  cote: true,
  overview: true,
  documentType: { select: { label: true } },
  dossier: { select: { label: true } },
} as const;

interface DocumentRow {
  documentId: number;
  label: string;
  documentDate: Date | null;
  cote: string | null;
  overview: string | null;
  documentType: { label: string } | null;
  dossier: { label: string } | null;
}

/**
 * Contexte d'un brouillon (lot 4c) : documents dont les données alimentent la rédaction assistée.
 *
 * RÈGLE D'OR (comme l'éditeur natif) : tout refus répond par le MÊME 404 `Document introuvable`,
 * sans dire quel document ni pourquoi (inexistant, interdit, épuré, identifiant invalide, dossier
 * inexistant ou sans document accessible, compte machine).
 *  - Documents EXPLICITES : tous les droits (`DocumentsService.canAccess`) sont contrôlés AVANT toute
 *    lecture de métadonnées ou de texte ; un seul refus annule tout l'appel.
 *  - DOSSIER : ses documents sont filtrés SILENCIEUSEMENT par `canAccess` ; s'il n'en reste aucun,
 *    404 (le libellé du dossier n'est jamais exposé à qui n'y voit rien).
 *  - Ne lit que le libellé, le type, la date, la cote, le résumé, le libellé du dossier et le texte
 *    des segments `ged_document_chunk` de la version courante, uniquement pour des documents
 *    autorisés. Aucun texte de document n'est journalisé.
 *
 * DÉCISION PRUDENTE ET RÉVERSIBLE : un document ÉPURÉ (DUA expirée et traitée) n'est jamais utilisé
 * comme contexte (404 s'il est demandé explicitement, écarté d'un dossier), comme dans la recherche
 * sémantique. `canAccess` ne l'exclut pas : si le métier décide qu'il reste utilisable, retirer le
 * filtre `documentState` (et les tests correspondants).
 */
@Injectable()
export class DraftingContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

  /** Charge le contexte d'un brouillon. Lève `NotFoundException('Document introuvable')` pour tout refus. */
  async load(
    input: { contextDocumentIds?: number[]; dossierId?: number },
    user: AuthUser,
  ): Promise<DraftContextDocument[]> {
    if (!user || user.isScanAgent || user.userGroupId == null) throw this.notFound();

    const rawIds = input?.contextDocumentIds ?? [];
    if (!Array.isArray(rawIds)) throw this.notFound();
    for (const id of rawIds) if (!isValidId(id)) throw this.notFound();
    const explicitIds = [...new Set(rawIds)];
    if (explicitIds.length > GED_DRAFT_MAX_CONTEXT_DOCUMENTS) throw this.notFound();

    const dossierId = input?.dossierId;
    if (dossierId !== undefined && dossierId !== null && !isValidId(dossierId)) throw this.notFound();

    // 1. Droits de TOUS les documents explicites, avant toute lecture.
    const verdicts = await mapLimited(explicitIds, ACCESS_CONCURRENCY, (id) => this.documents.canAccess(id, user));
    if (verdicts.some((ok) => ok !== true)) throw this.notFound();

    // 2. Documents du dossier : filtre silencieux par droits.
    let fromDossier: number[] = [];
    if (dossierId !== undefined && dossierId !== null) {
      fromDossier = await this.accessibleDossierDocuments(
        dossierId,
        new Set(explicitIds),
        GED_DRAFT_MAX_CONTEXT_DOCUMENTS - explicitIds.length,
        user,
      );
    }

    const selected = [...explicitIds, ...fromDossier];
    if (selected.length === 0) return [];

    // 3. Métadonnées des seuls documents autorisés.
    const rows = (await this.prisma.document.findMany({
      where: { documentId: { in: selected }, documentState: { not: DocumentState.Epure } },
      select: DOCUMENT_SELECT,
    })) as DocumentRow[];
    const byId = new Map(rows.map((r) => [r.documentId, r]));
    // Un document explicite disparu (ou épuré) entre-temps : même 404 que tout autre refus.
    if (explicitIds.some((id) => !byId.has(id))) throw this.notFound();
    const kept = selected.filter((id) => byId.has(id));

    // 4. Texte des segments, document par document (seulement des documents autorisés).
    const out: DraftContextDocument[] = [];
    for (const [index, id] of kept.entries()) {
      const row = byId.get(id) as DocumentRow;
      out.push({
        marker: index + 1,
        label: row.label,
        documentTypeLabel: row.documentType?.label ?? null,
        documentDate: formatDate(row.documentDate),
        cote: row.cote,
        overview: row.overview,
        dossierLabel: row.dossier?.label ?? null,
        excerpts: await this.loadExcerpts(id),
      });
    }
    return out;
  }

  /**
   * Documents du dossier que l'utilisateur peut ouvrir, hors documents déjà explicites, au plus
   * `room`. Lève le 404 uniforme si AUCUN document du dossier n'est accessible (dossier inexistant
   * compris), même quand les explicites remplissent déjà le contexte.
   */
  private async accessibleDossierDocuments(
    dossierId: number,
    explicit: ReadonlySet<number>,
    room: number,
    user: AuthUser,
  ): Promise<number[]> {
    const candidates = await this.prisma.document.findMany({
      where: { dossierId, documentState: { not: DocumentState.Epure } },
      select: { documentId: true },
      orderBy: [{ documentDate: { sort: 'asc', nulls: 'last' } }, { documentId: 'asc' }],
      take: DOSSIER_SCAN_ROWS,
    });

    const out: number[] = [];
    let anyAccessible = false;
    for (let i = 0; i < candidates.length; i += ACCESS_CONCURRENCY) {
      if (anyAccessible && out.length >= room) break;
      const slice = candidates.slice(i, i + ACCESS_CONCURRENCY).map((c) => c.documentId);
      const verdicts = await Promise.all(slice.map((id) => this.documents.canAccess(id, user)));
      slice.forEach((id, k) => {
        if (verdicts[k] !== true) return;
        anyAccessible = true;
        if (!explicit.has(id) && out.length < room) out.push(id);
      });
    }
    if (!anyAccessible) throw this.notFound();
    return out;
  }

  /** Premiers segments (ordre `chunkIndex`) de la version courante, jusqu'à GED_DRAFT_CONTEXT_DOC_MAX_CHARS. */
  private async loadExcerpts(documentId: number): Promise<string[]> {
    const chunks = await this.prisma.gedDocumentChunk.findMany({
      where: { documentId, documentVersion: { is: { isCurrent: true } } },
      select: { content: true },
      orderBy: { chunkIndex: 'asc' },
      take: CHUNK_READ_LIMIT,
    });
    const out: string[] = [];
    let left = GED_DRAFT_CONTEXT_DOC_MAX_CHARS;
    for (const c of chunks) {
      if (left <= 0) break;
      const text = typeof c.content === 'string' ? c.content.trim() : '';
      if (!text) continue;
      const piece = Array.from(text).slice(0, left).join('');
      out.push(piece);
      left -= Array.from(piece).length;
    }
    return out;
  }

  private notFound(): NotFoundException {
    return new NotFoundException('Document introuvable');
  }
}

function isValidId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 && id <= MAX_ID;
}

/** Date métier (`@db.Date`, minuit UTC) au format AAAA-MM-JJ. */
function formatDate(date: Date | null): string | null {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** `Promise.all` par lots de `limit` : ordre des résultats conservé. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}
