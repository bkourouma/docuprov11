import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DocumentState } from '@archivage/types';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { effectiveMenuKeys } from '../auth/menu-access';
import { lendingAccess, toIsoDate, type LendingAccess, type LendingAction } from './domain';
import type { CreateLendingDto, LendingQueryDto } from './archives.dto';

/** Ligne des écrans « Documents communiqués », « Mes documents communiqués » et « Historique ». */
export interface LendingRow {
  lendingDocumentId: number;
  lendingDocumentDetailId: number;
  documentId: number;
  documentLabel: string;
  documentCote: string | null;
  /** Bénéficiaire du prêt (nom complet, à défaut identifiant de connexion). */
  fullName: string;
  lendingMotiveName: string | null;
  startDate: string;
  projectedReturnDate: string | null;
  returnedDate: string | null;
  /** Prêt non rendu dont la date de retour prévue est passée — l'écran le met en évidence. */
  isOverdue: boolean;
}

export interface LendingResult {
  total: number;
  page: number;
  pageSize: number;
  rows: LendingRow[];
}

/** Portée d'une liste de prêts. */
type LendingScope = 'out' | 'mine' | 'history';

/**
 * Communication / prêt de documents (Docu-Archives §3 à §6).
 *
 * Modèle en deux niveaux, repris du source : une ENTÊTE (`lending_document` — un bénéficiaire, un
 * motif, des dates) et un DÉTAIL par document (`lending_document_detail`). C'est le détail qui
 * porte le retour : un prêt de cinq documents peut être rendu document par document.
 *
 * Écart assumé : le source ne retournait que le détail et laissait l'entête éternellement
 * « ouverte ». Ici, quand le dernier détail est rendu, l'entête est close (`returned_date`) — sans
 * quoi rien en base ne distingue un prêt terminé d'un prêt en cours, et l'historique ne peut se
 * lire que par agrégation.
 */
@Injectable()
export class ArchivesLendingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Documents communicables d'un dossier — alimente le multi-select de l'écran « Communiquer un
   * document » quand on change de dossier.
   *
   * Sont écartés : les documents déjà prêtés et non rendus (on ne prête pas deux fois le même
   * original), les documents épurés et les documents gelés. Le source proposait tout le dossier,
   * ce qui laissait créer des prêts concurrents sur la même pièce.
   */
  async listLendableDocuments(dossierId: number) {
    const rows = await this.prisma.document.findMany({
      where: {
        dossierId,
        documentState: { not: DocumentState.Epure },
        isFrozen: false,
        lendingDetails: { none: { returnedDate: null } },
      },
      select: {
        documentId: true,
        label: true,
        cote: true,
        documentDate: true,
        documentType: { select: { label: true } },
      },
      orderBy: { label: 'asc' },
    });
    return rows.map((r) => ({
      documentId: r.documentId,
      label: r.label,
      cote: r.cote,
      documentDate: r.documentDate ? toIsoDate(r.documentDate) : null,
      documentTypeName: r.documentType?.label ?? null,
    }));
  }

  /**
   * Crée une communication : une entête + un détail par document.
   *
   * Contrôles refusés en bloc (une transaction, pas de prêt à moitié créé) : bénéficiaire ou motif
   * inexistant, motif désactivé, documents inexistants, épurés, gelés ou déjà prêtés. Le source
   * créait les détails un à un sans vérifier, de sorte qu'un document déjà sorti pouvait l'être une
   * seconde fois.
   *
   * Corrections du 2026-11-22 (E2E lot 2, T3) :
   *  - motif vérifié AVANT l'insertion : un identifiant inconnu levait une violation de clé
   *    étrangère, rendue en 500 (ANO-ARC-T3-01) ;
   *  - documents gelés refusés, comme `listLendableDocuments` les écarte déjà (ANO-ARC-T3-03) ;
   *  - identifiants dédoublonnés : le même document cité deux fois créait deux sorties
   *    concurrentes de la même pièce (ANO-ARC-T3-04).
   */
  async createLending(input: CreateLendingDto, createdBy: number | null) {
    const documentIds = [...new Set(input.documentIds)];

    const beneficiary = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId: input.userGroupId },
      select: { userGroupId: true },
    });
    if (!beneficiary) throw new NotFoundException('Bénéficiaire introuvable');

    const motive = await this.prisma.lendingMotive.findUnique({
      where: { lendingMotiveId: input.lendingMotiveId },
      select: { isActive: true },
    });
    if (!motive) throw new NotFoundException('Motif de prêt introuvable');
    if (!motive.isActive) throw new BadRequestException('Motif de prêt désactivé');

    const documents = await this.prisma.document.findMany({
      where: { documentId: { in: documentIds } },
      select: { documentId: true, label: true, documentState: true, isFrozen: true },
    });
    const missing = documentIds.filter((id) => !documents.some((d) => d.documentId === id));
    if (missing.length) {
      throw new NotFoundException(`Document(s) introuvable(s) : ${missing.join(', ')}`);
    }

    const purged = documents.filter((d) => d.documentState === DocumentState.Epure);
    if (purged.length) {
      throw new ConflictException(
        `Document(s) épuré(s), non communicable(s) : ${purged.map((d) => d.label).join(', ')}`,
      );
    }

    const frozen = documents.filter((d) => d.isFrozen);
    if (frozen.length) {
      throw new ConflictException(
        `Document(s) gelé(s), non communicable(s) : ${frozen.map((d) => d.label).join(', ')}`,
      );
    }

    const alreadyOut = await this.prisma.lendingDocumentDetail.findMany({
      where: { documentId: { in: documentIds }, returnedDate: null },
      select: { document: { select: { label: true } } },
    });
    if (alreadyOut.length) {
      throw new ConflictException(
        `Document(s) déjà communiqué(s) et non rendu(s) : ${alreadyOut
          .map((l) => l.document.label)
          .join(', ')}`,
      );
    }

    return this.prisma.lendingDocument.create({
      data: {
        startDate: new Date(`${input.startDate}T00:00:00.000Z`),
        projectedReturnDate: new Date(`${input.projectedReturnDate}T00:00:00.000Z`),
        lendingMotiveId: input.lendingMotiveId,
        userGroupId: input.userGroupId,
        createdBy,
        details: { create: documentIds.map((documentId) => ({ documentId })) },
      },
      include: { details: true },
    });
  }

  /** Prêts en cours, tous bénéficiaires confondus (§4). */
  listOut(query: LendingQueryDto) {
    return this.list('out', query, null);
  }

  /** Prêts en cours dont l'utilisateur courant est le bénéficiaire (§5). */
  listMine(query: LendingQueryDto, userId: number) {
    return this.list('mine', query, userId);
  }

  /** Prêts terminés — consultation seule, le retour a déjà eu lieu (§6). */
  listHistory(query: LendingQueryDto) {
    return this.list('history', query, null);
  }

  private async list(
    scope: LendingScope,
    query: LendingQueryDto,
    userId: number | null,
  ): Promise<LendingResult> {
    const where: Prisma.LendingDocumentDetailWhereInput = {
      // « En cours » et « historique » se lisent sur le DÉTAIL, seul niveau à porter un retour
      // par document : une entête partiellement rendue apparaît des deux côtés, ce qui est juste.
      returnedDate: scope === 'history' ? { not: null } : null,
      ...(scope === 'mine' && userId != null
        ? // Un utilisateur peut porter plusieurs comptes de groupe : on filtre sur la personne,
          // pas sur l'acteur du jeton, sinon un prêt reçu via un autre groupe lui échapperait.
          { lending: { userGroup: { userId } } }
        : {}),
      ...(query.search?.trim()
        ? {
            OR: [
              { document: { label: { contains: query.search.trim(), mode: 'insensitive' } } },
              { document: { cote: { contains: query.search.trim(), mode: 'insensitive' } } },
              {
                lending: {
                  motive: { label: { contains: query.search.trim(), mode: 'insensitive' } },
                },
              },
              {
                lending: {
                  userGroup: {
                    user: {
                      OR: [
                        { fullName: { contains: query.search.trim(), mode: 'insensitive' } },
                        { username: { contains: query.search.trim(), mode: 'insensitive' } },
                      ],
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.lendingDocumentDetail.count({ where }),
      this.prisma.lendingDocumentDetail.findMany({
        where,
        orderBy: this.orderBy(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          document: { select: { documentId: true, label: true, cote: true } },
          lending: {
            select: {
              lendingDocumentId: true,
              startDate: true,
              projectedReturnDate: true,
              motive: { select: { label: true } },
              userGroup: { select: { user: { select: { fullName: true, username: true } } } },
            },
          },
        },
      }),
    ]);

    const today = new Date();
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      rows: rows.map((r) => ({
        lendingDocumentId: r.lendingDocumentId,
        lendingDocumentDetailId: r.lendingDocumentDetailId,
        documentId: r.documentId,
        documentLabel: r.document.label,
        documentCote: r.document.cote,
        fullName: r.lending.userGroup.user.fullName?.trim() || r.lending.userGroup.user.username,
        lendingMotiveName: r.lending.motive?.label ?? null,
        startDate: toIsoDate(r.lending.startDate),
        projectedReturnDate: r.lending.projectedReturnDate
          ? toIsoDate(r.lending.projectedReturnDate)
          : null,
        returnedDate: r.returnedDate ? r.returnedDate.toISOString() : null,
        isOverdue:
          r.returnedDate == null &&
          r.lending.projectedReturnDate != null &&
          r.lending.projectedReturnDate < today,
      })),
    };
  }

  /** Tri : les clés sont validées par zod, la projection vers Prisma est faite ici. */
  private orderBy(query: LendingQueryDto): Prisma.LendingDocumentDetailOrderByWithRelationInput {
    const dir = query.sortDirection;
    switch (query.sorting) {
      case 'documentId':
        return { documentId: dir };
      case 'document':
        return { document: { label: dir } };
      case 'beneficiary':
        return { lending: { userGroup: { user: { fullName: dir } } } };
      case 'motive':
        return { lending: { motive: { label: dir } } };
      case 'projectedReturnDate':
        return { lending: { projectedReturnDate: dir } };
      case 'returnedDate':
        return { returnedDate: dir };
      case 'startDate':
      default:
        return { lending: { startDate: dir } };
    }
  }

  /**
   * Périmètre de l'appelant pour un geste sur un prêt identifié (ANO-ARC-T3-05, règle dans
   * `domain/lending-scope.ts`). Menus relus en base, comme le `MenuPermissionGuard` : le jeton ne
   * les porte pas, et un menu retiré doit prendre effet sans reconnexion.
   */
  private async accessFor(user: AuthUser, action: LendingAction): Promise<LendingAccess> {
    if (user.isAdmin) return 'all';
    const row = await this.prisma.appUser.findUnique({
      where: { userId: user.userId },
      select: {
        isAdmin: true,
        role: {
          select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } },
        },
      },
    });
    const access = lendingAccess(
      effectiveMenuKeys(row?.isAdmin ?? false, row?.role ?? null),
      action,
    );
    if (access === 'none') throw new ForbiddenException("Vous n'avez pas accès à cette section.");
    return access;
  }

  /**
   * Filtre « prêts de l'appelant » sur l'ENTÊTE, identique à celui de `listMine` : la personne
   * bénéficiaire, pas l'acteur du jeton (un prêt reçu via un autre de ses groupes reste le sien).
   *
   * Un prêt hors périmètre est rendu INTROUVABLE (404, même message qu'un identifiant inexistant)
   * plutôt qu'interdit (403) : pour un porteur du seul menu « Mes documents communiqués », le
   * prêt d'autrui n'existe pas — sa liste ne le montre pas — et un 403 confirmerait l'existence de
   * chaque identifiant essayé.
   */
  private ownLendingFilter(
    access: LendingAccess,
    user: AuthUser,
  ): Prisma.LendingDocumentWhereInput {
    return access === 'own' ? { userGroup: { userId: user.userId } } : {};
  }

  /**
   * Retour d'un document prêté. Clôt aussi l'entête si c'était le dernier document en sortie.
   * Idempotence refusée à dessein : re-cliquer sur « Retour » d'un prêt déjà rendu écraserait la
   * date de retour réelle, donc l'historique.
   *
   * Périmètre : « Documents communiqués » rend tout prêt ; « Mes documents communiqués » seul ne
   * rend que les siens (ANO-ARC-T3-05).
   */
  async returnDetail(lendingDocumentDetailId: number, user: AuthUser) {
    const access = await this.accessFor(user, 'return');
    const detail = await this.prisma.lendingDocumentDetail.findFirst({
      where: { lendingDocumentDetailId, lending: this.ownLendingFilter(access, user) },
      select: { lendingDocumentId: true, returnedDate: true },
    });
    if (!detail) throw new NotFoundException('Prêt introuvable');
    if (detail.returnedDate) throw new ConflictException('Ce document a déjà été retourné');

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.lendingDocumentDetail.update({
        where: { lendingDocumentDetailId },
        data: { returnedDate: now },
      });
      const stillOut = await tx.lendingDocumentDetail.count({
        where: { lendingDocumentId: detail.lendingDocumentId, returnedDate: null },
      });
      if (stillOut === 0) {
        await tx.lendingDocument.update({
          where: { lendingDocumentId: detail.lendingDocumentId },
          data: { returnedDate: now },
        });
      }
      return { ...updated, lendingClosed: stillOut === 0 };
    });
  }

  /**
   * Détail d'un prêt : ses documents et ses commentaires. « Documents communiqués » et
   * « Historique » lisent tout prêt ; « Mes documents communiqués » seul, les siens.
   */
  async getLending(lendingDocumentId: number, user: AuthUser) {
    const access = await this.accessFor(user, 'read');
    const lending = await this.prisma.lendingDocument.findFirst({
      where: { lendingDocumentId, ...this.ownLendingFilter(access, user) },
      include: {
        motive: { select: { label: true } },
        userGroup: { select: { user: { select: { fullName: true, username: true } } } },
        details: {
          include: { document: { select: { documentId: true, label: true, cote: true } } },
          orderBy: { lendingDocumentDetailId: 'asc' },
        },
        comments: {
          include: {
            userGroup: { select: { user: { select: { fullName: true, username: true } } } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!lending) throw new NotFoundException('Prêt introuvable');
    return lending;
  }

  /**
   * Commentaire sur un prêt, signé de l'acteur du jeton. « Documents communiqués » commente tout
   * prêt ; « Mes documents communiqués » seul, les siens.
   */
  async addComment(lendingDocumentId: number, comments: string, user: AuthUser) {
    const userGroupId = user.userGroupId;
    if (userGroupId == null) {
      throw new BadRequestException("Votre compte n'a pas d'acteur : commentaire impossible");
    }
    const access = await this.accessFor(user, 'comment');
    const lending = await this.prisma.lendingDocument.findFirst({
      where: { lendingDocumentId, ...this.ownLendingFilter(access, user) },
      select: { lendingDocumentId: true },
    });
    if (!lending) throw new NotFoundException('Prêt introuvable');
    return this.prisma.lendingDocumentComment.create({
      data: { lendingDocumentId, comments, userGroupId },
    });
  }
}
