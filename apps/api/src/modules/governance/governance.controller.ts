import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  governanceAnalyzeRequestSchema,
  governanceListQuerySchema,
  governanceValidateRequestSchema,
  type GovernanceAnalyzeRequest,
  type GovernanceAnalyzeResponse,
  type GovernanceDashboard,
  type GovernanceListQuery,
  type GovernanceProposalDetail,
  type GovernanceProposalPage,
  type GovernanceReviewResponse,
  type GovernanceValidateRequest,
} from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { GovernanceQueryService } from './governance-query.service';
import { GovernanceReviewService } from './governance-review.service';
import { GOVERNANCE_MENU } from './governance.menus';

/** Identifiant de chemin : entier strictement positif (les décisions sont des BigInt, mais bornées à int32 ici). */
const proposalIdSchema = z.coerce.number().int().positive().max(2_147_483_647);
export const proposalIdPipe = new ZodValidationPipe(proposalIdSchema);

/**
 * Gouvernance des documents. Accès refusé par défaut : sans le menu « Gouvernance », 403 (aucun
 * `@Public`). Les droits sur les documents sont appliqués dans le SQL du service de lecture.
 */
@Controller('governance')
@UseGuards(MenuPermissionGuard)
@RequireMenu(GOVERNANCE_MENU)
export class GovernanceController {
  constructor(
    private readonly query: GovernanceQueryService,
    private readonly review: GovernanceReviewService,
  ) {}

  @Get('dashboard')
  dashboard(@CurrentUser() user: AuthUser): Promise<GovernanceDashboard> {
    return this.query.dashboard(user);
  }

  @Get('proposals')
  list(
    @Query(new ZodValidationPipe(governanceListQuerySchema)) query: GovernanceListQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<GovernanceProposalPage> {
    return this.query.list(query, user);
  }

  @Get('proposals/:id')
  get(
    @Param('id', proposalIdPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<GovernanceProposalDetail> {
    return this.query.get(id, user);
  }

  @Post('proposals/:id/validate')
  @HttpCode(200)
  async validate(
    @Param('id', proposalIdPipe) id: number,
    @Body(new ZodValidationPipe(governanceValidateRequestSchema)) body: GovernanceValidateRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<GovernanceReviewResponse> {
    const { applied } = await this.review.validate(id, user, body);
    return { proposal: await this.viewOf(id, user), applied: applied ?? null };
  }

  @Post('proposals/:id/reject')
  @HttpCode(200)
  async reject(
    @Param('id', proposalIdPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<GovernanceReviewResponse> {
    await this.review.reject(id, user);
    return { proposal: await this.viewOf(id, user, true), applied: null };
  }

  @Post('analyze')
  @HttpCode(202)
  analyze(
    @Body(new ZodValidationPipe(governanceAnalyzeRequestSchema)) body: GovernanceAnalyzeRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<GovernanceAnalyzeResponse> {
    return this.query.analyze(body, user);
  }

  /**
   * Vue de la proposition SANS la comparaison (réponse de revue). Après un REJET (`adminFallback`),
   * une proposition orpheline est invisible pour `get` : un administrateur reçoit alors la vue
   * construite par `getForAdminReview` (sans comparaison, libellés absents). Tout autre 404 est
   * propagé tel quel.
   */
  private async viewOf(id: number, user: AuthUser, adminFallback = false) {
    try {
      const { comparison: _comparison, ...view } = await this.query.get(id, user);
      return view;
    } catch (e) {
      if (adminFallback && user.isAdmin === true && e instanceof NotFoundException) {
        return this.query.getForAdminReview(id, user);
      }
      throw e;
    }
  }
}
