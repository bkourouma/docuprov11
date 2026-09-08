import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailTemplateController } from './email-template.controller';
import { EmailTemplateService } from './email-template.service';

/**
 * Paramétrage transverse de l'application. N'en contient aujourd'hui qu'un : l'identité des e-mails
 * de notification (§03.5), sortie des variables d'environnement pour devenir éditable en ligne.
 *
 * `EmailTemplateService` est EXPORTÉ car `NotificationsModule` s'en sert pour composer chaque
 * e-mail : c'est le même paramétrage des deux côtés, jamais une copie.
 */
@Module({
  imports: [AuthModule],
  controllers: [EmailTemplateController],
  providers: [EmailTemplateService],
  exports: [EmailTemplateService],
})
export class ParametresModule {}
