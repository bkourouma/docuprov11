import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HierarchyService } from '../../common/hierarchy.service';
import { OrganigrammeService } from './organigramme.service';

interface Node {
  organigrammeId: number;
  parentId: number | null;
  label: string;
  path: string;
  depth: number;
  isActive: boolean;
}

/**
 * Prisma en mémoire, réduit à ce que lit/écrit le service (findUnique / findMany startsWith /
 * create / update / updateMany startsWith). Suffit à éprouver chemins et règles d'arbre.
 */
function fakePrisma(seed: Node[]) {
  const nodes = new Map(seed.map((n) => [n.organigrammeId, { ...n }]));
  let nextId = Math.max(0, ...seed.map((n) => n.organigrammeId)) + 1;
  const pick = (n: Node | undefined) => (n ? { ...n } : null);
  const roles = new Map<number, { roleId: number; organigrammeId: number | null }>([
    [1, { roleId: 1, organigrammeId: null }],
  ]);
  return {
    nodes,
    roles,
    organigramme: {
      findUnique: jest.fn(async ({ where }: { where: { organigrammeId: number } }) =>
        pick(nodes.get(where.organigrammeId)),
      ),
      findMany: jest.fn(async ({ where }: { where?: { path?: { startsWith: string } } }) =>
        [...nodes.values()]
          .filter((n) => !where?.path || n.path.startsWith(where.path.startsWith))
          .map((n) => ({ ...n })),
      ),
      create: jest.fn(async ({ data }: { data: Omit<Node, 'organigrammeId' | 'isActive'> }) => {
        const n: Node = { ...data, organigrammeId: nextId++, isActive: true };
        nodes.set(n.organigrammeId, n);
        return { ...n };
      }),
      update: jest.fn(
        async ({ where, data }: { where: { organigrammeId: number }; data: Partial<Node> }) => {
          const n = nodes.get(where.organigrammeId)!;
          Object.assign(n, data);
          return { ...n };
        },
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: { path: { startsWith: string } }; data: Partial<Node> }) => {
          let count = 0;
          for (const n of nodes.values()) {
            if (n.path.startsWith(where.path.startsWith)) {
              Object.assign(n, data);
              count++;
            }
          }
          return { count };
        },
      ),
    },
    role: {
      findUnique: jest.fn(async ({ where }: { where: { roleId: number } }) =>
        roles.has(where.roleId) ? { roleId: where.roleId } : null,
      ),
      update: jest.fn(
        async ({ where, data }: { where: { roleId: number }; data: { organigrammeId: number | null } }) => {
          const r = roles.get(where.roleId)!;
          r.organigrammeId = data.organigrammeId;
          return { ...r };
        },
      ),
    },
  };
}

const node = (id: number, parentId: number | null, path: string, isActive = true): Node => ({
  organigrammeId: id,
  parentId,
  label: `N${id}`,
  path,
  depth: path.split('/').filter(Boolean).length - 1,
  isActive,
});

describe('OrganigrammeService', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let service: OrganigrammeService;

  // Arbre : 1 (racine) > 2 > 3 ; 4 (racine) ; 5 (racine désactivée)
  beforeEach(() => {
    prisma = fakePrisma([
      node(1, null, '/1/'),
      node(2, 1, '/1/2/'),
      node(3, 2, '/1/2/3/'),
      node(4, null, '/4/'),
      node(5, null, '/5/', false),
    ]);
    service = new OrganigrammeService(prisma as never, new HierarchyService());
  });

  it('crée une racine puis un enfant avec chemin et profondeur dérivés du parent', async () => {
    const root = await service.create({ label: '  Direction  ' });
    expect(root).toMatchObject({ label: 'Direction', parentId: null, depth: 0, path: `/${root.organigrammeId}/` });

    const child = await service.create({ label: 'Service', parentId: 3 });
    expect(child).toMatchObject({ parentId: 3, depth: 3, path: `/1/2/3/${child.organigrammeId}/` });
  });

  it('refuse un parent inconnu (400)', async () => {
    await expect(service.create({ label: 'X', parentId: 999 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuse un parent désactivé à la création (plus d’enfant actif orphelin)', async () => {
    await expect(service.create({ label: 'X', parentId: 5 })).rejects.toThrow(/désactivé/);
    expect(prisma.organigramme.create).not.toHaveBeenCalled();
  });

  it('déplace un sous-arbre et recalcule chemins et profondeurs de tous ses nœuds', async () => {
    await service.reparent(2, 4);
    expect(prisma.nodes.get(2)).toMatchObject({ parentId: 4, path: '/4/2/', depth: 1 });
    expect(prisma.nodes.get(3)).toMatchObject({ parentId: 2, path: '/4/2/3/', depth: 2 });
    expect(prisma.nodes.get(1)).toMatchObject({ path: '/1/' });
  });

  it('remonte un nœud à la racine (parent null)', async () => {
    await service.reparent(3, null);
    expect(prisma.nodes.get(3)).toMatchObject({ parentId: null, path: '/3/', depth: 0 });
  });

  it('refuse de faire d’un nœud son propre parent', async () => {
    await expect(service.reparent(2, 2)).rejects.toThrow(/propre parent/);
  });

  it('refuse un déplacement cyclique (sous un de ses descendants)', async () => {
    await expect(service.reparent(1, 3)).rejects.toThrow(/cyclique/);
    expect(prisma.nodes.get(1)).toMatchObject({ path: '/1/' });
  });

  it('refuse un déplacement sous un parent désactivé', async () => {
    await expect(service.reparent(4, 5)).rejects.toThrow(/désactivé/);
    expect(prisma.nodes.get(4)).toMatchObject({ parentId: null, path: '/4/' });
  });

  it('ne confond pas /1/ et /12/ dans la détection de cycle', async () => {
    prisma.nodes.set(12, node(12, null, '/12/'));
    await expect(service.reparent(1, 12)).resolves.toEqual({ moved: true });
    expect(prisma.nodes.get(3)).toMatchObject({ path: '/12/1/2/3/' });
  });

  it('désactive un nœud ET tout son sous-arbre, rien d’autre', async () => {
    await service.deactivate(2);
    expect(prisma.nodes.get(2)!.isActive).toBe(false);
    expect(prisma.nodes.get(3)!.isActive).toBe(false);
    expect(prisma.nodes.get(1)!.isActive).toBe(true);
    expect(prisma.nodes.get(4)!.isActive).toBe(true);
  });

  it('désactivation / renommage d’un nœud inconnu : 404', async () => {
    await expect(service.deactivate(999)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update(999, { label: 'X' })).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('assignation rôle ↔ organigramme (§15)', () => {
    it('rattache puis détache un rôle', async () => {
      await service.assignRole(1, 2);
      expect(prisma.roles.get(1)!.organigrammeId).toBe(2);
      await service.assignRole(1, null);
      expect(prisma.roles.get(1)!.organigrammeId).toBeNull();
    });

    it('refuse un rôle inconnu (404) et un nœud inconnu (400)', async () => {
      await expect(service.assignRole(999, 2)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.assignRole(1, 999)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuse un nœud désactivé', async () => {
      await expect(service.assignRole(1, 5)).rejects.toThrow(/désactivé/);
      expect(prisma.role.update).not.toHaveBeenCalled();
    });
  });
});
