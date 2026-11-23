import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { createRoleSchema, updateRoleSchema } from './roles.dto';
import { RolesService } from './roles.service';

function setup(opts: { role?: { roleId: number; isSystem: boolean } | null; deleteError?: unknown }) {
  const prisma = {
    role: {
      findUnique: jest.fn(async () => (opts.role === undefined ? null : opts.role)),
      delete: jest.fn(async () => {
        if (opts.deleteError) throw opts.deleteError;
        return {};
      }),
    },
    $transaction: jest.fn(),
  };
  return { service: new RolesService(prisma as unknown as PrismaService), prisma };
}

describe('RolesService — suppression', () => {
  it('supprime un rôle ordinaire', async () => {
    const { service, prisma } = setup({ role: { roleId: 4, isSystem: false } });
    await expect(service.deleteRole(4)).resolves.toEqual({ deleted: true });
    expect(prisma.role.delete).toHaveBeenCalledWith({ where: { roleId: 4 } });
  });

  it('refuse (400) la suppression du rôle système', async () => {
    const { service, prisma } = setup({ role: { roleId: 1, isSystem: true } });
    await expect(service.deleteRole(1)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('rend 404 pour un rôle inexistant', async () => {
    const { service } = setup({ role: null });
    await expect(service.deleteRole(999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rend 400 lisible (et non 500) pour un rôle destinataire de courriers (FK NO ACTION, P2003)', async () => {
    const { service } = setup({ role: { roleId: 4, isSystem: false }, deleteError: { code: 'P2003' } });
    await expect(service.deleteRole(4)).rejects.toThrow(/courriers sont adressés à ce rôle/);
    await expect(service.deleteRole(4)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('laisse passer une erreur inattendue telle quelle', async () => {
    const boom = new Error('base indisponible');
    const { service } = setup({ role: { roleId: 4, isSystem: false }, deleteError: boom });
    await expect(service.deleteRole(4)).rejects.toBe(boom);
  });
});

describe('RolesService — rôle système non modifiable', () => {
  it('refuse (400) toute modification du rôle système, sans transaction', async () => {
    const { service, prisma } = setup({ role: { roleId: 1, isSystem: true } });
    await expect(service.updateRole(1, { menuKeys: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.updateRole(1, { isActive: false })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('roles.dto — nom de rôle', () => {
  it('refuse un nom vide ou fait d’espaces (il était enregistré vide)', () => {
    expect(createRoleSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createRoleSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(updateRoleSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rogne le nom et borne sa longueur à la colonne (200)', () => {
    expect(createRoleSchema.parse({ name: '  Agent  ' }).name).toBe('Agent');
    expect(createRoleSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    expect(createRoleSchema.safeParse({ name: 'x'.repeat(200) }).success).toBe(true);
  });

  it('laisse le nom facultatif en modification', () => {
    expect(updateRoleSchema.safeParse({ isActive: false }).success).toBe(true);
  });
});
