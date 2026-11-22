import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types';
import type { AuditService } from '../../audit/audit.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { replaceWfToolGrantsSchema } from './tool-grants.dto';
import { ToolGrantsService } from './tool-grants.service';

const admin: AuthUser = { userId: 1, username: 'adm', isAdmin: false, userGroupId: 10, fullName: 'Admin Wf' };

const TOOLS = [
  { wfToolId: 1, toolKey: 'lire_document', isEnabled: true },
  { wfToolId: 2, toolKey: 'lire_courrier', isEnabled: true },
  { wfToolId: 3, toolKey: 'proposer_reponse', isEnabled: false },
];

function build(opts: { definition?: boolean; grants?: Array<{ toolId: number; max: number | null }>; draftUses?: Array<{ toolKey: string; stepKey: string }> } = {}) {
  const grants = new Map<number, number | null>((opts.grants ?? []).map((g) => [g.toolId, g.max]));
  const tx = {
    wfToolGrant: {
      upsert: jest.fn(async ({ create, update }: { create: { toolId: number; maxCallsPerInstance: number | null }; update: { maxCallsPerInstance: number | null } }) => {
        grants.set(create.toolId, grants.has(create.toolId) ? update.maxCallsPerInstance : create.maxCallsPerInstance);
      }),
      findMany: jest.fn(async ({ where }: { where: { toolId: { notIn: number[] } } }) =>
        [...grants.keys()].filter((id) => !where.toolId.notIn.includes(id)).map((toolId) => ({ toolId }))),
      deleteMany: jest.fn(async ({ where }: { where: { toolId: { in: number[] } } }) => {
        where.toolId.in.forEach((id) => grants.delete(id));
      }),
    },
    wfAgentConfigTool: {
      findMany: jest.fn(async () =>
        (opts.draftUses ?? []).map((u) => ({ tool: { toolKey: u.toolKey }, agentConfig: { stepKey: u.stepKey } }))),
    },
  };
  const prisma = {
    wfDefinition: { findUnique: jest.fn().mockResolvedValue(opts.definition === false ? null : { wfDefinitionId: 5 }) },
    wfTool: {
      findMany: jest.fn(async (args?: { where?: { toolKey?: { in: string[] } } }) =>
        args?.where?.toolKey ? TOOLS.filter((t) => args.where?.toolKey?.in.includes(t.toolKey)) : TOOLS),
    },
    wfToolGrant: {
      findMany: jest.fn(async () =>
        [...grants.entries()].map(([toolId, max]) => ({ maxCallsPerInstance: max, tool: { toolKey: TOOLS.find((t) => t.wfToolId === toolId)?.toolKey } }))),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = { dataChange: jest.fn().mockResolvedValue(undefined) };
  return {
    prisma, tx, audit, grants,
    svc: new ToolGrantsService(prisma as unknown as PrismaService, audit as unknown as AuditService),
  };
}

describe('ToolGrantsService.replaceGrants', () => {
  it('remplace l’ensemble : upsert des présentes, suppression des absentes, audit', async () => {
    const { svc, grants, audit, tx } = build({ grants: [{ toolId: 2, max: 3 }] });
    const res = await svc.replaceGrants(5, { grants: [{ toolKey: 'lire_document', maxCallsPerInstance: 4 }] }, admin);
    expect(res.grants).toEqual([{ toolKey: 'lire_document', maxCallsPerInstance: 4 }]);
    expect(res.warnings).toEqual([]);
    expect([...grants.keys()]).toEqual([1]);
    expect(tx.wfToolGrant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ grantedBy: 10, definitionId: 5 }) }),
    );
    expect(audit.dataChange).toHaveBeenCalledTimes(1);
    expect(audit.dataChange).toHaveBeenCalledWith({
      userGroupId: 10,
      actorFullName: 'Admin Wf',
      objectRef: 'wf_tool_grant:definition:5',
      oldValue: JSON.stringify([{ toolKey: 'lire_courrier', maxCallsPerInstance: 3 }]),
      newValue: JSON.stringify([{ toolKey: 'lire_document', maxCallsPerInstance: 4 }]),
    });
  });

  it('plafond absent = null (illimité)', async () => {
    const { svc } = build();
    const res = await svc.replaceGrants(5, { grants: [{ toolKey: 'lire_courrier' }] }, admin);
    expect(res.grants).toEqual([{ toolKey: 'lire_courrier', maxCallsPerInstance: null }]);
  });

  it('outil inconnu => 422, rien n’est écrit ni journalisé', async () => {
    const { svc, tx, audit } = build();
    await expect(svc.replaceGrants(5, { grants: [{ toolKey: 'inconnu' }] }, admin)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(tx.wfToolGrant.upsert).not.toHaveBeenCalled();
    expect(audit.dataChange).not.toHaveBeenCalled();
  });

  it('outil désactivé => 422', async () => {
    const { svc } = build();
    await expect(svc.replaceGrants(5, { grants: [{ toolKey: 'proposer_reponse' }] }, admin)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('définition inconnue => 404', async () => {
    const { svc } = build({ definition: false });
    await expect(svc.replaceGrants(5, { grants: [] }, admin)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('acteur non identifié (machine ou sans groupe) => 403', async () => {
    const { svc } = build();
    await expect(svc.replaceGrants(5, { grants: [] }, { ...admin, isScanAgent: true })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.replaceGrants(5, { grants: [] }, { ...admin, userGroupId: null })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.listCatalog({ ...admin, userGroupId: null })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.getGrants(5, { ...admin, userGroupId: null })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('retrait d’une autorisation encore utilisée par le brouillon : avertissement, sans bloquer', async () => {
    const { svc, grants } = build({
      grants: [{ toolId: 2, max: null }],
      draftUses: [{ toolKey: 'lire_courrier', stepKey: 'etape_agent' }],
    });
    const res = await svc.replaceGrants(5, { grants: [] }, admin);
    expect(res.grants).toEqual([]);
    expect(grants.size).toBe(0);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('lire_courrier');
    expect(res.warnings[0]).toContain('etape_agent');
  });

  it('ensemble vide sur définition sans autorisation : aucun appel d’outils', async () => {
    const { svc, prisma } = build();
    const res = await svc.replaceGrants(5, { grants: [] }, admin);
    expect(res).toEqual({ grants: [], warnings: [] });
    expect(prisma.wfTool.findMany).not.toHaveBeenCalled();
  });
});

describe('ToolGrantsService lectures', () => {
  it('catalogue', async () => {
    const { svc, prisma } = build();
    prisma.wfTool.findMany.mockResolvedValueOnce([
      { toolKey: 'a', label: 'A', description: null, sideEffect: 0, requiresValidation: false, inputSchema: { type: 'object' }, isEnabled: true },
    ] as never);
    await expect(svc.listCatalog(admin)).resolves.toEqual([
      { toolKey: 'a', label: 'A', description: null, sideEffect: 0, requiresValidation: false, inputSchema: { type: 'object' }, isEnabled: true },
    ]);
  });

  it('autorisations d’une définition, 404 si inconnue', async () => {
    const { svc } = build({ grants: [{ toolId: 1, max: 2 }] });
    await expect(svc.getGrants(5, admin)).resolves.toEqual([{ toolKey: 'lire_document', maxCallsPerInstance: 2 }]);
    const none = build({ definition: false });
    await expect(none.svc.getGrants(5, admin)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('replaceWfToolGrantsSchema', () => {
  it('valide', () => {
    expect(replaceWfToolGrantsSchema.safeParse({ grants: [{ toolKey: 'a_b.c', maxCallsPerInstance: 3 }, { toolKey: 'd', maxCallsPerInstance: null }] }).success).toBe(true);
    expect(replaceWfToolGrantsSchema.safeParse({ grants: [] }).success).toBe(true);
  });
  it.each([
    [{}],
    [{ grants: [{ toolKey: 'A' }] }],
    [{ grants: [{ toolKey: 'a', maxCallsPerInstance: 0 }] }],
    [{ grants: [{ toolKey: 'a', maxCallsPerInstance: 1.5 }] }],
    [{ grants: [{ toolKey: 'a', extra: 1 }] }],
    [{ grants: [{ toolKey: 'a' }, { toolKey: 'a' }] }],
    [{ grants: [], extra: 1 }],
  ])('refuse %j', (body) => {
    expect(replaceWfToolGrantsSchema.safeParse(body).success).toBe(false);
  });
});
