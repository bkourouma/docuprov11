import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { findLabelConflict, labelDedupKey, normaliseLabel } from './domain';
import type {
  CreateMetaDataListItemsDto,
  CreateMetaDatasDto,
  DocumentLifeCycleDto,
  DocumentTypeLifeCycleDto,
  DocumentTypeSettingDto,
  LinkMetaDataDocumentTypesDto,
  SetMetaDatasForTypeDto,
  UpdateMetaDataDto,
  UpdateMetaDataListItemDto,
} from './archives.dto';

/**
 * Résultat d'une création en masse (`CreateMultipleNodes` du source). L'écran envoie plusieurs
 * libellés d'un coup ; échouer en bloc sur un seul doublon ferait perdre la saisie entière, on
 * crée donc ce qui peut l'être et on rend compte du reste.
 */
export interface BulkCreateResult {
  created: number;
  /** Libellés ignorés parce que déjà portés par un actif (ou en double dans le lot). */
  skipped: string[];
}

/**
 * Paramétrage Docu-Archives : paramétrage des types de documents, cycles de vie, référentiels du
 * cycle de vie (modes de destruction, sorts finaux, motifs de prêt) et métadonnées dynamiques.
 *
 * Conventions V6 reprises de `MailReferentialsService` :
 *  - désactivation (`is_active = false`) au lieu de suppression : les documents déjà classés
 *    gardent un libellé lisible ;
 *  - unicité du libellé parmi les ACTIFS, insensible à la casse et aux espaces (`labelDedupKey`),
 *    miroir applicatif des index SQL partiels — le contrôle ici ne sert qu'à rendre un 409
 *    lisible au lieu d'une violation de contrainte brute.
 *
 * « Gestion des dossiers » (§2 de la documentation source) n'est PAS ici : l'arborescence des
 * dossiers existe déjà en V6 (`ReferentialsService`, menu /admin/dossiers) et sert déjà à
 * l'acquisition comme à la communication de documents. La redoubler créerait deux référentiels
 * concurrents.
 */
@Injectable()
export class ArchivesSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  // =========================================================================
  // Référentiels plats : modes de destruction, sorts finaux, motifs de prêt
  // =========================================================================

  listDestructionModes() {
    return this.prisma.destructionMode.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
    });
  }

  createDestructionModes(labels: string[]): Promise<BulkCreateResult> {
    return this.bulkCreate(labels, {
      existing: async () =>
        (
          await this.prisma.destructionMode.findMany({
            where: { isActive: true },
            select: { destructionModeId: true, label: true },
          })
        ).map((r) => ({ id: r.destructionModeId, label: r.label })),
      create: (label) => this.prisma.destructionMode.create({ data: { label } }).then(() => undefined),
    });
  }

  async updateDestructionMode(destructionModeId: number, label: string) {
    await this.assertFound(
      await this.prisma.destructionMode.findUnique({ where: { destructionModeId } }),
      'Mode de destruction introuvable',
    );
    const value = normaliseLabel(label);
    await this.assertLabelFree(
      (
        await this.prisma.destructionMode.findMany({
          where: { isActive: true },
          select: { destructionModeId: true, label: true },
        })
      ).map((r) => ({ id: r.destructionModeId, label: r.label })),
      value,
      destructionModeId,
      'Un mode de destruction actif porte déjà ce libellé',
    );
    return this.prisma.destructionMode.update({ where: { destructionModeId }, data: { label: value } });
  }

  async deactivateDestructionModes(ids: number[]) {
    const { count } = await this.prisma.destructionMode.updateMany({
      where: { destructionModeId: { in: ids } },
      data: { isActive: false },
    });
    return { deactivated: count };
  }

  listFinalFates() {
    return this.prisma.finalFate.findMany({ where: { isActive: true }, orderBy: { label: 'asc' } });
  }

  createFinalFates(labels: string[]): Promise<BulkCreateResult> {
    return this.bulkCreate(labels, {
      existing: async () =>
        (
          await this.prisma.finalFate.findMany({
            where: { isActive: true },
            select: { finalFateId: true, label: true },
          })
        ).map((r) => ({ id: r.finalFateId, label: r.label })),
      create: (label) => this.prisma.finalFate.create({ data: { label } }).then(() => undefined),
    });
  }

  async updateFinalFate(finalFateId: number, label: string) {
    await this.assertFound(
      await this.prisma.finalFate.findUnique({ where: { finalFateId } }),
      'Sort final introuvable',
    );
    const value = normaliseLabel(label);
    await this.assertLabelFree(
      (
        await this.prisma.finalFate.findMany({
          where: { isActive: true },
          select: { finalFateId: true, label: true },
        })
      ).map((r) => ({ id: r.finalFateId, label: r.label })),
      value,
      finalFateId,
      'Un sort final actif porte déjà ce libellé',
    );
    return this.prisma.finalFate.update({ where: { finalFateId }, data: { label: value } });
  }

  async deactivateFinalFates(ids: number[]) {
    const { count } = await this.prisma.finalFate.updateMany({
      where: { finalFateId: { in: ids } },
      data: { isActive: false },
    });
    return { deactivated: count };
  }

  listLendingMotives() {
    return this.prisma.lendingMotive.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
    });
  }

  createLendingMotives(labels: string[]): Promise<BulkCreateResult> {
    return this.bulkCreate(labels, {
      existing: async () =>
        (
          await this.prisma.lendingMotive.findMany({
            where: { isActive: true },
            select: { lendingMotiveId: true, label: true },
          })
        ).map((r) => ({ id: r.lendingMotiveId, label: r.label })),
      create: (label) => this.prisma.lendingMotive.create({ data: { label } }).then(() => undefined),
    });
  }

  async updateLendingMotive(lendingMotiveId: number, label: string) {
    await this.assertFound(
      await this.prisma.lendingMotive.findUnique({ where: { lendingMotiveId } }),
      'Motif de prêt introuvable',
    );
    const value = normaliseLabel(label);
    await this.assertLabelFree(
      (
        await this.prisma.lendingMotive.findMany({
          where: { isActive: true },
          select: { lendingMotiveId: true, label: true },
        })
      ).map((r) => ({ id: r.lendingMotiveId, label: r.label })),
      value,
      lendingMotiveId,
      'Un motif de prêt actif porte déjà ce libellé',
    );
    return this.prisma.lendingMotive.update({ where: { lendingMotiveId }, data: { label: value } });
  }

  async deactivateLendingMotives(ids: number[]) {
    const { count } = await this.prisma.lendingMotive.updateMany({
      where: { lendingMotiveId: { in: ids } },
      data: { isActive: false },
    });
    return { deactivated: count };
  }

  // =========================================================================
  // §1 — Paramétrage des types de documents
  // =========================================================================

  /**
   * Liste des paramétrages avec les libellés résolus, comme l'écran source. Les types de documents
   * SANS paramétrage ne sont pas inventés ici : l'écran les propose dans son formulaire de
   * création, la liste ne montre que ce qui est réellement paramétré.
   */
  listDocumentTypeSettings() {
    return this.prisma.documentTypeSetting.findMany({
      include: {
        documentType: { select: { documentTypeId: true, label: true } },
        dossier: { select: { label: true, code: true } },
        plan: { select: { label: true, code: true } },
        confidentialite: { select: { label: true } },
      },
      orderBy: { documentType: { label: 'asc' } },
    });
  }

  /**
   * Crée OU met à jour le paramétrage d'un type (le source distinguait les deux par la présence
   * d'un `id` ; ici la clé métier est le type lui-même, `document_type_id` étant unique).
   */
  async saveDocumentTypeSetting(input: DocumentTypeSettingDto) {
    await this.assertFound(
      await this.prisma.documentType.findUnique({ where: { documentTypeId: input.documentTypeId } }),
      'Type de document introuvable',
    );
    const data = {
      dossierId: input.dossierId ?? null,
      planId: input.planId ?? null,
      confidentialiteId: input.confidentialiteId ?? null,
      // Consigne de numérisation : les booléens ont un défaut (`false`), les autres sont vidables.
      ocr: input.ocr ?? false,
      cryptage: input.cryptage ?? false,
      tauxCompression: input.tauxCompression ?? null,
      profilScanner: input.profilScanner?.trim() || null,
      routines: input.routines?.trim() || null,
    };
    return this.prisma.documentTypeSetting.upsert({
      where: { documentTypeId: input.documentTypeId },
      create: { documentTypeId: input.documentTypeId, ...data },
      update: data,
    });
  }

  async deleteDocumentTypeSettings(ids: number[]) {
    const { count } = await this.prisma.documentTypeSetting.deleteMany({
      where: { documentTypeSettingId: { in: ids } },
    });
    return { deleted: count };
  }

  /**
   * Défauts d'archivage d'un type — c'est la RAISON D'ÊTRE du paramétrage : pré-remplir le
   * formulaire d'indexation. Renvoie `null` si le type n'est pas paramétré, à charge de
   * l'appelant de ne rien pré-remplir.
   */
  getDefaultsForDocumentType(documentTypeId: number) {
    return this.prisma.documentTypeSetting.findUnique({ where: { documentTypeId } });
  }

  // =========================================================================
  // §3 — Cycles de vie
  // =========================================================================

  listDocumentTypeLifeCycles() {
    return this.prisma.documentTypeLifeCycle.findMany({
      include: {
        documentType: { select: { documentTypeId: true, label: true } },
        finalFate: { select: { label: true } },
        destructionMode: { select: { label: true } },
      },
      orderBy: { documentType: { label: 'asc' } },
    });
  }

  /** Crée ou met à jour la règle de conservation d'un type (une règle par type). */
  async saveDocumentTypeLifeCycle(input: DocumentTypeLifeCycleDto) {
    await this.assertFound(
      await this.prisma.documentType.findUnique({ where: { documentTypeId: input.documentTypeId } }),
      'Type de document introuvable',
    );
    const data = {
      usefulnessLifespan: input.usefulnessLifespan,
      complianceLifespan: input.complianceLifespan,
      finalFateId: input.finalFateId ?? null,
      destructionModeId: input.destructionModeId ?? null,
    };
    return this.prisma.documentTypeLifeCycle.upsert({
      where: { documentTypeId: input.documentTypeId },
      create: { documentTypeId: input.documentTypeId, ...data },
      update: data,
    });
  }

  async deleteDocumentTypeLifeCycles(ids: number[]) {
    const { count } = await this.prisma.documentTypeLifeCycle.deleteMany({
      where: { documentTypeLifeCycleId: { in: ids } },
    });
    return { deleted: count };
  }

  /**
   * Cycle de vie propre à un document (saisi depuis la visionneuse) : il l'emporte sur la règle de
   * son type. `createdBy` trace l'auteur de la dérogation — c'est une décision de conservation.
   */
  async saveDocumentLifeCycle(input: DocumentLifeCycleDto, userGroupId: number | null) {
    await this.assertFound(
      await this.prisma.document.findUnique({ where: { documentId: input.documentId } }),
      'Document introuvable',
    );
    const data = {
      usefulnessLifespan: new Date(`${input.usefulnessLifespan}T00:00:00.000Z`),
      complianceLifespan: new Date(`${input.complianceLifespan}T00:00:00.000Z`),
      observations: input.observations?.trim() || null,
      finalFateId: input.finalFateId ?? null,
      destructionModeId: input.destructionModeId ?? null,
    };
    return this.prisma.documentLifeCycle.upsert({
      where: { documentId: input.documentId },
      create: { documentId: input.documentId, createdBy: userGroupId, ...data },
      update: { ...data, modifiedAt: new Date() },
    });
  }

  getDocumentLifeCycle(documentId: number) {
    return this.prisma.documentLifeCycle.findUnique({
      where: { documentId },
      include: {
        finalFate: { select: { label: true } },
        destructionMode: { select: { label: true } },
      },
    });
  }

  // =========================================================================
  // §8 — Métadonnées
  // =========================================================================

  /**
   * Métadonnées + nombre de valeurs de liste ACTIVES. Le compte est fait par un `groupBy` plutôt
   * que par un `_count` de relation : un `_count` ne saurait pas exclure les valeurs désactivées,
   * et l'écran afficherait « 5 valeurs » pour une liste qui n'en propose plus que deux.
   */
  async listMetaDatas() {
    const [rows, counts] = await Promise.all([
      this.prisma.metaData.findMany({ where: { isActive: true }, orderBy: { label: 'asc' } }),
      this.prisma.metaDataListItem.groupBy({
        by: ['metaDataId'],
        where: { isActive: true },
        _count: { _all: true },
      }),
    ]);
    const byId = new Map(counts.map((c) => [c.metaDataId, c._count._all]));
    return rows.map((r) => ({ ...r, listItemCount: byId.get(r.metaDataId) ?? 0 }));
  }

  /** Création en masse (`CreateMultipleMetaDatas`) : libellé + type de saisie par ligne. */
  async createMetaDatas(input: CreateMetaDatasDto): Promise<BulkCreateResult> {
    const existing = (
      await this.prisma.metaData.findMany({
        where: { isActive: true },
        select: { metaDataId: true, label: true },
      })
    ).map((r) => ({ id: r.metaDataId, label: r.label }));

    const seen = new Set(existing.map((r) => labelDedupKey(r.label)));
    const skipped: string[] = [];
    let created = 0;
    for (const item of input.metaDatas) {
      const value = normaliseLabel(item.label);
      const key = labelDedupKey(value);
      if (seen.has(key)) {
        skipped.push(value);
        continue;
      }
      seen.add(key);
      await this.prisma.metaData.create({ data: { label: value, dataType: item.dataType } });
      created += 1;
    }
    return { created, skipped };
  }

  async updateMetaData(metaDataId: number, input: UpdateMetaDataDto) {
    await this.assertFound(
      await this.prisma.metaData.findUnique({ where: { metaDataId } }),
      'Métadonnée introuvable',
    );
    if (input.label !== undefined) {
      await this.assertLabelFree(
        (
          await this.prisma.metaData.findMany({
            where: { isActive: true },
            select: { metaDataId: true, label: true },
          })
        ).map((r) => ({ id: r.metaDataId, label: r.label })),
        normaliseLabel(input.label),
        metaDataId,
        'Une métadonnée active porte déjà ce libellé',
      );
    }
    return this.prisma.metaData.update({
      where: { metaDataId },
      data: {
        ...(input.label !== undefined ? { label: normaliseLabel(input.label) } : {}),
        ...(input.dataType !== undefined ? { dataType: input.dataType } : {}),
      },
    });
  }

  async deactivateMetaDatas(ids: number[]) {
    const { count } = await this.prisma.metaData.updateMany({
      where: { metaDataId: { in: ids } },
      data: { isActive: false },
    });
    return { deactivated: count };
  }

  // =========================================================================
  // §9 — Éléments des listes
  // =========================================================================

  /** `metaDataId` filtre sur une métadonnée ; sans lui, tous les éléments avec leur métadonnée. */
  listMetaDataListItems(metaDataId?: number) {
    return this.prisma.metaDataListItem.findMany({
      where: { isActive: true, ...(metaDataId ? { metaDataId } : {}) },
      include: { metaData: { select: { metaDataId: true, label: true, dataType: true } } },
      orderBy: [{ metaData: { label: 'asc' } }, { label: 'asc' }],
    });
  }

  /** Création en masse des valeurs d'une même métadonnée (§9). */
  async createMetaDataListItems(input: CreateMetaDataListItemsDto): Promise<BulkCreateResult> {
    await this.assertFound(
      await this.prisma.metaData.findUnique({ where: { metaDataId: input.metaDataId } }),
      'Métadonnée introuvable',
    );
    return this.bulkCreate(input.labels, {
      existing: async () =>
        (
          await this.prisma.metaDataListItem.findMany({
            where: { isActive: true, metaDataId: input.metaDataId },
            select: { metaDataListItemId: true, label: true },
          })
        ).map((r) => ({ id: r.metaDataListItemId, label: r.label })),
      create: (label) =>
        this.prisma.metaDataListItem
          .create({ data: { label, metaDataId: input.metaDataId } })
          .then(() => undefined),
    });
  }

  async updateMetaDataListItem(metaDataListItemId: number, input: UpdateMetaDataListItemDto) {
    const row = await this.prisma.metaDataListItem.findUnique({ where: { metaDataListItemId } });
    await this.assertFound(row, 'Élément de liste introuvable');
    const metaDataId = input.metaDataId ?? row!.metaDataId;
    if (input.label !== undefined || input.metaDataId !== undefined) {
      await this.assertLabelFree(
        (
          await this.prisma.metaDataListItem.findMany({
            where: { isActive: true, metaDataId },
            select: { metaDataListItemId: true, label: true },
          })
        ).map((r) => ({ id: r.metaDataListItemId, label: r.label })),
        normaliseLabel(input.label ?? row!.label),
        metaDataListItemId,
        'Cette métadonnée a déjà une valeur portant ce libellé',
      );
    }
    return this.prisma.metaDataListItem.update({
      where: { metaDataListItemId },
      data: {
        ...(input.label !== undefined ? { label: normaliseLabel(input.label) } : {}),
        ...(input.metaDataId !== undefined ? { metaDataId: input.metaDataId } : {}),
      },
    });
  }

  async deactivateMetaDataListItems(ids: number[]) {
    const { count } = await this.prisma.metaDataListItem.updateMany({
      where: { metaDataListItemId: { in: ids } },
      data: { isActive: false },
    });
    return { deactivated: count };
  }

  // =========================================================================
  // §7 — Métadonnées par type de document
  // =========================================================================

  listMetaDataDocumentTypes() {
    return this.prisma.metaDataDocumentType.findMany({
      include: {
        documentType: { select: { documentTypeId: true, label: true } },
        metaData: { select: { metaDataId: true, label: true, dataType: true } },
      },
      orderBy: [{ documentType: { label: 'asc' } }, { metaData: { label: 'asc' } }],
    });
  }

  /**
   * Récapitulatif groupé par type — le source rendait ce regroupement en HTML côté serveur ; on
   * renvoie ici la structure et c'est l'écran qui la met en forme.
   */
  async summaryByDocumentType() {
    const rows = await this.listMetaDataDocumentTypes();
    const byType = new Map<
      number,
      { documentTypeId: number; documentType: string; metaDatas: Array<{ metaDataId: number; label: string; dataType: number }> }
    >();
    for (const r of rows) {
      const entry = byType.get(r.documentTypeId) ?? {
        documentTypeId: r.documentTypeId,
        documentType: r.documentType.label,
        metaDatas: [],
      };
      entry.metaDatas.push({
        metaDataId: r.metaData.metaDataId,
        label: r.metaData.label,
        dataType: r.metaData.dataType,
      });
      byType.set(r.documentTypeId, entry);
    }
    return [...byType.values()];
  }

  /**
   * Produit cartésien types × métadonnées (`CreateMultipleNodes` du source). Les couples déjà
   * présents ne font PAS échouer l'opération : ils sont comptés et renvoyés, comme l'avertissement
   * non bloquant du source.
   */
  async linkMetaDataDocumentTypes(input: LinkMetaDataDocumentTypesDto) {
    const { count } = await this.prisma.metaDataDocumentType.createMany({
      data: input.documentTypeIds.flatMap((documentTypeId) =>
        input.metaDataIds.map((metaDataId) => ({ documentTypeId, metaDataId })),
      ),
      skipDuplicates: true,
    });
    const requested = input.documentTypeIds.length * input.metaDataIds.length;
    return { created: count, alreadyLinked: requested - count };
  }

  /**
   * Remplace la liste des métadonnées d'UN type (`UpdateMetaDataForDocumentType`) : ce qui n'est
   * plus demandé est délié. Une transaction, pour ne pas laisser le type sans métadonnées si la
   * ré-association échoue.
   */
  async setMetaDatasForType(input: SetMetaDatasForTypeDto) {
    await this.assertFound(
      await this.prisma.documentType.findUnique({ where: { documentTypeId: input.documentTypeId } }),
      'Type de document introuvable',
    );
    return this.prisma.$transaction(async (tx) => {
      await tx.metaDataDocumentType.deleteMany({
        where: { documentTypeId: input.documentTypeId, metaDataId: { notIn: input.metaDataIds } },
      });
      const { count } = await tx.metaDataDocumentType.createMany({
        data: input.metaDataIds.map((metaDataId) => ({
          documentTypeId: input.documentTypeId,
          metaDataId,
        })),
        skipDuplicates: true,
      });
      return { linked: input.metaDataIds.length, created: count };
    });
  }

  async unlinkMetaDataDocumentTypes(ids: number[]) {
    const { count } = await this.prisma.metaDataDocumentType.deleteMany({
      where: { metaDataDocumentTypeId: { in: ids } },
    });
    return { deleted: count };
  }

  /**
   * Métadonnées attendues pour un type — l'usage aval du §7 : c'est ce qui construit le formulaire
   * dynamique d'indexation. Les valeurs des métadonnées de type Liste sont jointes.
   */
  async formFieldsForDocumentType(documentTypeId: number) {
    const links = await this.prisma.metaDataDocumentType.findMany({
      where: { documentTypeId, metaData: { isActive: true } },
      include: {
        metaData: {
          include: {
            listItems: { where: { isActive: true }, orderBy: { label: 'asc' } },
          },
        },
      },
      orderBy: { metaData: { label: 'asc' } },
    });
    return links.map((l) => ({
      metaDataId: l.metaData.metaDataId,
      label: l.metaData.label,
      dataType: l.metaData.dataType,
      options: l.metaData.listItems.map((i) => ({
        metaDataListItemId: i.metaDataListItemId,
        label: i.label,
      })),
    }));
  }

  // =========================================================================
  // Fabrique commune
  // =========================================================================

  /**
   * Création en masse dédoublonnée : ignore les libellés déjà portés par un actif ET les doublons
   * internes au lot (« Prêt » saisi deux fois ne crée qu'une ligne). Séquentiel à dessein — les
   * référentiels sont de petites tables et l'ordre de création reste lisible dans la liste.
   */
  private async bulkCreate(
    labels: string[],
    ops: {
      existing: () => Promise<Array<{ id: number; label: string }>>;
      create: (label: string) => Promise<void>;
    },
  ): Promise<BulkCreateResult> {
    const seen = new Set((await ops.existing()).map((r) => labelDedupKey(r.label)));
    const skipped: string[] = [];
    let created = 0;
    for (const raw of labels) {
      const value = normaliseLabel(raw);
      const key = labelDedupKey(value);
      if (seen.has(key)) {
        skipped.push(value);
        continue;
      }
      seen.add(key);
      await ops.create(value);
      created += 1;
    }
    return { created, skipped };
  }

  private async assertLabelFree(
    rows: readonly { id: number; label: string }[],
    label: string,
    excludeId: number | null,
    message: string,
  ): Promise<void> {
    if (findLabelConflict(label, rows, excludeId)) throw new ConflictException(message);
  }

  private async assertFound<T>(row: T | null, message: string): Promise<void> {
    if (!row) throw new NotFoundException(message);
  }
}
