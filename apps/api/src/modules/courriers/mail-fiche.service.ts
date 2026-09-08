import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAIL_ACTION_LABELS, MAIL_STATUS_LABELS, MAIL_TYPE_LABELS } from '@archivage/types';
import { fichePdfDoc, fillDocxTemplate, renderFichePdf } from '@archivage/exports';
import { PrismaService } from '../prisma/prisma.service';
import { buildFiche, type FicheInputs } from './domain';

/**
 * Données de la Fiche d'Imputation (§09). Miroir fidèle du `GetMailForViewDto` documenté, qui est
 * exactement ce que le source passe au gabarit `FICHE_IMPUTATION.docx` : on n'ajoute aucun champ
 * que le document n'énumère pas.
 *
 * Les noms de propriétés reprennent ceux du DTO source (et non les conventions V6) : ce sont eux
 * qui serviront de clés de substitution dans le gabarit.
 */
export interface FicheImputationData {
  mailId: number;
  /** Bloc courrier (`MailDto`). */
  title: string;
  reference: string | null;
  nReference: string | null;
  date: Date | null;
  dateButoire: Date | null;
  confidentialitesName: string | null;
  /** Libellé du courrier parent (`MailDisplayProperty`). */
  mailDisplayProperty: string | null;
  dateEnregistrementCourrier: Date | null;
  creationTime: Date;
  externalEntityName: string | null;
  mailTypeName: string;
  mailNature: string | null;
  description: string | null;
  /** `Direction` du source = organigramme de rattachement du courrier. */
  direction: string | null;
  mailObjet: string | null;
  statut: string;
  lastImputationFullName: string | null;
  dateDecharge: Date | null;
  destinataireFullName: string | null;
  /** Acteur destinataire (Départ §12) — null quand le courrier est adressé à un rôle (§05). */
  destinataireExpediteurId: number | null;
  /** Type de la dernière imputation non traitée (`InputationTypeName`). */
  inputationTypeName: string | null;
  /** Échéance de la dernière imputation non traitée (`Deadline`). */
  deadline: Date | null;
  userCreated: string | null;
  /** Détail des imputations — le gabarit peut en faire un tableau. */
  imputations: Array<{
    typeName: string;
    userFullName: string | null;
    instructions: string | null;
    deadline: Date | null;
    dateTreated: Date | null;
  }>;
}

const actorName = (a: { user: { fullName: string | null; username: string } } | null) =>
  a ? a.user.fullName?.trim() || a.user.username : null;

/** Horodatage du nom de fichier — `yyyyMMddHHmmss`, comme le source. */
const stamp = (d: Date): string =>
  [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');

/**
 * Assemblage des données de la fiche (§09). Lecture pure : la génération de la fiche ne mute
 * jamais le courrier (« opération de lecture/rendu, sans mutation »).
 */
@Injectable()
export class MailFicheService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config?: ConfigService,
  ) {}

  /**
   * Chemin d'un gabarit. En dev `__dirname` est dans `src/`, en prod dans `dist/` : les deux
   * emplacements sont testés (nest-cli copie les .docx dans `dist/assets/templates`). Sans cela le
   * rendu marcherait en dev et tomberait en 404 une fois déployé. `TEMPLATES_PATH` force le dossier.
   */
  private async resolveTemplate(fileName: string): Promise<Buffer> {
    const override = this.config?.get<string>('TEMPLATES_PATH');
    const candidates = override
      ? [join(override, fileName)]
      : [
          join(__dirname, '../../assets/templates', fileName), // dist/modules/courriers -> dist/assets
          join(__dirname, '../../../assets/templates', fileName), // src/modules/courriers -> apps/api/assets
        ];
    for (const path of candidates) {
      const buf = await readFile(path).catch(() => null);
      if (buf) return buf;
    }
    throw new NotFoundException(`Modèle de document non trouvé : ${fileName}`);
  }

  /** Nom du 1er fichier joint SANS extension — alimente %description% (cf. règle 1 du domaine). */
  private async attachedFileName(mailId: number): Promise<string> {
    const link = await this.prisma.mailDocument.findFirst({
      where: { mailId },
      orderBy: { mailDocumentId: 'asc' },
      select: {
        document: {
          select: {
            versions: {
              where: { isCurrent: true },
              select: { files: { select: { originalName: true, fileExtension: true } } },
            },
          },
        },
      },
    });
    const file = link?.document?.versions[0]?.files[0];
    if (!file?.originalName) return '';
    return file.originalName.replace(/\.[^.]+$/, '');
  }

  /** Historique (§09 IV) : le `mail_action_log` V6 remplace les CustomAuditLogs du source. */
  private async historique(mailId: number) {
    const rows = await this.prisma.mailActionLog.findMany({
      where: { mailId },
      orderBy: { mailActionLogId: 'asc' },
      select: {
        createdAt: true,
        actionCode: true,
        details: true,
        userGroup: { select: { user: { select: { fullName: true, username: true } } } },
      },
    });
    return rows.map((r) => ({
      date: r.createdAt,
      userName: r.userGroup ? actorName(r.userGroup) : null,
      actionName: MAIL_ACTION_LABELS[r.actionCode] ?? `Action ${r.actionCode}`,
      details: r.details,
    }));
  }

  /** Assemble tout ce dont le gabarit a besoin (§09). */
  async getFicheInputs(mailId: number, now: Date): Promise<FicheInputs> {
    const data = await this.getFicheData(mailId);
    const [attachedFileName, historique, roles, types] = await Promise.all([
      this.attachedFileName(mailId),
      this.historique(mailId),
      this.prisma.role.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
      this.prisma.mailInputationType.findMany({
        where: { isActive: true },
        select: { label: true },
        orderBy: { label: 'asc' },
      }),
    ]);
    return {
      dateEnregistrementCourrier: data.dateEnregistrementCourrier,
      date: data.date,
      nReference: data.nReference,
      reference: data.reference,
      externalEntityName: data.externalEntityName,
      destinataireFullName: data.destinataireFullName,
      title: data.title,
      attachedFileName,
      imputations: data.imputations.map((i) => ({
        typeName: i.typeName,
        userFullName: i.userFullName,
        instructions: i.instructions,
        deadline: i.deadline,
      })),
      userCreated: data.userCreated,
      historique,
      allRoleNames: roles.map((r) => r.name),
      allInputationTypeNames: types.map((t) => t.label),
      now,
    };
  }

  /**
   * Fiche au format DOCX : remplit le gabarit du Sénat, donc **fidèle au modèle d'origine**
   * (polices, tableaux, en-tête). Le nom de fichier reprend celui du source.
   */
  async renderDocx(mailId: number, now: Date): Promise<{ buffer: Buffer; filename: string }> {
    const inputs = await this.getFicheInputs(mailId, now);
    const { template, replacements } = buildFiche(inputs);
    const buffer = await fillDocxTemplate(await this.resolveTemplate(template), replacements);
    return { buffer, filename: `FICHE_IMPUTATION_${mailId}_${stamp(now)}.docx` };
  }

  /**
   * Fiche au format PDF (aperçu / impression de la modale §09). Re-rendu depuis les MÊMES
   * substitutions que le DOCX — le source, lui, convertit le DOCX (écart assumé, cf. fiche-pdf).
   */
  async renderPdf(mailId: number, now: Date): Promise<{ buffer: Buffer; filename: string }> {
    const inputs = await this.getFicheInputs(mailId, now);
    const { template, replacements } = buildFiche(inputs);
    const buffer = await renderFichePdf(fichePdfDoc(template, replacements));
    return { buffer, filename: `FICHE_IMPUTATION_${mailId}_${stamp(now)}.pdf` };
  }

  async getFicheData(mailId: number): Promise<FicheImputationData> {
    const mail = await this.prisma.mail.findFirst({
      where: { mailId, isDeleted: false },
      include: {
        externalEntity: { select: { label: true } },
        nature: { select: { label: true } },
        confidentialite: { select: { label: true } },
        objet: { select: { label: true } },
        organigramme: { select: { label: true } },
        parent: { select: { title: true } },
        destinataire: { select: { user: { select: { fullName: true, username: true } } } },
        destinataireRole: { select: { name: true } },
        createdByUser: { select: { user: { select: { fullName: true, username: true } } } },
        inputations: {
          orderBy: { mailInputationId: 'asc' },
          include: {
            type: { select: { label: true } },
            user: { select: { user: { select: { fullName: true, username: true } } } },
          },
        },
      },
    });
    if (!mail) throw new NotFoundException('Courrier introuvable');

    // `LastImputationFullName` / `InputationTypeName` / `Deadline` : la DERNIÈRE imputation non
    // traitée, comme la projection parapheur du source (§08).
    const lastOpen = [...mail.inputations].reverse().find((i) => i.dateTreated == null);

    return {
      mailId: mail.mailId,
      title: mail.title,
      reference: mail.reference,
      nReference: mail.nReference,
      date: mail.date,
      dateButoire: mail.dateButoire,
      confidentialitesName: mail.confidentialite?.label ?? null,
      mailDisplayProperty: mail.parent?.title ?? null,
      dateEnregistrementCourrier: mail.dateEnregistrementCourrier,
      creationTime: mail.createdAt,
      externalEntityName: mail.externalEntity?.label ?? null,
      mailTypeName: MAIL_TYPE_LABELS[mail.mailType as keyof typeof MAIL_TYPE_LABELS] ?? '',
      mailNature: mail.nature?.label ?? null,
      description: mail.description,
      direction: mail.organigramme?.label ?? null,
      mailObjet: mail.objet?.label ?? null,
      statut: MAIL_STATUS_LABELS[mail.status as keyof typeof MAIL_STATUS_LABELS] ?? '',
      lastImputationFullName: lastOpen ? actorName(lastOpen.user) : null,
      dateDecharge: mail.dateDecharge,
      // §05 : le destinataire d'un Arrivée est un rôle — c'est son libellé qui remplit la fiche.
      destinataireFullName: actorName(mail.destinataire) ?? mail.destinataireRole?.name ?? null,
      destinataireExpediteurId: mail.destinataireExpediteur,
      inputationTypeName: lastOpen?.type.label ?? null,
      deadline: lastOpen?.deadline ?? null,
      userCreated: actorName(mail.createdByUser),
      imputations: mail.inputations.map((i) => ({
        typeName: i.type.label,
        userFullName: actorName(i.user),
        instructions: i.instructions,
        deadline: i.deadline,
        dateTreated: i.dateTreated,
      })),
    };
  }
}
