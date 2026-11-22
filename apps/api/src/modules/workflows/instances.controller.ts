import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { WfInstanceDto } from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import type { WfInstanceDetail, WfTransitionResult } from './engine/engine.types';
import { InstancesService } from './instances.service';
import {
  bigintIdSchema,
  instanceReasonSchema,
  launchInstanceSchema,
  listInstancesQuerySchema,
  type InstanceReasonBody,
  type LaunchInstanceBody,
  type ListInstancesQuery,
  zodPipe,
} from './workflows.dto';
import { WORKFLOWS_MENUS } from './workflows.menus';

const idPipe = new ZodValidationPipe(bigintIdSchema);

/**
 * Instances de workflow. Accès refusé par défaut (`MenuPermissionGuard`) :
 *  - lancer : menu LANCER ; le lanceur est toujours l'utilisateur authentifié ;
 *  - lister : menu LANCER ou ADMIN (le périmètre est ensuite borné par le service) ;
 *  - lire le détail : SANS menu, car un assigné qui n'a pas LANCER doit pouvoir consulter l'instance de
 *    sa tâche ; le service répond 404 à quiconque n'est ni lanceur, ni assigné, ni détenteur du menu ADMIN ;
 *  - annuler / suspendre / reprendre : menu LANCER ou ADMIN, puis lanceur ou détenteur du menu ADMIN
 *    (vérifié par le service). `isAdmin` passe le guard comme pour tout menu mais n'acquiert aucun pouvoir
 *    sur les tâches (boîte).
 */
@Controller('workflows/instances')
@UseGuards(MenuPermissionGuard)
export class InstancesController {
  constructor(private readonly instances: InstancesService) {}

  /** 201 si l'instance est créée, 200 si elle existait déjà pour cette clé d'idempotence. */
  @Post()
  @RequireMenu(WORKFLOWS_MENUS.launch)
  async launch(
    @Body(zodPipe(launchInstanceSchema)) body: LaunchInstanceBody,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Pick<Response, 'status'>,
  ): Promise<WfInstanceDto> {
    const { created, instance } = await this.instances.launch(user, body);
    res.status(created ? 201 : 200);
    return instance;
  }

  @Get()
  @RequireMenu(WORKFLOWS_MENUS.launch, WORKFLOWS_MENUS.admin)
  list(
    @Query(zodPipe(listInstancesQuerySchema)) query: ListInstancesQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<{ items: WfInstanceDto[]; total: number }> {
    return this.instances.list(user, query);
  }

  @Get(':id')
  detail(@Param('id', idPipe) id: string, @CurrentUser() user: AuthUser): Promise<WfInstanceDetail> {
    return this.instances.detail(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequireMenu(WORKFLOWS_MENUS.launch, WORKFLOWS_MENUS.admin)
  cancel(
    @Param('id', idPipe) id: string,
    @Body(zodPipe(instanceReasonSchema)) body: InstanceReasonBody,
    @CurrentUser() user: AuthUser,
  ): Promise<WfTransitionResult> {
    return this.instances.cancel(user, id, body.reason);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequireMenu(WORKFLOWS_MENUS.launch, WORKFLOWS_MENUS.admin)
  suspend(
    @Param('id', idPipe) id: string,
    @Body(zodPipe(instanceReasonSchema)) body: InstanceReasonBody,
    @CurrentUser() user: AuthUser,
  ): Promise<WfTransitionResult> {
    return this.instances.suspend(user, id, body.reason);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequireMenu(WORKFLOWS_MENUS.launch, WORKFLOWS_MENUS.admin)
  resume(@Param('id', idPipe) id: string, @CurrentUser() user: AuthUser): Promise<WfTransitionResult> {
    return this.instances.resume(user, id);
  }
}
