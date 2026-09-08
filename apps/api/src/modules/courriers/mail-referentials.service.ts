import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { findLabelConflict, normaliseLabel } from './domain';

/**
 * CRUD des référentiels de paramétrage Docu-Courriers (§14/§16/§17/§18/§19 + natures/objets/
 * confidentialités). Reprend la convention V6 des référentiels : `is_active` (désactivation en
 * lieu de suppression), libellé unique parmi les actifs.
 *
 * Unicité (§16) : la comparaison est **insensible à la casse et aux espaces** (`labelDedupKey`),
 * si bien que « Officiel » et « officiel » ne peuvent plus coexister. La garantie finale est
 * l'index partiel SQL `lower(replace(label, ' ', '')) WHERE is_active` ; le contrôle applicatif
 * ci-dessous ne sert qu'à rendre un 409 lisible au lieu d'une violation de contrainte brute.
 */
@Injectable()
export class MailReferentialsService {
  constructor(private readonly prisma: PrismaService) {}

  private norm(label: string): string {
    return normaliseLabel(label);
  }

  /**
   * Refuse un libellé déjà porté par un actif du même référentiel (comparaison normalisée §16).
   * Les référentiels étant de petites tables, on compare en mémoire — c'est aussi ce que fait le
   * source (`GetAllList()`), et cela reste juste sur les accents là où un `mode: 'insensitive'`
   * Prisma dépendrait de la collation Postgres.
   */
  private async assertLabelFree(
    rows: readonly { id: number; label: string }[],
    label: string,
    excludeId: number | null,
    message: string,
  ): Promise<void> {
    if (findLabelConflict(label, rows, excludeId)) throw new ConflictException(message);
  }

  // ---- Natures (§ référentiel plat) ----------------------------------------
  listNatures() {
    return this.prisma.mailNature.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
    });
  }

  async createNature(label: string) {
    const value = this.norm(label);
    await this.assertNatureLabelFree(value, null);
    return this.prisma.mailNature.create({ data: { label: value } });
  }

  async updateNature(mailNatureId: number, label: string) {
    await this.assertExists(
      await this.prisma.mailNature.findUnique({
        where: { mailNatureId },
        select: { mailNatureId: true },
      }),
      'Nature introuvable',
    );
    const value = this.norm(label);
    await this.assertNatureLabelFree(value, mailNatureId);
    return this.prisma.mailNature.update({ where: { mailNatureId }, data: { label: value } });
  }

  async deactivateNature(mailNatureId: number) {
    await this.prisma.mailNature.update({ where: { mailNatureId }, data: { isActive: false } });
    return { deactivated: true };
  }

  private async assertNatureLabelFree(label: string, excludeId: number | null) {
    const rows = await this.prisma.mailNature.findMany({
      where: { isActive: true },
      select: { mailNatureId: true, label: true },
    });
    await this.assertLabelFree(
      rows.map((r) => ({ id: r.mailNatureId, label: r.label })),
      label,
      excludeId,
      'Une nature active porte déjà ce libellé',
    );
  }

  // ---- Objets (label + durées de suivi) ------------------------------------
  listObjets() {
    return this.prisma.mailObjet.findMany({ where: { isActive: true }, orderBy: { label: 'asc' } });
  }

  async createObjet(input: {
    label: string;
    dureeSuiviExterne?: number;
    dureeSuiviInterne?: number;
  }) {
    const label = this.norm(input.label);
    await this.assertObjetLabelFree(label, null);
    return this.prisma.mailObjet.create({
      data: {
        label,
        dureeSuiviExterne: input.dureeSuiviExterne ?? 0,
        dureeSuiviInterne: input.dureeSuiviInterne ?? 0,
      },
    });
  }

  async updateObjet(
    mailObjetId: number,
    input: { label?: string; dureeSuiviExterne?: number; dureeSuiviInterne?: number },
  ) {
    await this.assertExists(
      await this.prisma.mailObjet.findUnique({
        where: { mailObjetId },
        select: { mailObjetId: true },
      }),
      'Objet introuvable',
    );
    if (input.label !== undefined) {
      await this.assertObjetLabelFree(this.norm(input.label), mailObjetId);
    }
    return this.prisma.mailObjet.update({
      where: { mailObjetId },
      data: {
        ...(input.label !== undefined ? { label: this.norm(input.label) } : {}),
        ...(input.dureeSuiviExterne !== undefined
          ? { dureeSuiviExterne: input.dureeSuiviExterne }
          : {}),
        ...(input.dureeSuiviInterne !== undefined
          ? { dureeSuiviInterne: input.dureeSuiviInterne }
          : {}),
      },
    });
  }

  async deactivateObjet(mailObjetId: number) {
    await this.prisma.mailObjet.update({ where: { mailObjetId }, data: { isActive: false } });
    return { deactivated: true };
  }

  private async assertObjetLabelFree(label: string, excludeId: number | null) {
    const rows = await this.prisma.mailObjet.findMany({
      where: { isActive: true },
      select: { mailObjetId: true, label: true },
    });
    await this.assertLabelFree(
      rows.map((r) => ({ id: r.mailObjetId, label: r.label })),
      label,
      excludeId,
      'Un objet actif porte déjà ce libellé',
    );
  }

  // ---- Types d'imputation (label + suivi) ----------------------------------
  listInputationTypes() {
    return this.prisma.mailInputationType.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
    });
  }

  async createInputationType(input: { label: string; suivi?: boolean }) {
    const label = this.norm(input.label);
    await this.assertInputationTypeLabelFree(label, null);
    return this.prisma.mailInputationType.create({ data: { label, suivi: input.suivi ?? false } });
  }

  private async assertInputationTypeLabelFree(label: string, excludeId: number | null) {
    const rows = await this.prisma.mailInputationType.findMany({
      where: { isActive: true },
      select: { mailInputationTypeId: true, label: true },
    });
    await this.assertLabelFree(
      rows.map((r) => ({ id: r.mailInputationTypeId, label: r.label })),
      label,
      excludeId,
      "Un type d'imputation actif porte déjà ce libellé",
    );
  }

  async updateInputationType(
    mailInputationTypeId: number,
    input: { label?: string; suivi?: boolean },
  ) {
    await this.assertExists(
      await this.prisma.mailInputationType.findUnique({
        where: { mailInputationTypeId },
        select: { mailInputationTypeId: true },
      }),
      "Type d'imputation introuvable",
    );
    if (input.label !== undefined) {
      await this.assertInputationTypeLabelFree(this.norm(input.label), mailInputationTypeId);
    }
    return this.prisma.mailInputationType.update({
      where: { mailInputationTypeId },
      data: {
        ...(input.label !== undefined ? { label: this.norm(input.label) } : {}),
        ...(input.suivi !== undefined ? { suivi: input.suivi } : {}),
      },
    });
  }

  async deactivateInputationType(mailInputationTypeId: number) {
    await this.prisma.mailInputationType.update({
      where: { mailInputationTypeId },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  // ---- Types de courrier départ (§19, référentiel plat) --------------------
  listDepartTypes() {
    return this.prisma.mailDepartType.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
    });
  }

  async createDepartType(label: string) {
    const value = this.norm(label);
    await this.assertDepartTypeLabelFree(value, null);
    return this.prisma.mailDepartType.create({ data: { label: value } });
  }

  private async assertDepartTypeLabelFree(label: string, excludeId: number | null) {
    const rows = await this.prisma.mailDepartType.findMany({
      where: { isActive: true },
      select: { mailDepartTypeId: true, label: true },
    });
    await this.assertLabelFree(
      rows.map((r) => ({ id: r.mailDepartTypeId, label: r.label })),
      label,
      excludeId,
      'Un type de courrier départ actif porte déjà ce libellé',
    );
  }

  async updateDepartType(mailDepartTypeId: number, label: string) {
    await this.assertExists(
      await this.prisma.mailDepartType.findUnique({
        where: { mailDepartTypeId },
        select: { mailDepartTypeId: true },
      }),
      'Type de courrier départ introuvable',
    );
    const value = this.norm(label);
    await this.assertDepartTypeLabelFree(value, mailDepartTypeId);
    return this.prisma.mailDepartType.update({
      where: { mailDepartTypeId },
      data: { label: value },
    });
  }

  async deactivateDepartType(mailDepartTypeId: number) {
    await this.prisma.mailDepartType.update({
      where: { mailDepartTypeId },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  // ---- Confidentialités (§ référentiel plat) -------------------------------
  listConfidentialites() {
    return this.prisma.mailConfidentialite.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
    });
  }

  async createConfidentialite(label: string) {
    const value = this.norm(label);
    await this.assertConfidentialiteLabelFree(value, null);
    return this.prisma.mailConfidentialite.create({ data: { label: value } });
  }

  /** Renommage d'une confidentialité — l'écran de paramétrage l'exposait sans endpoint côté API. */
  async updateConfidentialite(mailConfidentialiteId: number, label: string) {
    await this.assertExists(
      await this.prisma.mailConfidentialite.findUnique({
        where: { mailConfidentialiteId },
        select: { mailConfidentialiteId: true },
      }),
      'Confidentialité introuvable',
    );
    const value = this.norm(label);
    await this.assertConfidentialiteLabelFree(value, mailConfidentialiteId);
    return this.prisma.mailConfidentialite.update({
      where: { mailConfidentialiteId },
      data: { label: value },
    });
  }

  private async assertConfidentialiteLabelFree(label: string, excludeId: number | null) {
    const rows = await this.prisma.mailConfidentialite.findMany({
      where: { isActive: true },
      select: { mailConfidentialiteId: true, label: true },
    });
    await this.assertLabelFree(
      rows.map((r) => ({ id: r.mailConfidentialiteId, label: r.label })),
      label,
      excludeId,
      'Une confidentialité active porte déjà ce libellé',
    );
  }

  async deactivateConfidentialite(mailConfidentialiteId: number) {
    await this.prisma.mailConfidentialite.update({
      where: { mailConfidentialiteId },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  // ---- Types d'entité externe (§16) ----------------------------------------
  listExternalEntityTypes() {
    return this.prisma.externalEntityType.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
    });
  }

  async createExternalEntityType(label: string) {
    const value = this.norm(label);
    await this.assertExternalEntityTypeLabelFree(value, null);
    return this.prisma.externalEntityType.create({ data: { label: value } });
  }

  private async assertExternalEntityTypeLabelFree(label: string, excludeId: number | null) {
    const rows = await this.prisma.externalEntityType.findMany({
      where: { isActive: true },
      select: { externalEntityTypeId: true, label: true },
    });
    await this.assertLabelFree(
      rows.map((r) => ({ id: r.externalEntityTypeId, label: r.label })),
      label,
      excludeId,
      "Un type d'entité externe actif porte déjà ce libellé",
    );
  }

  async updateExternalEntityType(externalEntityTypeId: number, label: string) {
    await this.assertExists(
      await this.prisma.externalEntityType.findUnique({
        where: { externalEntityTypeId },
        select: { externalEntityTypeId: true },
      }),
      "Type d'entité externe introuvable",
    );
    const value = this.norm(label);
    await this.assertExternalEntityTypeLabelFree(value, externalEntityTypeId);
    return this.prisma.externalEntityType.update({
      where: { externalEntityTypeId },
      data: { label: value },
    });
  }

  async deactivateExternalEntityType(externalEntityTypeId: number) {
    await this.prisma.externalEntityType.update({
      where: { externalEntityTypeId },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  // ---- Entités externes / correspondants (§17) -----------------------------
  listExternalEntities() {
    return this.prisma.externalEntity.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
      include: { externalEntityType: { select: { label: true } } },
    });
  }

  createExternalEntity(input: {
    label: string;
    email?: string | null;
    telephone?: string | null;
    externalEntityTypeId?: number | null;
  }) {
    return this.prisma.externalEntity.create({
      data: {
        label: this.norm(input.label),
        email: input.email ?? null,
        telephone: input.telephone ?? null,
        externalEntityTypeId: input.externalEntityTypeId ?? null,
      },
    });
  }

  async updateExternalEntity(
    externalEntityId: number,
    input: {
      label?: string;
      email?: string | null;
      telephone?: string | null;
      externalEntityTypeId?: number | null;
    },
  ) {
    await this.assertExists(
      await this.prisma.externalEntity.findUnique({
        where: { externalEntityId },
        select: { externalEntityId: true },
      }),
      'Entité externe introuvable',
    );
    return this.prisma.externalEntity.update({
      where: { externalEntityId },
      data: {
        ...(input.label !== undefined ? { label: this.norm(input.label) } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.telephone !== undefined ? { telephone: input.telephone } : {}),
        ...(input.externalEntityTypeId !== undefined
          ? { externalEntityTypeId: input.externalEntityTypeId }
          : {}),
      },
    });
  }

  async deactivateExternalEntity(externalEntityId: number) {
    await this.prisma.externalEntity.update({
      where: { externalEntityId },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  // ---- Propriétés personnalisées (EAV, §12/§16) ----------------------------
  listCustomProperties() {
    return this.prisma.externalEntityCustomProperty.findMany({
      where: { isActive: true },
      orderBy: { label: 'asc' },
    });
  }

  async createCustomProperty(label: string) {
    const value = this.norm(label);
    const rows = await this.prisma.externalEntityCustomProperty.findMany({
      where: { isActive: true },
      select: { externalEntityCustomPropertyId: true, label: true },
    });
    await this.assertLabelFree(
      rows.map((r) => ({ id: r.externalEntityCustomPropertyId, label: r.label })),
      value,
      null,
      'Une propriété active porte déjà ce libellé',
    );
    return this.prisma.externalEntityCustomProperty.create({ data: { label: value } });
  }

  async deactivateCustomProperty(externalEntityCustomPropertyId: number) {
    await this.prisma.externalEntityCustomProperty.update({
      where: { externalEntityCustomPropertyId },
      data: { isActive: false },
    });
    return { deactivated: true };
  }

  /** Valeurs EAV d'une entité externe. */
  listCustomValues(externalEntityId: number) {
    return this.prisma.externalEntityCustomValue.findMany({
      where: { externalEntityId },
      include: { customProperty: { select: { label: true } } },
    });
  }

  /**
   * Pose/écrase (upsert) la valeur d'une propriété pour une entité externe (une valeur par
   * propriété). Le type est **déduit de l'entité** (comme le source), jamais fourni par le client.
   *
   * `external_entity_custom_value.external_entity_type_id` est NOT NULL alors que
   * `external_entity.external_entity_type_id` est nullable : une entité sans type ne peut donc
   * porter aucune métadonnée. On le dit explicitement plutôt que de laisser remonter une violation
   * de clé étrangère en 500.
   */
  async setCustomValue(input: {
    externalEntityId: number;
    externalEntityCustomPropertyId: number;
    value: string;
  }) {
    const entity = await this.prisma.externalEntity.findUnique({
      where: { externalEntityId: input.externalEntityId },
      select: { externalEntityTypeId: true, label: true },
    });
    await this.assertExists(entity, 'Entité externe introuvable');
    if (entity?.externalEntityTypeId == null) {
      throw new ConflictException(
        `« ${entity?.label} » n'a pas de type d'entité externe : impossible d'enregistrer une métadonnée.`,
      );
    }
    return this.prisma.externalEntityCustomValue.upsert({
      where: {
        ux_eecv_entity_property: {
          externalEntityId: input.externalEntityId,
          externalEntityCustomPropertyId: input.externalEntityCustomPropertyId,
        },
      },
      update: { value: input.value, externalEntityTypeId: entity.externalEntityTypeId },
      create: { ...input, externalEntityTypeId: entity.externalEntityTypeId },
    });
  }

  private async assertExists<T>(row: T | null, message: string): Promise<void> {
    if (!row) throw new NotFoundException(message);
  }
}
