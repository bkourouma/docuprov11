import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { MailsService } from '../courriers/mails.service';
import { DocumentsService } from '../documents/documents.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubjectAccessRegistry } from '../workflows/extension/subject-access';
import { PrincipalService } from '../workflows/principal.service';
import { WF_TRIGGER_STARTER } from '../workflows/workflows.tokens';
import { WorkflowEventBus } from './bus/workflow-event-bus';
import { WorkflowTriggerDispatcher } from './dispatch/triggers.dispatcher';
import { WorkflowEventsConsumer } from './dispatch/workflow-events.consumer';
import { WF_EMERGENCY_STOP_GATE } from './dispatch/emergency-stop';
import { documentDepositedEvent } from './domain/events';
import { WorkflowTriggersController } from './triggers.controller';
import { WorkflowTriggersModule } from './workflow-triggers.module';
import { WorkflowSubjectAccessRegistrar } from './access/subject-access.registrar';

// Modules d'infrastructure (JWT, SMTP, IA) remplacés : on teste le CÂBLAGE du module.
jest.mock('../courriers/mails.service', () => ({ MailsService: class {} }));
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }));
jest.mock('../courriers/courriers.module', () => ({ CourriersModule: class {} }));
jest.mock('../workflows/workflows.module', () => ({ WorkflowsModule: class {} }));
jest.mock('../auth/auth.module', () => ({ AuthModule: class {} }));

const meta = <T>(key: string): T => Reflect.getMetadata(key, WorkflowTriggersModule) as T;

describe('WorkflowTriggersModule : câblage', () => {
  const starter = { start: jest.fn() };
  const prisma = {
    wfTrigger: { findMany: jest.fn().mockResolvedValue([]) },
  };

  async function compile() {
    return Test.createTestingModule({
      controllers: meta<never[]>('controllers'),
      providers: [
        ...meta<Provider[]>('providers'),
        WorkflowEventBus,
        SubjectAccessRegistry,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { dataChange: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: MailsService, useValue: {} },
        { provide: DocumentsService, useValue: {} },
        { provide: PrincipalService, useValue: { canLaunch: jest.fn() } },
        { provide: WF_TRIGGER_STARTER, useValue: starter },
      ],
    })
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
  }

  it('déclare le contrôleur de conception, le répartiteur, le consommateur et exporte le bus', () => {
    expect(meta<unknown[]>('controllers')).toEqual([WorkflowTriggersController]);
    const providers = meta<Array<Provider>>('providers');
    expect(providers).toEqual(expect.arrayContaining([WorkflowTriggerDispatcher, WorkflowEventsConsumer]));
    expect(providers).toEqual(
      expect.arrayContaining([expect.objectContaining({ provide: WF_EMERGENCY_STOP_GATE })]),
    );
    expect(meta<unknown[]>('exports').length).toBeGreaterThan(0);
  });

  it('enregistre les contrôleurs courrier et document, rien d’autre (accès refusé par défaut)', async () => {
    const ref = await compile();
    ref.get(WorkflowSubjectAccessRegistrar).onModuleInit();
    const registry = ref.get(SubjectAccessRegistry);
    expect(registry.get('mail')).toBeDefined();
    expect(registry.get('document')).toBeDefined();
    expect(registry.get('dossier')).toBeUndefined();
    expect(registry.get('other')).toBeUndefined();
  });

  it('le répartiteur est abonné au bus : un événement émis interroge les déclencheurs, sans bloquer', async () => {
    const ref = await compile();
    ref.get(WorkflowTriggerDispatcher).onModuleInit();
    const bus = ref.get(WorkflowEventBus);
    const accepted = bus.emit(documentDepositedEvent({ documentId: 5, documentTypeId: 2 }, { source: 'acquisition', pageCount: 3 }));
    expect(accepted).toBe(true);
    await bus.idle();
    expect(prisma.wfTrigger.findMany).toHaveBeenCalled();
    expect(starter.start).not.toHaveBeenCalled();
  });

  it('le consommateur ne démarre aucune connexion Redis sous test', async () => {
    const ref = await compile();
    expect(() => ref.get(WorkflowEventsConsumer).onApplicationBootstrap()).not.toThrow();
  });
});
