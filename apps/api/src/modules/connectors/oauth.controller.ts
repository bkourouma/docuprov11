import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireAdmin } from '../auth/require-menu.decorator';
import { connectorIdSchema } from './connectors.dto';
import {
  oauthCallbackSchema,
  oauthStartSchema,
  type OAuthCallbackDto,
  type OAuthStartDto,
} from './oauth.dto';
import { OAuthService } from './oauth.service';

const connectorIdPipe = new ZodValidationPipe(connectorIdSchema);

/**
 * Autorisation OAuth des connecteurs GED — administration. Mêmes gardes que `ConnectorsController`.
 * Ce contrôleur DOIT précéder `ConnectorsController` dans le module : ainsi `oauth/callback` n'est
 * jamais interprété comme un `:id`.
 */
@Controller('ged/connectors')
@UseGuards(MenuPermissionGuard)
@RequireAdmin()
export class OAuthController {
  constructor(private readonly service: OAuthService) {}

  /** Retour de l'écran d'autorisation : la page web appelle cette route avec le JWT de l'administrateur. */
  @Post('oauth/callback')
  @HttpCode(200)
  callback(
    @Body(new ZodValidationPipe(oauthCallbackSchema)) body: OAuthCallbackDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.callback(body, user);
  }

  @Post(':id/oauth/start')
  @HttpCode(200)
  start(
    @Param('id', connectorIdPipe) id: number,
    @Body(new ZodValidationPipe(oauthStartSchema)) body: OAuthStartDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.start(id, body, user);
  }
}
