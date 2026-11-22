import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env';
import { CommonModule } from './common/common.module';
import { pinoHttpOptions } from './common/log-sanitize';
import { AccessInquiriesModule } from './modules/access-inquiries/access-inquiries.module';
import { AcquisitionModule } from './modules/acquisition/acquisition.module';
import { AiModule } from './modules/ai/ai.module';
import { ConnectorsModule } from './modules/connectors/connectors.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ArchivesModule } from './modules/archives/archives.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CollabModule } from './modules/collab/collab.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { CourriersModule } from './modules/courriers/courriers.module';
import { DocumentsModule } from './modules/documents/documents.module';
// --- Lot 5 : gouvernance ---
import { GovernanceModule } from './modules/governance/governance.module';
// --- fin Lot 5 ---
import { IntercalairesModule } from './modules/intercalaires/intercalaires.module';
import { ParametresModule } from './modules/parametres/parametres.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { QueueModule } from './modules/queue/queue.module';
import { ReferentialsModule } from './modules/referentials/referentials.module';
import { DocVersionsModule } from './modules/doc-versions/doc-versions.module';
import { RolesModule } from './modules/roles/roles.module';
import { DraftingModule } from './modules/drafting/drafting.module';
import { SemanticSearchModule } from './modules/semantic-search/semantic-search.module';
import { SpacesModule } from './modules/spaces/spaces.module';
import { UsersModule } from './modules/users/users.module';
// --- Docu-Flow W1 ---
import { WorkflowsModule } from './modules/workflows/workflows.module';
import { WorkflowAgentsModule } from './modules/workflow-agents/workflow-agents.module';
// --- fin Docu-Flow W1 ---
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // Loaded relative to cwd: app dir first, then the monorepo root .env.
      envFilePath: ['.env', '../../.env'],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
        ...pinoHttpOptions,
      },
    }),
    PrismaModule,
    CommonModule,
    AuditModule,
    QueueModule,
    AuthModule,
    AccessInquiriesModule,
    AcquisitionModule,
    AnalyticsModule,
    ArchivesModule,
    IntercalairesModule,
    DocumentsModule,
    DocVersionsModule,
    SpacesModule,
    CollabModule,
    ParametresModule,
    ReferentialsModule,
    RolesModule,
    UsersModule,
    CourriersModule,
    AiModule,
    SemanticSearchModule,

    ConnectorsModule,
    // --- Lot 5 : gouvernance ---
    GovernanceModule,
    // --- fin Lot 5 ---
    // --- Lot 4c : rédaction assistée ---
    DraftingModule,
    // --- fin Lot 4c ---
    // --- Docu-Flow W1 ---
    WorkflowsModule,
    WorkflowAgentsModule, // Docu-Flow W2 : agents
    // --- fin Docu-Flow W1 ---
  ],
  providers: [
    // Deny-by-default at the transport layer: every route needs a JWT unless @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
