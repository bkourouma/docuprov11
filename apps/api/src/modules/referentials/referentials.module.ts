import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReferentialsController } from './referentials.controller';
import { ReferentialsService } from './referentials.service';

@Module({
  imports: [AuthModule],
  controllers: [ReferentialsController],
  providers: [ReferentialsService],
})
export class ReferentialsModule {}
