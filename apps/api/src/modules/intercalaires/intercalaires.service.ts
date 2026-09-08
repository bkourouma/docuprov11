import { BadRequestException, Injectable } from '@nestjs/common';
import { formatPayload, generateQrPng, type IntercalaireCategoryCode } from '@archivage/qr';
import { composeIntercalairesPdf, type IntercalaireSheet } from '@archivage/pdf';
import { PrismaService } from '../prisma/prisma.service';

export interface SelectableItem {
  id: number;
  label: string;
  code: string | null;
  parentId: number | null;
  depth: number;
  hasChildren: boolean;
}

interface FlatRow {
  id: number;
  label: string;
  code: string | null;
  parentId: number | null;
  depth: number;
}

function toTree(rows: FlatRow[]): SelectableItem[] {
  const childCount = new Map<number, number>();
  for (const r of rows) {
    if (r.parentId != null) childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
  }
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    code: r.code,
    parentId: r.parentId,
    depth: r.depth,
    hasChildren: (childCount.get(r.id) ?? 0) > 0,
  }));
}

@Injectable()
export class IntercalairesService {
  constructor(private readonly prisma: PrismaService) {}

  async listCategories() {
    const cats = await this.prisma.intercalaireCategory.findMany({
      orderBy: { intercalaireCategoryId: 'asc' },
    });
    return cats.map((c) => ({
      code: c.categoryCode,
      label: c.label,
      isBlank: c.isBlank,
      targetTable: c.targetTable,
      targetColumn: c.targetColumn,
    }));
  }

  /** Elements for a category — flat for type, indented tree (ordered by path) for plan/location/dossier. */
  async listItems(category: string): Promise<SelectableItem[]> {
    switch (category) {
      case 'TYPE_DOCUMENT': {
        const rows = await this.prisma.documentType.findMany({
          where: { isActive: true },
          orderBy: { label: 'asc' },
        });
        return rows.map((r) => ({
          id: r.documentTypeId,
          label: r.label,
          code: r.code,
          parentId: null,
          depth: 0,
          hasChildren: false,
        }));
      }
      case 'PLAN': {
        const rows = await this.prisma.classificationPlan.findMany({
          where: { isActive: true },
          orderBy: { path: 'asc' },
        });
        return toTree(
          rows.map((r) => ({ id: r.planId, label: r.label, code: r.code, parentId: r.parentId, depth: r.depth })),
        );
      }
      case 'LOCALISATION': {
        const rows = await this.prisma.location.findMany({
          where: { isActive: true },
          orderBy: { path: 'asc' },
        });
        return toTree(
          rows.map((r) => ({ id: r.locationId, label: r.label, code: r.code, parentId: r.parentId, depth: r.depth })),
        );
      }
      case 'DOSSIER': {
        const rows = await this.prisma.dossier.findMany({
          where: { isActive: true },
          orderBy: { path: 'asc' },
        });
        return toTree(
          rows.map((r) => ({ id: r.dossierId, label: r.label, code: r.code, parentId: r.parentId, depth: r.depth })),
        );
      }
      case 'BLANK':
        return [];
      default:
        throw new BadRequestException('Catégorie inconnue');
    }
  }

  /** Build the printable PDF: one A4 page per selected element (FR-004..007). */
  async generate(category: string, itemIds: number[]): Promise<Uint8Array> {
    const cat = await this.prisma.intercalaireCategory.findUnique({
      where: { categoryCode: category },
    });
    if (!cat) throw new BadRequestException('Catégorie inconnue');

    const sheets: IntercalaireSheet[] = [];

    if (cat.isBlank) {
      sheets.push({
        categoryLabel: cat.label,
        itemLabel: '(séparateur vierge)',
        qrPng: await generateQrPng(formatPayload('BLANK', 0)),
      });
    } else {
      if (itemIds.length === 0) {
        throw new BadRequestException('Sélection vide : aucun élément sélectionné');
      }
      const labels = await this.resolveLabels(category, itemIds);
      for (const id of itemIds) {
        const label = labels.get(id);
        if (label == null) continue;
        sheets.push({
          categoryLabel: cat.label,
          itemLabel: label,
          qrPng: await generateQrPng(formatPayload(category as IntercalaireCategoryCode, id)),
        });
      }
      if (sheets.length === 0) {
        throw new BadRequestException('Aucun élément valide pour la catégorie');
      }
    }

    return composeIntercalairesPdf(sheets);
  }

  private async resolveLabels(category: string, ids: number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (category === 'TYPE_DOCUMENT') {
      (await this.prisma.documentType.findMany({ where: { documentTypeId: { in: ids } } })).forEach((r) =>
        map.set(r.documentTypeId, r.label),
      );
    } else if (category === 'PLAN') {
      (await this.prisma.classificationPlan.findMany({ where: { planId: { in: ids } } })).forEach((r) =>
        map.set(r.planId, r.label),
      );
    } else if (category === 'LOCALISATION') {
      (await this.prisma.location.findMany({ where: { locationId: { in: ids } } })).forEach((r) =>
        map.set(r.locationId, r.label),
      );
    } else if (category === 'DOSSIER') {
      (await this.prisma.dossier.findMany({ where: { dossierId: { in: ids } } })).forEach((r) =>
        map.set(r.dossierId, r.label),
      );
    }
    return map;
  }
}
