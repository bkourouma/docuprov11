import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { MenuPermissionGuard } from '../../auth/menu-permission.guard';
import { RequireMenu } from '../../auth/require-menu.decorator';
import { wfDefinitionIdSchema } from '../../workflows/definitions.dto';
import { WORKFLOWS_MENUS } from '../../workflows/workflows.menus';
import {
  replaceWfToolGrantsSchema,
  type ReplaceWfToolGrantsInput,
  type WfToolCatalogEntryDto,
  type WfToolGrantDto,
  type WfToolGrantsResponse,
} from './tool-grants.dto';
import { ToolGrantsService } from './tool-grants.service';

const idPipe = new ZodValidationPipe(wfDefinitionIdSchema);

/** Outils d'agent et autorisations par workflow : menu d'administration des workflows exigé partout. */
@Controller('workflows/agents')
@UseGuards(MenuPermissionGuard)
export class ToolGrantsController {
  constructor(private readonly service: ToolGrantsService) {}

  @Get('tools')
  @RequireMenu(WORKFLOWS_MENUS.admin)
  catalog(@CurrentUser() user: AuthUser): Promise<WfToolCatalogEntryDto[]> {
    return this.service.listCatalog(user);
  }

  @Get('definitions/:id/tool-grants')
  @RequireMenu(WORKFLOWS_MENUS.admin)
  grants(@Param('id', idPipe) id: number, @CurrentUser() user: AuthUser): Promise<WfToolGrantDto[]> {
    return this.service.getGrants(id, user);
  }

  @Put('definitions/:id/tool-grants')
  @RequireMenu(WORKFLOWS_MENUS.admin)
  replace(
    @Param('id', idPipe) id: number,
    @Body(new ZodValidationPipe(replaceWfToolGrantsSchema)) body: ReplaceWfToolGrantsInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfToolGrantsResponse> {
    return this.service.replaceGrants(id, body, user);
  }
}
