import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import { GED_AI_DISABLED_MESSAGE, type GedAiPipelineJobData } from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireAdmin } from '../auth/require-menu.decorator';
import { AiService } from './ai.service';
import { listAiDecisionsQuerySchema, type ListAiDecisionsQuery } from './ai-decision.dto';
import { AiDecisionService } from './ai-decision.service';
import { GED_AI_QUEUE_TOKEN } from './ai-queue.provider';
import { updateAiSettingsSchema, type UpdateAiSettingsDto } from './ai-settings.dto';
import { AiSettingsService } from './ai-settings.service';

/** Id de document : entier strictement positif tenant dans un int4 (colonne `Int` de Prisma). */
const documentIdPipe = new ZodValidationPipe(
  z.coerce.number().int().min(1).max(2147483647),
);

/**
 * Id de décision (BigInt en base) : entier strictement positif représentable exactement en
 * `number` (le service le reconvertit en BigInt). Zéro, négatif, décimal, NaN : 400.
 */
const decisionIdPipe = new ZodValidationPipe(z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER));

/**
 * Socle IA — administration. Accès refusé par défaut : le contrôleur ENTIER est réservé aux
 * administrateurs (le paramétrage décide de ce qui quitte l'application, la revue des décisions
 * modifie des documents). Les routes statiques précèdent les routes paramétrées.
 */
@Controller('ged/ai')
@UseGuards(MenuPermissionGuard)
@RequireAdmin()
export class AiController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly decisions: AiDecisionService,
    private readonly ai: AiService,
    @Inject(GED_AI_QUEUE_TOKEN) private readonly queue: Queue,
  ) {}

  @Get('settings')
  getSettings() {
    return this.settings.getView();
  }

  @Put('settings')
  updateSettings(
    @Body(new ZodValidationPipe(updateAiSettingsSchema)) body: UpdateAiSettingsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.settings.update(body, user);
  }

  @Get('status')
  status() {
    return this.ai.status();
  }

  @Get('masking-rules')
  maskingRules() {
    return this.settings.listMaskingRules();
  }

  @Get('decisions')
  listDecisions(@Query(new ZodValidationPipe(listAiDecisionsQuerySchema)) query: ListAiDecisionsQuery) {
    return this.decisions.list(query);
  }

  @Get('decisions/:id')
  getDecision(@Param('id', decisionIdPipe) id: number) {
    return this.decisions.get(id);
  }

  @Post('decisions/:id/validate')
  @HttpCode(200)
  validate(@Param('id', decisionIdPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.decisions.validate(id, user);
  }

  @Post('decisions/:id/reject')
  @HttpCode(200)
  reject(@Param('id', decisionIdPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.decisions.reject(id, user);
  }

  /** Met un document en file d'analyse ; IA désactivée => réponse 200 explicite, rien en file. */
  @Post('documents/:documentId/analyze')
  @HttpCode(200)
  async analyze(
    @Param('documentId', documentIdPipe) documentId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ disabled: true; message: string } | { queued: true }> {
    const status = await this.ai.status();
    if (!status.enabled) return { disabled: true, message: GED_AI_DISABLED_MESSAGE };

    const data: GedAiPipelineJobData = { documentId, requestedBy: user.userGroupId };
    await this.queue.add('pipeline', data, { removeOnComplete: 1000, removeOnFail: 1000 });
    return { queued: true };
  }
}
