import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  createWfDefinitionSchema,
  upsertWfAgentConfigSchema,
  type CreateWfDefinitionInput,
  type UpsertWfAgentConfigInput,
  type WfAgentConfigDetailDto,
  type WfDefinitionDto,
  type WfDefinitionVersionDto,
} from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireAdmin, RequireMenu } from '../auth/require-menu.decorator';
import {
  listWfDefinitionsQuerySchema,
  setWfLowRiskSchema,
  updateWfDraftSchema,
  wfDefinitionIdSchema,
  wfStepKeySchema,
  wfVersionNumberSchema,
  type ListWfDefinitionsQuery,
  type SetWfLowRiskInput,
  type UpdateWfDraftInput,
  type WfDefinitionDetailDto,
  type WfDefinitionValidationResponse,
  type WfDefinitionWithVersionDto,
} from './definitions.dto';
import { DefinitionsService } from './definitions.service';
import { WORKFLOWS_MENUS } from './workflows.menus';

const idPipe = new ZodValidationPipe(wfDefinitionIdSchema);
const versionPipe = new ZodValidationPipe(wfVersionNumberSchema);
const stepKeyPipe = new ZodValidationPipe(wfStepKeySchema);

/**
 * Définitions de workflow (conception). Accès refusé par défaut : le menu « conception » est exigé
 * (administrateurs inclus par le garde) ; les écritures exigent en plus un acteur identifié (le service
 * refuse l'identité machine). Le marquage « faible risque » est réservé aux administrateurs.
 */
@Controller('workflows/definitions')
@UseGuards(MenuPermissionGuard)
export class DefinitionsController {
  constructor(private readonly service: DefinitionsService) {}

  @Get()
  @RequireMenu(WORKFLOWS_MENUS.design)
  list(
    @Query(new ZodValidationPipe(listWfDefinitionsQuerySchema)) query: ListWfDefinitionsQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<WfDefinitionDto[]> {
    return this.service.list(query, user);
  }

  /** Définitions publiées : celui qui peut lancer (ou concevoir) les voit. */
  @Get('launchable')
  @RequireMenu(WORKFLOWS_MENUS.launch, WORKFLOWS_MENUS.design)
  launchable(@CurrentUser() user: AuthUser): Promise<WfDefinitionDto[]> {
    return this.service.listLaunchable(user);
  }

  @Get(':id')
  @RequireMenu(WORKFLOWS_MENUS.design)
  get(@Param('id', idPipe) id: number, @CurrentUser() user: AuthUser): Promise<WfDefinitionDetailDto> {
    return this.service.get(id, user);
  }

  @Get(':id/versions/:versionNumber')
  @RequireMenu(WORKFLOWS_MENUS.design)
  version(
    @Param('id', idPipe) id: number,
    @Param('versionNumber', versionPipe) versionNumber: number,
    @CurrentUser() user: AuthUser,
  ): Promise<WfDefinitionVersionDto> {
    return this.service.getVersion(id, versionNumber, user);
  }

  @Post()
  @RequireMenu(WORKFLOWS_MENUS.design)
  create(
    @Body(new ZodValidationPipe(createWfDefinitionSchema)) body: CreateWfDefinitionInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfDefinitionWithVersionDto> {
    return this.service.create(body, user);
  }

  @Put(':id/draft')
  @RequireMenu(WORKFLOWS_MENUS.design)
  updateDraft(
    @Param('id', idPipe) id: number,
    @Body(new ZodValidationPipe(updateWfDraftSchema)) body: UpdateWfDraftInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfDefinitionWithVersionDto> {
    return this.service.updateDraft(id, body, user);
  }

  /** Configuration des étapes agent du brouillon (graphe + lignes `wf_agent_config`). */
  @Get(':id/draft/agents')
  @RequireMenu(WORKFLOWS_MENUS.design)
  listAgents(@Param('id', idPipe) id: number, @CurrentUser() user: AuthUser): Promise<WfAgentConfigDetailDto[]> {
    return this.service.listAgentConfigs(id, user);
  }

  @Put(':id/draft/agents/:stepKey')
  @RequireMenu(WORKFLOWS_MENUS.design)
  upsertAgent(
    @Param('id', idPipe) id: number,
    @Param('stepKey', stepKeyPipe) stepKey: string,
    @Body(new ZodValidationPipe(upsertWfAgentConfigSchema)) body: UpsertWfAgentConfigInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfAgentConfigDetailDto> {
    return this.service.upsertAgentConfig(id, stepKey, body, user);
  }

  @Post(':id/validate')
  @HttpCode(200)
  @RequireMenu(WORKFLOWS_MENUS.design)
  validate(
    @Param('id', idPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<WfDefinitionValidationResponse> {
    return this.service.validateDraft(id, user);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @RequireMenu(WORKFLOWS_MENUS.design)
  publish(@Param('id', idPipe) id: number, @CurrentUser() user: AuthUser): Promise<WfDefinitionWithVersionDto> {
    return this.service.publish(id, user);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequireMenu(WORKFLOWS_MENUS.design)
  archive(@Param('id', idPipe) id: number, @CurrentUser() user: AuthUser): Promise<WfDefinitionDto> {
    return this.service.archive(id, user);
  }

  @Post(':id/low-risk')
  @HttpCode(200)
  @RequireAdmin()
  setLowRisk(
    @Param('id', idPipe) id: number,
    @Body(new ZodValidationPipe(setWfLowRiskSchema)) body: SetWfLowRiskInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfDefinitionDto> {
    return this.service.setLowRisk(id, body.isLowRisk, user);
  }
}
