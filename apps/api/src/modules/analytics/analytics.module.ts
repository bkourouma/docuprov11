import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { DashboardLayoutService } from './dashboard-layout.service';

@Module({
  imports: [AuthModule], // expose AdminGuard pour les futurs endpoints d'objectifs (admin)
  controllers: [AnalyticsController],
  providers: [AnalyticsService, DashboardLayoutService],
})
export class AnalyticsModule {}
