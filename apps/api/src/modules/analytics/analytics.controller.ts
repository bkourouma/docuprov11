import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { exportRows } from '@archivage/exports';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import type { AuthUser } from '../auth/auth.types';
import { MENU_DASHBOARD_ARCHIVES } from '../roles/menu-catalog';
import { AnalyticsService } from './analytics.service';
import { DashboardLayoutService, type AgencementResponse } from './dashboard-layout.service';
import {
  agencementSchema,
  analyticsExportSchema,
  analyticsFilterSchema,
  analyticsTargetsSchema,
  type AgencementDto,
  type AnalyticsExportDto,
  type AnalyticsFilterDto,
  type AnalyticsTargetsDto,
} from './analytics.dto';

@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly layout: DashboardLayoutService,
  ) {}

  // ---------------------------------------------------------------------------
  // Agencement personnalisable (widgets placés par l'utilisateur)
  //
  // Le garde est posé MÉTHODE par MÉTHODE, et non sur la classe : `overview`, `targets` et
  // `export` sont consommés au-delà de l'écran « Tableaux de bord » (page d'accueil comprise), et
  // les soumettre d'un coup à `@RequireMenu` retirerait l'accès à des utilisateurs qui l'ont
  // aujourd'hui. Seul l'agencement, propre à cet écran, exige d'y avoir accès.
  // ---------------------------------------------------------------------------

  /**
   * Agencement de l'utilisateur courant, widgets re-filtrés par permission, plus le catalogue
   * de ce qu'il peut encore ajouter.
   */
  @Get('layout')
  @UseGuards(MenuPermissionGuard)
  @RequireMenu(MENU_DASHBOARD_ARCHIVES)
  getLayout(@CurrentUser() user: AuthUser): Promise<AgencementResponse> {
    return this.layout.getForUser(user);
  }

  /** Enregistre l'agencement. Le service borne les positions et refuse les widgets non autorisés. */
  @Put('layout')
  @UseGuards(MenuPermissionGuard)
  @RequireMenu(MENU_DASHBOARD_ARCHIVES)
  saveLayout(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(agencementSchema)) corps: AgencementDto,
  ): Promise<AgencementResponse> {
    return this.layout.save(user, corps.widgets);
  }

  /** Retour à l'agencement livré : supprime le réglage, ne le remplace pas. */
  @Delete('layout')
  @UseGuards(MenuPermissionGuard)
  @RequireMenu(MENU_DASHBOARD_ARCHIVES)
  resetLayout(@CurrentUser() user: AuthUser): Promise<AgencementResponse> {
    return this.layout.reset(user);
  }

  /** Agrégat « Vue d'ensemble ». Lecture seule, ACL-filtré (admin = vue complète). */
  @Post('overview')
  @HttpCode(200)
  overview(
    @Body(new ZodValidationPipe(analyticsFilterSchema)) body: AnalyticsFilterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.analytics.overview(body, user);
  }

  /** Cibles « objectif vs réalisé » d'une période (lecture seule, ACL-filtré). */
  @Post('targets')
  @HttpCode(200)
  targets(
    @Body(new ZodValidationPipe(analyticsTargetsSchema)) body: AnalyticsTargetsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.analytics.targets(body, user);
  }

  /** Export de la synthèse, cohérent avec les filtres courants. */
  @Post('export')
  @HttpCode(200)
  async export(
    @Body(new ZodValidationPipe(analyticsExportSchema)) body: AnalyticsExportDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StreamableFile> {
    const rows = await this.analytics.overviewRows(body, user);
    const { buffer, contentType, filename } = await exportRows(body.format, {
      title: 'Tableau de bord — synthèse',
      columns: [
        { key: 'section', header: 'Section' },
        { key: 'libelle', header: 'Libellé' },
        { key: 'valeur', header: 'Valeur' },
      ],
      rows,
    });
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
