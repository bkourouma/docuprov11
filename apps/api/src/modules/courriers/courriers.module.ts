import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { DashboardLayoutService } from './dashboard-layout.service';
import { MailsController } from './mails.controller';
import { MailInputationsController } from './mail-inputations.controller';
import { MailDocumentsController } from './mail-documents.controller';
import { MailReferentialsController } from './mail-referentials.controller';
import { OrganigrammeController } from './organigramme.controller';
import { MailsService } from './mails.service';
import { MailInputationsService } from './mail-inputations.service';
import { MailDocumentsService } from './mail-documents.service';
import { MailReferentialsService } from './mail-referentials.service';
import { OrganigrammeService } from './organigramme.service';
import { MailSearchService } from './mail-search.service';
import { MailScannedDocumentsService } from './mail-scanned.service';
import { MailFicheService } from './mail-fiche.service';
import { MailAiExtractionService } from './mail-ai-extraction.service';

/**
 * Module Docu-Courriers. AuthModule fournit MenuPermissionGuard (@RequireMenu). PrismaService
 * (@Global) et HierarchyService (@Global via CommonModule) sont disponibles sans import.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  // Ordre important : MailsController porte la route paramétrée greedy `courriers/:id`. Les
  // contrôleurs à sous-chemins littéraux (referentials, organigramme) et les routes imputations/
  // documents sont enregistrés AVANT, sinon `GET courriers/organigramme` serait capté par `:id`.
  controllers: [
    MailReferentialsController,
    OrganigrammeController,
    DashboardController,
    MailInputationsController,
    MailDocumentsController,
    MailsController,
  ],
  providers: [
    DashboardService,
    DashboardLayoutService,
    MailsService,
    MailInputationsService,
    MailDocumentsService,
    MailReferentialsService,
    OrganigrammeService,
    MailSearchService,
    MailScannedDocumentsService,
    MailFicheService,
    MailAiExtractionService,
  ],
  exports: [
    DashboardService,
    DashboardLayoutService,
    MailsService,
    MailInputationsService,
    MailDocumentsService,
    MailReferentialsService,
    OrganigrammeService,
    MailSearchService,
    MailScannedDocumentsService,
    MailFicheService,
  ],
})
export class CourriersModule {}
