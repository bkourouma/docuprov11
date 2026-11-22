import { Injectable, Logger } from '@nestjs/common';
import { DocumentsService } from '../../documents/documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { SubjectAccessChecker, SubjectActor } from '../../workflows/extension/subject-access';
import { isUserGroupActive, loadActor, parseSubjectId } from './load-actor';

/** Contrôle d'accès aux documents liés à une instance : délègue à `DocumentsService.canAccess`. Refus par défaut. */
@Injectable()
export class DocumentSubjectAccessChecker implements SubjectAccessChecker {
  readonly subjectType = 'document';
  private readonly logger = new Logger(DocumentSubjectAccessChecker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

  async canAccess(actor: SubjectActor, subjectId: string): Promise<boolean> {
    try {
      const documentId = parseSubjectId(subjectId);
      if (documentId == null) return false;
      const loaded = await loadActor(this.prisma, actor);
      if (!loaded) return false;
      return (await this.documents.canAccess(documentId, loaded.authUser)) === true;
    } catch (err) {
      this.logger.warn(`Contrôle d'accès au document en échec (refus) : ${(err as Error).message}`);
      return false;
    }
  }

  /** Propriétaire = créateur du document (un user_group_id) si son compte est actif, sinon null. */
  async resolveOwner(subjectId: string): Promise<number | null> {
    try {
      const documentId = parseSubjectId(subjectId);
      if (documentId == null) return null;
      const doc = await this.prisma.document.findUnique({ where: { documentId }, select: { createdBy: true } });
      const owner = doc?.createdBy ?? null;
      return (await isUserGroupActive(this.prisma, owner)) ? owner : null;
    } catch (err) {
      this.logger.warn(`Résolution du propriétaire du document en échec : ${(err as Error).message}`);
      return null;
    }
  }
}
