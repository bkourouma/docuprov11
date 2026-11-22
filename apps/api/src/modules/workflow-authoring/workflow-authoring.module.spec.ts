import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { Provider, Type } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { WF_AGENT_GATE } from '../workflow-agents/agent.contracts';
import { AuthoringController } from './authoring.controller';
import { AuthoringRateLimitGuard } from './authoring.rate-limit.guard';
import { AuthoringService } from './authoring.service';
import { WorkflowAuthoringModule } from './workflow-authoring.module';

// Modules d'infrastructure (JWT, IA, agents) remplacés : on teste le CÂBLAGE du module.
jest.mock('../auth/auth.module', () => ({ AuthModule: class {} }));
jest.mock('../ai/ai.module', () => ({ AiModule: class {} }));
jest.mock('../workflow-agents/workflow-agents.module', () => ({ WorkflowAgentsModule: class {} }));

const meta = <T>(key: string): T => Reflect.getMetadata(key, WorkflowAuthoringModule) as T;

describe('WorkflowAuthoringModule : câblage', () => {
  it('déclare le contrôleur, le service et le garde de débit', () => {
    expect(meta<Type[]>('controllers')).toEqual([AuthoringController]);
    expect(meta<Provider[]>('providers')).toEqual(
      expect.arrayContaining([AuthoringService, AuthoringRateLimitGuard]),
    );
    expect(meta<unknown[]>('imports')).toHaveLength(3);
  });

  it('se compose avec ses dépendances (garde W2, IA, base, audit)', async () => {
    const ref = await Test.createTestingModule({
      controllers: meta<Type[]>('controllers'),
      providers: [
        ...meta<Provider[]>('providers'),
        { provide: WF_AGENT_GATE, useValue: {} },
        { provide: AiService, useValue: { run: jest.fn(), getEffectiveConfig: jest.fn() } },
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { dataChange: jest.fn() } },
      ],
    })
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    expect(ref.get(AuthoringService)).toBeInstanceOf(AuthoringService);
    expect(ref.get(AuthoringController)).toBeInstanceOf(AuthoringController);
    expect(ref.get(AuthoringRateLimitGuard)).toBeInstanceOf(AuthoringRateLimitGuard);
  });
});
