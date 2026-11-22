import { Injectable, NotFoundException } from '@nestjs/common';
import { MailStatus, MailType } from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import { MailsService } from '../../courriers/mails.service';
import { DocumentsService } from '../../documents/documents.service';
import { DraftingContextService } from '../../drafting/drafting-context.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SemanticSearchService } from '../../semantic-search/semantic-search.service';
import type {
  AgentDocumentHit,
  AgentDocumentView,
  AgentMailView,
  WfAgentDataPort,
} from './agent-data.port';

/**
 * Adaptateur de données des outils d'agent. TOUT passe par l'utilisateur LANCEUR (jamais un
 * administrateur par défaut) ; tout refus ou toute absence renvoie `null` / liste vide, sans jamais
 * distinguer les deux. Aucun contenu (document, courrier) n'est journalisé.
 *
 * RÈGLE D'ACCÈS AUX COURRIERS (prudente et réversible, échec fermé) :
 *  1. `MailsService.mailScope(user)` : `none` => refus ; `all` => lisible ; `imputed` => lisible seulement
 *     si une imputation est adressée à `user.userGroupId`, ou si l'utilisateur est destinataire (acteur
 *     nommé, ou porteur du rôle destinataire).
 *  2. Courrier supprimé ou introuvable => refus. Un courrier de départ/interne encore en rédaction n'est
 *     lisible que s'il est de type Arrivée (même visibilité que les files de suivi).
 *  3. CONFIDENTIALITÉ : le référentiel `mail_confidentialite` n'a pas de rang. Un courrier portant un
 *     niveau n'est lisible que si l'utilisateur détient un niveau (`confidentialite.rank`) au moins égal
 *     à celui du niveau documentaire de MÊME LIBELLÉ (insensible à la casse). Niveau sans équivalent
 *     documentaire, ou utilisateur sans niveau => refus. L'administrateur est exclu de ce contrôle.
 *     Pour assouplir : retirer l'étape 3 ; pour la préciser : ajouter un rang à `mail_confidentialite`.
 *  4. Les pièces listées sont filtrées par `DocumentsService.canAccess` (jamais d'intitulé de document
 *     interdit) ; aucune pièce binaire n'est lue ; le texte est borné par `maxChars`.
 */
@Injectable()
export class AgentDataAdapter implements WfAgentDataPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SemanticSearchService,
    private readonly drafting: DraftingContextService,
    private readonly mails: MailsService,
    private readonly documents: DocumentsService,
  ) {}

  async searchDocuments(user: AuthUser, query: string, limit: number): Promise<AgentDocumentHit[]> {
    if (!hasActor(user)) return [];
    // Les droits sont appliqués DANS la requête, avec l'utilisateur lanceur.
    const res = await this.search.search({ query, limit }, user);
    const seen = new Set<number>();
    const out: AgentDocumentHit[] = [];
    for (const hit of res.hits) {
      if (seen.has(hit.documentId)) continue;
      seen.add(hit.documentId);
      out.push({ documentId: hit.documentId, label: hit.documentLabel, excerpt: hit.excerpt });
      if (out.length >= limit) break;
    }
    return out;
  }

  async readDocument(user: AuthUser, documentId: number, maxChars: number): Promise<AgentDocumentView | null> {
    if (!hasActor(user)) return null;
    let docs;
    try {
      docs = await this.drafting.load({ contextDocumentIds: [documentId] }, user);
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
    const doc = docs[0];
    if (!doc) return null;
    let left = Math.max(0, maxChars);
    const overview = doc.overview ? take(doc.overview, left) : null;
    left -= overview ? Array.from(overview).length : 0;
    const excerpts: string[] = [];
    for (const e of doc.excerpts) {
      if (left <= 0) break;
      const piece = take(e, left);
      if (!piece) continue;
      excerpts.push(piece);
      left -= Array.from(piece).length;
    }
    return {
      documentId,
      label: doc.label,
      documentTypeLabel: doc.documentTypeLabel,
      documentDate: doc.documentDate,
      cote: doc.cote,
      overview,
      excerpts,
    };
  }

  async readMail(user: AuthUser, mailId: number, maxChars: number): Promise<AgentMailView | null> {
    if (!hasActor(user)) return null;
    const scope = await this.mails.mailScope(user);
    if (scope === 'none') return null;

    let mail;
    try {
      mail = await this.mails.getById(mailId, user, true);
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
    if (!mail) return null;

    if (mail.mailType !== MailType.Arrivee && mail.status === MailStatus.Redaction) return null;

    if (scope === 'imputed') {
      const me = user.userGroupId as number;
      const imputed = mail.inputations.some((i) => i.userId === me);
      if (!imputed && !(await this.isDestinataire(mail, me))) return null;
    }

    if (!(await this.confidentialityAllows(user, mail.confidentialite?.label ?? null))) return null;

    const documents: Array<{ documentId: number; label: string }> = [];
    for (const link of mail.documents) {
      const d = link.document;
      if (!d) continue;
      if (await this.documents.canAccess(d.documentId, user)) {
        documents.push({ documentId: d.documentId, label: d.label });
      }
    }

    return {
      mailId: mail.mailId,
      reference: mail.reference ?? null,
      title: mail.title ?? null,
      date: mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString().slice(0, 10) : null,
      senderLabel: mail.externalEntity?.label ?? null,
      natureLabel: mail.nature?.label ?? null,
      objetLabel: mail.objet?.label ?? null,
      confidentialiteLabel: mail.confidentialite?.label ?? null,
      documents,
      text: mail.description ? take(mail.description, Math.max(0, maxChars)) : null,
    };
  }

  /** « user » : identifiant d'acteur (`app_user_group`) d'un compte actif ; « role » : rôle actif. */
  async targetExists(kind: 'user' | 'role', id: number): Promise<boolean> {
    if (!Number.isSafeInteger(id) || id < 1) return false;
    if (kind === 'user') {
      const row = await this.prisma.appUserGroup.findUnique({
        where: { userGroupId: id },
        select: { user: { select: { isDisabled: true } } },
      });
      return !!row && !row.user.isDisabled;
    }
    const role = await this.prisma.role.findUnique({ where: { roleId: id }, select: { isActive: true } });
    return !!role && role.isActive;
  }

  private async isDestinataire(
    mail: { destinataireExpediteur: number | null; destinataireRoleId: number | null },
    userGroupId: number,
  ): Promise<boolean> {
    if (mail.destinataireRoleId != null) {
      const actor = await this.prisma.appUserGroup.findUnique({
        where: { userGroupId },
        select: { user: { select: { roleId: true } } },
      });
      return actor?.user.roleId === mail.destinataireRoleId;
    }
    return mail.destinataireExpediteur === userGroupId;
  }

  private async confidentialityAllows(user: AuthUser, mailLevelLabel: string | null): Promise<boolean> {
    if (mailLevelLabel == null) return true;
    if (user.isAdmin) return true;
    const required = await this.prisma.confidentialite.findFirst({
      where: { label: { equals: mailLevelLabel.trim(), mode: 'insensitive' } },
      select: { rank: true },
      orderBy: { rank: 'desc' }, // plusieurs équivalents : le plus restrictif
    });
    if (!required) return false;
    const me = await this.prisma.appUser.findUnique({
      where: { userId: user.userId },
      select: { confidentialite: { select: { rank: true } } },
    });
    const userRank = me?.confidentialite?.rank ?? null;
    return userRank != null && userRank >= required.rank;
  }
}

function hasActor(user: AuthUser | null | undefined): user is AuthUser {
  return !!user && !user.isScanAgent && user.userGroupId != null;
}

/** Tronque par points de code (jamais au milieu d'un caractère). */
function take(text: string, max: number): string {
  const trimmed = text.trim();
  if (max <= 0) return '';
  const chars = Array.from(trimmed);
  return chars.length <= max ? trimmed : chars.slice(0, max).join('');
}
