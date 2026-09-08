import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentTabsService } from '../documents/document-tabs.service';
import type { AuthUser } from '../auth/auth.types';
import type { CreateAccessInquiryDto } from './access-inquiries.dto';

/**
 * Demandes d'accès document (menu « Sécurité Documentaire », page 1 — legacy
 * `DocumentAccessInquiry`) : n'importe quel utilisateur connecté peut en soumettre une depuis la
 * fiche document ; seul un administrateur (ou un rôle habilité) les traite.
 *
 * L'acceptation RÉUTILISE `DocumentTabsService.grantPermission` (onglet « Accès par Utilisateur »)
 * au lieu de dupliquer l'upsert de `document_permission` — c'est exactement l'effet du legacy
 * (« recherche un droit existant pour ce couple document/utilisateur, sinon le crée »).
 */
@Injectable()
export class AccessInquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tabs: DocumentTabsService,
  ) {}

  async create(input: CreateAccessInquiryDto, user: AuthUser) {
    if (user.userGroupId == null) {
      // Identité machine ou compte sans groupe : rien à porter comme demandeur (FK obligatoire).
      throw new BadRequestException('Aucun groupe utilisateur associé à ce compte');
    }
    const doc = await this.prisma.document.findUnique({
      where: { documentId: input.documentId },
      select: { documentId: true },
    });
    if (!doc) throw new NotFoundException('Document introuvable');
    const level = await this.prisma.permissionLevel.findUnique({
      where: { permissionLevelId: input.permissionLevelId },
    });
    if (!level) throw new BadRequestException('Niveau de permission inconnu');

    return this.prisma.documentAccessInquiry.create({
      data: {
        documentId: input.documentId,
        userGroupId: user.userGroupId,
        permissionLevelId: input.permissionLevelId,
        motive: input.motive,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
      },
    });
  }

  async list() {
    const rows = await this.prisma.documentAccessInquiry.findMany({
      select: {
        documentAccessInquiryId: true,
        documentId: true,
        document: { select: { label: true } },
        userGroupId: true,
        userGroup: { select: { user: { select: { fullName: true, username: true } } } },
        permissionLevelId: true,
        permissionLevel: { select: { name: true } },
        motive: true,
        startDate: true,
        endDate: true,
        status: true,
        decidedBy: true,
        decidedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      documentAccessInquiryId: r.documentAccessInquiryId,
      documentId: r.documentId,
      documentLabel: r.document.label,
      requester: r.userGroup.user?.fullName || r.userGroup.user?.username || `#${r.userGroupId}`,
      permissionLevelId: r.permissionLevelId,
      permissionLevelName: r.permissionLevel.name,
      motive: r.motive,
      startDate: r.startDate,
      endDate: r.endDate,
      status: r.status,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    }));
  }

  async decide(documentAccessInquiryId: number, accept: boolean, user: AuthUser) {
    const inquiry = await this.prisma.documentAccessInquiry.findUnique({
      where: { documentAccessInquiryId },
    });
    if (!inquiry) throw new NotFoundException('Demande introuvable');
    if (inquiry.status !== 0) throw new ConflictException('Cette demande a déjà été traitée');

    if (accept) {
      await this.tabs.grantPermission(
        inquiry.documentId,
        { userGroupId: inquiry.userGroupId, permissionLevelId: inquiry.permissionLevelId },
        user,
      );
    }

    return this.prisma.documentAccessInquiry.update({
      where: { documentAccessInquiryId },
      data: {
        status: accept ? 1 : 2,
        decidedBy: user.userGroupId,
        decidedAt: new Date(),
      },
    });
  }
}
