import type { PrismaService } from '../prisma/prisma.service';
import { SubjectAccessRegistry } from './extension/subject-access';
import { PrincipalService } from './principal.service';

function build(owner: number | null, ownerRow: unknown) {
  const prisma = { appUserGroup: { findUnique: jest.fn().mockResolvedValue(ownerRow) } };
  const registry = new SubjectAccessRegistry();
  const resolveOwner = jest.fn().mockResolvedValue(owner);
  registry.register({ subjectType: 'mail', canAccess: () => Promise.resolve(true), resolveOwner });
  return { prisma, resolveOwner, svc: new PrincipalService(prisma as unknown as PrismaService, registry) };
}

describe('PrincipalService.resolveSubjectOwner', () => {
  it('renvoie le propriétaire actif', async () => {
    const { svc, resolveOwner } = build(77, { user: { isDisabled: false } });
    await expect(svc.resolveSubjectOwner('mail', '10')).resolves.toBe(77);
    expect(resolveOwner).toHaveBeenCalledWith('10');
  });

  it('renvoie null si le propriétaire est désactivé ou inexistant', async () => {
    await expect(build(77, { user: { isDisabled: true } }).svc.resolveSubjectOwner('mail', '10')).resolves.toBeNull();
    await expect(build(77, null).svc.resolveSubjectOwner('mail', '10')).resolves.toBeNull();
  });

  it('renvoie null sans propriétaire ou pour un type inconnu, sans interroger la base', async () => {
    const a = build(null, { user: { isDisabled: false } });
    await expect(a.svc.resolveSubjectOwner('mail', '10')).resolves.toBeNull();
    expect(a.prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
    await expect(a.svc.resolveSubjectOwner('dossier', '10')).resolves.toBeNull();
  });

  it('renvoie null sans registre', async () => {
    const prisma = { appUserGroup: { findUnique: jest.fn() } };
    const svc = new PrincipalService(prisma as unknown as PrismaService);
    await expect(svc.resolveSubjectOwner('mail', '10')).resolves.toBeNull();
    expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
  });
});
