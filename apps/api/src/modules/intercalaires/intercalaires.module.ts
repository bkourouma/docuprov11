import { Module } from '@nestjs/common';
import { IntercalairesController } from './intercalaires.controller';
import { IntercalairesService } from './intercalaires.service';

@Module({
  controllers: [IntercalairesController],
  providers: [IntercalairesService],
})
export class IntercalairesModule {}
