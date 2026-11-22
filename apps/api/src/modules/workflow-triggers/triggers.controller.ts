import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../workflows/workflows.menus';
import {
  createTriggerSchema,
  listTriggersQuerySchema,
  updateTriggerSchema,
  wfTriggerIdSchema,
  type CreateTriggerInput,
  type ListTriggersQuery,
  type TriggerCatalogDto,
  type TriggerDto,
  type UpdateTriggerInput,
} from './triggers.dto';
import { WorkflowTriggersService } from './triggers.service';

// Les schémas avec valeurs par défaut ou transformations ont une entrée différente de leur sortie : le tuyau ne
// type que la sortie.
const pipe = <T>(schema: unknown) => new ZodValidationPipe<T>(schema as ZodSchema<T>);

const idPipe = pipe<number>(wfTriggerIdSchema);

/**
 * Déclencheurs par événement : conception uniquement. Accès refusé par défaut : le menu « conception » est exigé
 * sur TOUTES les routes (administrateurs inclus par le garde).
 */
@Controller('workflows/triggers')
@UseGuards(MenuPermissionGuard)
export class WorkflowTriggersController {
  constructor(private readonly service: WorkflowTriggersService) {}

  @Get()
  @RequireMenu(WORKFLOWS_MENUS.design)
  list(@Query(pipe<ListTriggersQuery>(listTriggersQuerySchema)) query: ListTriggersQuery): Promise<TriggerDto[]> {
    return this.service.list(query);
  }

  /** Déclarée AVANT `:id`. */
  @Get('catalog')
  @RequireMenu(WORKFLOWS_MENUS.design)
  catalog(): TriggerCatalogDto {
    return this.service.catalog();
  }

  @Get(':id')
  @RequireMenu(WORKFLOWS_MENUS.design)
  get(@Param('id', idPipe) id: number): Promise<TriggerDto> {
    return this.service.get(id);
  }

  @Post()
  @RequireMenu(WORKFLOWS_MENUS.design)
  create(
    @Body(pipe<CreateTriggerInput>(createTriggerSchema)) body: CreateTriggerInput,
    @CurrentUser() user: AuthUser,
  ): Promise<TriggerDto> {
    return this.service.create(user, body);
  }

  @Put(':id')
  @RequireMenu(WORKFLOWS_MENUS.design)
  update(
    @Param('id', idPipe) id: number,
    @Body(pipe<UpdateTriggerInput>(updateTriggerSchema)) body: UpdateTriggerInput,
    @CurrentUser() user: AuthUser,
  ): Promise<TriggerDto> {
    return this.service.update(user, id, body);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequireMenu(WORKFLOWS_MENUS.design)
  async remove(@Param('id', idPipe) id: number, @CurrentUser() user: AuthUser): Promise<{ deleted: true }> {
    await this.service.remove(user, id);
    return { deleted: true };
  }
}
