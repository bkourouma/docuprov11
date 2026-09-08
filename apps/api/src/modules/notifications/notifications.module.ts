import { Module } from '@nestjs/common';
import { ParametresModule } from '../parametres/parametres.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { EmailService } from './email.service';

/** Brique transverse : inbox in-app + e-mail (§03.5). Réutilisable au-delà de Docu-Courriers. */
@Module({
  // L'identité affichée dans les e-mails vient du paramétrage (`email_template_setting`).
  imports: [ParametresModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, EmailService],
  exports: [NotificationsService, EmailService],
})
export class NotificationsModule {}
