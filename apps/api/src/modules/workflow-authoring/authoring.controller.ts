import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { WfAuthoringExplanation, WfAuthoringGenerateResponse } from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../workflows/workflows.menus';
import { generateAuthoringSchema, wfAuthoringDefinitionIdSchema, type GenerateAuthoringInput } from './authoring.dto';
import { AuthoringRateLimitGuard } from './authoring.rate-limit.guard';
import { AuthoringService } from './authoring.service';

/**
 * Création d'un workflow en langage naturel. Accès refusé par défaut : le menu « conception » est exigé
 * (administrateurs inclus par le garde). Le garde de débit passe APRÈS le garde de menu.
 */
@Controller('workflows/authoring')
@UseGuards(MenuPermissionGuard)
export class AuthoringController {
  constructor(private readonly service: AuthoringService) {}

  /** Génère un BROUILLON (jamais publié). */
  @Post('generate')
  @RequireMenu(WORKFLOWS_MENUS.design)
  @UseGuards(AuthoringRateLimitGuard)
  generate(
    @Body(new ZodValidationPipe(generateAuthoringSchema)) body: GenerateAuthoringInput,
    @CurrentUser() user: AuthUser,
  ): Promise<WfAuthoringGenerateResponse> {
    return this.service.generate(body, user);
  }

  /** Explique en français la dernière version d'un workflow (lecture seule). */
  @Post('explain/:definitionId')
  @RequireMenu(WORKFLOWS_MENUS.design)
  @HttpCode(200)
  explain(
    @Param('definitionId', new ZodValidationPipe(wfAuthoringDefinitionIdSchema)) definitionId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<WfAuthoringExplanation> {
    return this.service.explain(definitionId, user);
  }
}
