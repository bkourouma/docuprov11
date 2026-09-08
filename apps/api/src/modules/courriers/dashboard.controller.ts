import { Body, Controller, Delete, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { MENU_DASHBOARD_COURRIERS } from '../roles/menu-catalog';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { DashboardService } from './dashboard.service';
import { DashboardLayoutService, type AgencementResponse } from './dashboard-layout.service';
import {
  agencementSchema,
  dashboardFilterSchema,
  type AgencementDto,
  repartitionFilterSchema,
  type AlertesResponse,
  type ChargeResponse,
  type DashboardFilterDto,
  type DelaisResponse,
  type FilesResponse,
  type FluxResponse,
  type HygieneResponse,
  type RetardsResponse,
  type RepartitionFilterDto,
  type RepartitionResponse,
  type SyntheseResponse,
} from './dashboard.dto';

/**
 * Tableau de bord Docu-Courriers — un endpoint par zone d'écran, pour qu'une agrégation lente
 * n'empêche pas l'affichage du reste.
 *
 * **POST + filtre dans le corps** : le filtre est un objet structuré, et c'est la convention déjà
 * en place pour `POST /analytics/overview`. `@HttpCode(200)` — ces routes lisent, elles ne créent rien.
 *
 * ⚠️ Ce contrôleur doit être enregistré AVANT `MailsController` dans `courriers.module.ts` : tous
 * les `@Controller('courriers*')` s'aplatissent dans un même routeur, et le `@Get(':id')` glouton
 * de `MailsController` capterait sinon `/courriers/dashboard/...`.
 */
@UseGuards(MenuPermissionGuard)
@Controller('courriers/dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly layout: DashboardLayoutService,
  ) {}

  // ---------------------------------------------------------------------------
  // Agencement personnalisable (widgets placés par l'utilisateur)
  // ---------------------------------------------------------------------------

  /**
   * Agencement de l'utilisateur courant, widgets re-filtrés par permission, plus le catalogue
   * de ce qu'il peut encore ajouter. Sert aussi à savoir quels jeux de données charger.
   */
  @Get('layout')
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  getLayout(@CurrentUser() user: AuthUser): Promise<AgencementResponse> {
    return this.layout.getForUser(user);
  }

  /** Enregistre l'agencement. Le service borne les positions et refuse les widgets non autorisés. */
  @Put('layout')
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  saveLayout(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(agencementSchema)) corps: AgencementDto,
  ): Promise<AgencementResponse> {
    return this.layout.save(user, corps.widgets);
  }

  /** Retour à l'agencement livré : supprime le réglage, ne le remplace pas. */
  @Delete('layout')
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  resetLayout(@CurrentUser() user: AuthUser): Promise<AgencementResponse> {
    return this.layout.reset(user);
  }

  /** Zone 1 — retards courriers et imputations, courriers sans imputation (D1, D3, E5). */
  @Post('alertes')
  @HttpCode(200)
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  alertes(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dashboardFilterSchema)) filtre: DashboardFilterDto,
  ): Promise<AlertesResponse> {
    return this.dashboard.alertes(user, filtre);
  }

  /** Zone 2 — tour de contrôle : les sept files, compteur et ancienneté du plus vieil élément. */
  @Post('files')
  @HttpCode(200)
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  files(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dashboardFilterSchema)) filtre: DashboardFilterDto,
  ): Promise<FilesResponse> {
    return this.dashboard.files(user, filtre);
  }

  /** Zone 3 — chiffres clés de la période et variation (A1, A4, A5, C3). */
  @Post('synthese')
  @HttpCode(200)
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  synthese(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dashboardFilterSchema)) filtre: DashboardFilterDto,
  ): Promise<SyntheseResponse> {
    return this.dashboard.synthese(user, filtre);
  }

  /** Zone 4 — flux entrées/sorties et backlog cumulé (A7, A8). */
  @Post('flux')
  @HttpCode(200)
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  flux(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dashboardFilterSchema)) filtre: DashboardFilterDto,
  ): Promise<FluxResponse> {
    return this.dashboard.flux(user, filtre);
  }

  /** Zone 5 — répartition selon une dimension en liste blanche (A2, A3, F1–F4). */
  @Post('repartition')
  @HttpCode(200)
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  repartition(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(repartitionFilterSchema)) filtre: RepartitionFilterDto,
  ): Promise<RepartitionResponse> {
    return this.dashboard.repartition(user, filtre);
  }

  /** Zone 6a — paliers d'échéance, ancienneté du backlog, top des retards (D4, D5, D6). */
  @Post('retards')
  @HttpCode(200)
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  retards(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dashboardFilterSchema)) filtre: DashboardFilterDto,
  ): Promise<RetardsResponse> {
    return this.dashboard.retards(user, filtre);
  }

  /** Zone 6b — délais de prise en charge et de traitement, respect du SLA (C1, C3, C4, C5). */
  @Post('delais')
  @HttpCode(200)
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  delais(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dashboardFilterSchema)) filtre: DashboardFilterDto,
  ): Promise<DelaisResponse> {
    return this.dashboard.delais(user, filtre);
  }

  /**
   * Zone 7 — charge par agent et par service (E1–E3, C7).
   *
   * **403 hors périmètre global** : la restriction est portée par le service, de sorte qu'un appel
   * direct à l'endpoint ne contourne pas ce que l'écran ne montre pas.
   */
  @Post('charge')
  @HttpCode(200)
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  charge(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dashboardFilterSchema)) filtre: DashboardFilterDto,
  ): Promise<ChargeResponse> {
    return this.dashboard.charge(user, filtre);
  }

  /** Zone 9 — hygiène des données (G1–G9) : ce qui dégrade silencieusement les autres indicateurs. */
  @Post('hygiene')
  @HttpCode(200)
  @RequireMenu(MENU_DASHBOARD_COURRIERS)
  hygiene(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(dashboardFilterSchema)) filtre: DashboardFilterDto,
  ): Promise<HygieneResponse> {
    return this.dashboard.hygiene(user, filtre);
  }
}
