import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ArchivesController } from './archives.controller';
import { ArchivesComplianceService } from './archives-compliance.service';
import { ArchivesLendingService } from './archives-lending.service';
import { ArchivesSettingsController } from './archives-settings.controller';
import { ArchivesSettingsService } from './archives-settings.service';

/**
 * Docu-Archives : cycle de vie documentaire (DUA, sorts finaux, modes de destruction),
 * métadonnées dynamiques et communication / prêt de documents.
 *
 * `ArchivesSettingsService` est EXPORTÉ : le paramétrage par type de document (défauts
 * d'archivage, métadonnées attendues) a vocation à être consommé par l'acquisition et
 * l'indexation, pas seulement par ses propres écrans.
 */
@Module({
  imports: [AuthModule],
  controllers: [ArchivesSettingsController, ArchivesController],
  providers: [ArchivesSettingsService, ArchivesComplianceService, ArchivesLendingService],
  exports: [ArchivesSettingsService],
})
export class ArchivesModule {}
