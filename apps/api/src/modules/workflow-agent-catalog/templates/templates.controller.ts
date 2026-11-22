import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { MenuPermissionGuard } from '../../auth/menu-permission.guard';
import { RequireMenu } from '../../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../../workflows/workflows.menus';
import type { InstantiateTemplateResult, WorkflowTemplateSummary } from './template.types';
import { TemplatesService } from './templates.service';

export const templateKeySchema = z.string().regex(/^[a-z0-9-]+$/, 'clé de modèle invalide').max(100);

/** Corps facultatif : nom à donner au workflow créé. */
export const instantiateTemplateSchema = z
  .object({ name: z.string().trim().min(1).max(200).optional() })
  .strict()
  .optional();
export type InstantiateTemplateInput = z.infer<typeof instantiateTemplateSchema>;

const keyPipe = new ZodValidationPipe(templateKeySchema);

/**
 * Modèles de workflow prêts à l'emploi. Accès refusé par défaut : le menu « conception » est exigé sur
 * chaque route (comme `DefinitionsController`).
 */
@Controller('workflows/templates')
@UseGuards(MenuPermissionGuard)
export class TemplatesController {
  constructor(private readonly service: TemplatesService) {}

  @Get()
  @RequireMenu(WORKFLOWS_MENUS.design)
  list(): WorkflowTemplateSummary[] {
    return this.service.list();
  }

  @Post(':key/instantiate')
  @HttpCode(201)
  @RequireMenu(WORKFLOWS_MENUS.design)
  instantiate(
    @Param('key', keyPipe) key: string,
    @Body(new ZodValidationPipe(instantiateTemplateSchema)) body: InstantiateTemplateInput,
    @CurrentUser() user: AuthUser,
  ): Promise<InstantiateTemplateResult> {
    return this.service.instantiate(key, body?.name, user);
  }
}
