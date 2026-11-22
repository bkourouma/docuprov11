import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { WfEvalCaseDto, WfEvalRunDto, WfEvalSetDto } from '@archivage/types';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { MenuPermissionGuard } from '../../auth/menu-permission.guard';
import { RequireMenu } from '../../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../../workflows/workflows.menus';
import {
  bigIntIdSchema,
  createEvalCaseSchema,
  createEvalSetSchema,
  evalStatusQuerySchema,
  intIdSchema,
  listEvalCasesQuerySchema,
  listEvalSetsQuerySchema,
  runEvalSetSchema,
  updateEvalCaseSchema,
  updateEvalSetSchema,
  type CreateEvalCaseInput,
  type CreateEvalSetInput,
  type EvalStatusResponse,
  type RunEvalSetInput,
  type UpdateEvalCaseInput,
  type UpdateEvalSetInput,
} from './eval.dto';
import { EvalService } from './eval.service';

const idPipe = new ZodValidationPipe(intIdSchema);

/**
 * Jeux d'évaluation des agents et runs. Accès refusé par défaut : le menu « conception » des workflows est
 * exigé sur CHAQUE route ; le service refuse en plus l'identité machine pour toute écriture ou tout run.
 */
@Controller('workflows/agents')
@UseGuards(MenuPermissionGuard)
export class EvalController {
  constructor(private readonly service: EvalService) {}

  /** Éligibilité de chaque étape agent de la dernière version à l'autonomie (lecture seule). */
  @Get('eval-status')
  @RequireMenu(WORKFLOWS_MENUS.design)
  evalStatus(
    @Query(new ZodValidationPipe(evalStatusQuerySchema)) query: { definitionId: number },
  ): Promise<EvalStatusResponse> {
    return this.service.getEligibilityStatus(query.definitionId);
  }

  @Get('eval-sets')
  @RequireMenu(WORKFLOWS_MENUS.design)
  listSets(
    @Query(new ZodValidationPipe(listEvalSetsQuerySchema)) query: { definitionId?: number },
  ): Promise<WfEvalSetDto[]> {
    return this.service.listSets(query.definitionId);
  }

  @Post('eval-sets')
  @RequireMenu(WORKFLOWS_MENUS.design)
  createSet(
    @Body(new ZodValidationPipe(createEvalSetSchema)) body: CreateEvalSetInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfEvalSetDto> {
    return this.service.createSet(body, user);
  }

  @Get('eval-sets/:id')
  @RequireMenu(WORKFLOWS_MENUS.design)
  getSet(@Param('id', idPipe) id: number): Promise<WfEvalSetDto> {
    return this.service.getSet(id);
  }

  @Patch('eval-sets/:id')
  @RequireMenu(WORKFLOWS_MENUS.design)
  updateSet(
    @Param('id', idPipe) id: number,
    @Body(new ZodValidationPipe(updateEvalSetSchema)) body: UpdateEvalSetInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfEvalSetDto> {
    return this.service.updateSet(id, body, user);
  }

  @Get('eval-sets/:id/cases')
  @RequireMenu(WORKFLOWS_MENUS.design)
  listCases(
    @Param('id', idPipe) id: number,
    @Query(new ZodValidationPipe(listEvalCasesQuerySchema)) query: { includeInactive?: 'true' | 'false' },
  ): Promise<WfEvalCaseDto[]> {
    return this.service.listCases(id, query.includeInactive === 'true');
  }

  @Post('eval-sets/:id/cases')
  @RequireMenu(WORKFLOWS_MENUS.design)
  addCase(
    @Param('id', idPipe) id: number,
    @Body(new ZodValidationPipe(createEvalCaseSchema)) body: CreateEvalCaseInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfEvalCaseDto> {
    return this.service.addCase(id, body, user);
  }

  @Patch('eval-sets/:id/cases/:caseId')
  @RequireMenu(WORKFLOWS_MENUS.design)
  updateCase(
    @Param('id', idPipe) id: number,
    @Param('caseId', idPipe) caseId: number,
    @Body(new ZodValidationPipe(updateEvalCaseSchema)) body: UpdateEvalCaseInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfEvalCaseDto> {
    return this.service.updateCase(id, caseId, body, user);
  }

  /** Supprimer = désactiver le cas (les runs passés restent lisibles). */
  @Delete('eval-sets/:id/cases/:caseId')
  @HttpCode(HttpStatus.OK)
  @RequireMenu(WORKFLOWS_MENUS.design)
  removeCase(
    @Param('id', idPipe) id: number,
    @Param('caseId', idPipe) caseId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<WfEvalCaseDto> {
    return this.service.removeCase(id, caseId, user);
  }

  @Get('eval-sets/:id/runs')
  @RequireMenu(WORKFLOWS_MENUS.design)
  listRuns(@Param('id', idPipe) id: number): Promise<WfEvalRunDto[]> {
    return this.service.listRuns(id);
  }

  /** 202 : le run est créé (statut « en cours ») et s'exécute en arrière-plan ; relire `GET eval-runs/:runId`. */
  @Post('eval-sets/:id/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireMenu(WORKFLOWS_MENUS.design)
  runSet(
    @Param('id', idPipe) id: number,
    @Body(new ZodValidationPipe(runEvalSetSchema.optional())) body: RunEvalSetInput | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<WfEvalRunDto> {
    return this.service.runSet(id, body ?? {}, user);
  }

  @Get('eval-runs/:runId')
  @RequireMenu(WORKFLOWS_MENUS.design)
  getRun(@Param('runId', new ZodValidationPipe(bigIntIdSchema)) runId: string): Promise<WfEvalRunDto> {
    return this.service.getRun(runId);
  }
}
