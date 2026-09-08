import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Post,
  Put,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'node:fs';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { Public } from '../auth/public.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { EmailTemplateService, type UploadedLogo } from './email-template.service';
import { updateEmailTemplateSchema, type UpdateEmailTemplateDto } from './email-template.dto';

/**
 * Paramétrage de l'identité des e-mails — menu « /admin/parametres/email ».
 *
 * La route du logo est la seule exception : elle est PUBLIQUE parce qu'un client mail télécharge
 * les images sans jeton. Elle est donc déclarée en premier, avant que le garde de menu ne
 * s'applique au reste.
 */
@Controller('parametres/email-template')
export class EmailTemplateController {
  constructor(private readonly service: EmailTemplateService) {}

  /**
   * Logo servi en clair, pour les boîtes mail. Aucune donnée sensible : c'est le logo institutionnel
   * déjà présent dans chaque e-mail émis. Mis en cache une heure côté client — l'URL est stable, et
   * un logo re-téléchargé à chaque message se fait bloquer comme traceur par certains clients.
   */
  @Public()
  @Get('logo')
  @Header('Cache-Control', 'public, max-age=3600')
  async logo(): Promise<StreamableFile> {
    const target = await this.service.getLogoTarget();
    return new StreamableFile(createReadStream(target.filePath), {
      type: target.contentType,
      disposition: 'inline; filename="email-logo"',
    });
  }

  @UseGuards(MenuPermissionGuard)
  @RequireMenu('/admin/parametres/email')
  @Get()
  get() {
    return this.service.get();
  }

  @UseGuards(MenuPermissionGuard)
  @RequireMenu('/admin/parametres/email')
  @Put()
  update(
    @Body(new ZodValidationPipe(updateEmailTemplateSchema)) body: UpdateEmailTemplateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(body, user);
  }

  @UseGuards(MenuPermissionGuard)
  @RequireMenu('/admin/parametres/email')
  @Post('logo')
  @UseInterceptors(FileInterceptor('file'))
  uploadLogo(@UploadedFile() file: UploadedLogo | undefined, @CurrentUser() user: AuthUser) {
    return this.service.uploadLogo(file, user);
  }

  @UseGuards(MenuPermissionGuard)
  @RequireMenu('/admin/parametres/email')
  @Delete('logo')
  deleteLogo(@CurrentUser() user: AuthUser) {
    return this.service.deleteLogo(user);
  }
}
