import { Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { emergencyStopSchema, type EmergencyStopInput, type WfBudgetDto } from '@archivage/types';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { MenuPermissionGuard } from '../../auth/menu-permission.guard';
import { RequireMenu } from '../../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../../workflows/workflows.menus';
import {
  updateWfBudgetSchema,
  type UpdateWfBudgetInput,
  type WfAgentBudgetOverviewDto,
  type WfAgentStatusDto,
} from './agent-admin.dto';
import { AgentAdminService } from './agent-admin.service';

/**
 * Administration des agents (budget, arrêt d'urgence). Accès refusé par défaut : le menu « administration »
 * des workflows est exigé sur CHAQUE route (administrateurs inclus par le garde) ; le service refuse en plus
 * l'identité machine.
 */
@Controller('workflows/agents')
@UseGuards(MenuPermissionGuard)
export class AgentAdminController {
  constructor(private readonly service: AgentAdminService) {}

  @Get('status')
  @RequireMenu(WORKFLOWS_MENUS.admin)
  status(@CurrentUser() user: AuthUser): Promise<WfAgentStatusDto> {
    return this.service.status(user);
  }

  @Get('budget')
  @RequireMenu(WORKFLOWS_MENUS.admin)
  budget(@CurrentUser() user: AuthUser): Promise<WfAgentBudgetOverviewDto> {
    return this.service.getBudget(user);
  }

  @Put('budget')
  @RequireMenu(WORKFLOWS_MENUS.admin)
  updateBudget(
    @Body(new ZodValidationPipe(updateWfBudgetSchema)) body: UpdateWfBudgetInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfBudgetDto> {
    return this.service.updateBudget(body, user);
  }

  @Post('emergency-stop')
  @HttpCode(200)
  @RequireMenu(WORKFLOWS_MENUS.admin)
  emergencyStop(
    @Body(new ZodValidationPipe(emergencyStopSchema)) body: EmergencyStopInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfBudgetDto> {
    return this.service.setEmergencyStop(body, user);
  }
}
