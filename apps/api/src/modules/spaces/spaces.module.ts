import { Module } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';

/**
 * Espaces GED (lot 4a).
 *
 * `DocumentsService` est déclaré ICI comme provider : `DocumentsModule` ne l'exporte pas et ce lot
 * ne le modifie pas. Il est sans état (PrismaService, AuditService et ConfigService sont globaux),
 * une seconde instance est donc sans effet de bord. C'est lui qui tranche la visibilité de chaque
 * document : l'espace ne duplique pas cette règle.
 */
@Module({
  controllers: [SpacesController],
  providers: [SpacesService, DocumentsService],
})
export class SpacesModule {}
