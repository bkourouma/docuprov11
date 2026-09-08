import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * Liaison courrier ↔ document GED existant (§02.6). Réutilise le Document/DocumentVersion/
 * DocumentFile de la GED — aucune table document recréée. La « déliaison » (§03.6, code 1014)
 * retire le lien sans supprimer le document.
 */
@Injectable()
export class MailDocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Rattache un document à un courrier (idempotent sur (mailId, documentId)). */
  link(mailId: number, documentId: number, decharge: boolean, user: AuthUser) {
    return this.prisma.mailDocument.upsert({
      where: { ux_mail_document: { mailId, documentId } },
      update: { decharge },
      create: { mailId, documentId, decharge, createdBy: user.userGroupId },
    });
  }

  /** Retire le lien courrier ↔ document (déliaison). */
  async unlink(mailId: number, documentId: number): Promise<{ unlinked: number }> {
    const res = await this.prisma.mailDocument.deleteMany({ where: { mailId, documentId } });
    return { unlinked: res.count };
  }

  /** Documents rattachés à un courrier (avec le libellé GED). */
  listForMail(mailId: number) {
    return this.prisma.mailDocument.findMany({
      where: { mailId },
      orderBy: { mailDocumentId: 'asc' },
      include: { document: { select: { documentId: true, label: true, documentDate: true } } },
    });
  }
}
