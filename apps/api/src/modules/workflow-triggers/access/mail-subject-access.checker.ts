import { Injectable, Logger } from '@nestjs/common';
import { MailStatus, MailType } from '@archivage/types';
import { MailsService } from '../../courriers/mails.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { SubjectAccessChecker, SubjectActor } from '../../workflows/extension/subject-access';
import { isUserGroupActive, loadActor, parseSubjectId } from './load-actor';

/**
 * Contrôle d'accès aux courriers liés à une instance de workflow. Refus par défaut : l'acteur et son rôle
 * sont relus en base, jamais pris de l'appelant. Même règle de visibilité que `MailsService.visibility()`.
 */
@Injectable()
export class MailSubjectAccessChecker implements SubjectAccessChecker {
  readonly subjectType = 'mail';
  private readonly logger = new Logger(MailSubjectAccessChecker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mails: MailsService,
  ) {}

  async canAccess(actor: SubjectActor, subjectId: string): Promise<boolean> {
    try {
      const mailId = parseSubjectId(subjectId);
      if (mailId == null) return false;
      const loaded = await loadActor(this.prisma, actor);
      if (!loaded) return false;
      const mail = await this.prisma.mail.findUnique({
        where: { mailId },
        select: {
          isDeleted: true,
          status: true,
          mailType: true,
          destinataireExpediteur: true,
          destinataireRoleId: true,
          createdBy: true,
        },
      });
      if (!mail || mail.isDeleted) return false;
      // Même règle que MailsService.visibility() : un courrier en rédaction n'est visible que s'il est Arrivée.
      if (!(mail.status !== MailStatus.Redaction || mail.mailType === MailType.Arrivee)) return false;

      const { authUser, activeRoleId } = loaded;
      const userGroupId = actor.userGroupId;
      if (authUser.isAdmin) return true;
      if ((await this.mails.mailScope(authUser)) === 'all') return true;
      if (mail.destinataireExpediteur === userGroupId) return true;
      if (mail.destinataireRoleId != null && mail.destinataireRoleId === activeRoleId) return true;
      if (mail.createdBy === userGroupId) return true;
      return (await this.prisma.mailInputation.count({ where: { mailId, userId: userGroupId } })) > 0;
    } catch (err) {
      this.logger.warn(`Contrôle d'accès au courrier en échec (refus) : ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Propriétaire = destinataire nominatif, à défaut le créateur. Un courrier destiné à un RÔLE n'a pas de
   * propriétaire nominatif : on retombe sur son créateur. Null si absent, supprimé ou compte désactivé.
   */
  async resolveOwner(subjectId: string): Promise<number | null> {
    try {
      const mailId = parseSubjectId(subjectId);
      if (mailId == null) return null;
      const mail = await this.prisma.mail.findUnique({
        where: { mailId },
        select: { isDeleted: true, destinataireExpediteur: true, createdBy: true },
      });
      if (!mail || mail.isDeleted) return null;
      const owner = mail.destinataireExpediteur ?? mail.createdBy ?? null;
      return (await isUserGroupActive(this.prisma, owner)) ? owner : null;
    } catch (err) {
      this.logger.warn(`Résolution du propriétaire du courrier en échec : ${(err as Error).message}`);
      return null;
    }
  }
}
