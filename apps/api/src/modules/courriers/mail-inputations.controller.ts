import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MAIL_WORKFLOW_MENUS } from './mail-workflow.menus';
import { MailInputationsService } from './mail-inputations.service';
import {
  createInputationSchema,
  submitValidationSchema,
  treatRecipientSchema,
  type CreateInputationBody,
  type SubmitValidationBody,
  type TreatRecipientBody,
} from './mail-inputations.dto';

/** Imputations (§08/§10) — routées sous /courriers, gardées par le menu Parapheur/Validation. */
@UseGuards(MenuPermissionGuard)
@Controller('courriers')
export class MailInputationsController {
  constructor(private readonly service: MailInputationsService) {}

  // Créable aussi depuis le contrôle (§06) : l'onglet Imputations y est ouvert dès l'arrivée,
  // avant même que le courrier n'atteigne le parapheur. Et depuis la Validation (§10), dont le
  // `MailViewer` propose le même panneau d'imputation (Suivi et Recherche, eux, le masquent via
  // `canAddImputations={false}`).
  @RequireMenu('/courriers/controle', '/courriers/parapheur', '/courriers/validation')
  @Post('imputations')
  create(
    @Body(new ZodValidationPipe(createInputationSchema)) body: CreateInputationBody,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.create(body, user);
  }

  /** Suppression d'une imputation (§08) — réservée à son auteur, cf. `MailInputationsService.remove`. */
  @RequireMenu('/courriers/controle')
  @Delete('imputations/:id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.remove(id, user);
  }

  @RequireMenu('/courriers/parapheur')
  @Post('imputations/validation')
  submitValidation(
    @Body(new ZodValidationPipe(submitValidationSchema)) body: SubmitValidationBody,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.createValidation(
      body.mailId,
      body.userGroupId,
      body.isDG ?? false,
      user,
      new Date(),
    );
  }

  /** Lecture d'un courrier (§08) : validation automatique des imputations « suivi ». */
  @RequireMenu('/courriers/parapheur')
  @Post(':id/imputations/lecture')
  @HttpCode(200)
  read(@Param('id', ParseIntPipe) id: number) {
    return this.service.treatOnRead(id, new Date());
  }

  /** « Marquer comme traité » manuel (§08) — action de workflow partagée, cf. MAIL_WORKFLOW_MENUS. */
  @RequireMenu(...MAIL_WORKFLOW_MENUS)
  @Post(':id/imputations/traiter')
  @HttpCode(200)
  treat(@Param('id', ParseIntPipe) id: number) {
    return this.service.markTreated(id, new Date());
  }

  /** Traitement des imputations d'un destinataire (validation en masse §10). */
  @RequireMenu('/courriers/validation')
  @Post(':id/imputations/traiter-destinataire')
  @HttpCode(200)
  treatRecipient(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(treatRecipientSchema)) body: TreatRecipientBody,
  ) {
    return this.service.markRecipientTreated(id, body.userGroupId, new Date());
  }
}
