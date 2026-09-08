import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface NavigationEntry {
  userGroupId?: number | null;
  activity?: string;
  url?: string;
  menuId?: number;
  actorFullName?: string;
  actorRole?: string;
  actorService?: string;
  ipAddress?: string;
  machineName?: string;
}

export interface DataChangeEntry {
  userGroupId?: number | null;
  /**
   * Nom de l'acteur FIGE a l'ecriture. `userGroupId` est nullable et le compte peut changer de
   * groupe (ou disparaitre) : sans cette copie, le journal perd son auteur.
   */
  actorFullName?: string | null;
  auditActionId?: number | null;
  objectRef?: string;
  oldValue?: string;
  newValue?: string;
}

/** Writes the two audit journals (FR-033/FR-035). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async navigation(entry: NavigationEntry): Promise<void> {
    await this.prisma.navigationAudit.create({ data: entry });
  }

  async dataChange(entry: DataChangeEntry): Promise<void> {
    await this.prisma.dataChangeAudit.create({ data: entry });
  }
}
