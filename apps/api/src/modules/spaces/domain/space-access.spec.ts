import {
  canChangeKind,
  canPublish,
  isDocumentListable,
  memberPermission,
  resolveSpaceAccess,
  type SpaceAccessFacts,
  type SpaceActor,
} from './space-access';
import { isValidSlug, nextAvailableSlug, slugify } from './space-slug';

// Données fictives : identifiants arbitraires, aucune donnée réelle.
const OWNER_GROUP = 10;
const OWNER_OTHER_GROUP = 11;

const owner: SpaceActor = {
  userGroupIds: [OWNER_GROUP, OWNER_OTHER_GROUP],
  roleId: null,
  isAdmin: false,
};
const stranger: SpaceActor = { userGroupIds: [20], roleId: 5, isAdmin: false };
const admin: SpaceActor = { userGroupIds: [30], roleId: null, isAdmin: true };

function space(overrides: Partial<SpaceAccessFacts> = {}): SpaceAccessFacts {
  return { kind: 1, isActive: true, ownerUserGroupId: OWNER_GROUP, members: [], ...overrides };
}

describe('resolveSpaceAccess', () => {
  it('propriétaire reconnu via un AUTRE de ses comptes-groupes', () => {
    const d = resolveSpaceAccess(space({ ownerUserGroupId: OWNER_OTHER_GROUP }), owner);
    expect(d).toMatchObject({ visible: true, access: 'owner', canManage: true, canDelete: true });
  });

  describe('espace privé (0)', () => {
    it('visible du propriétaire seulement', () => {
      expect(resolveSpaceAccess(space({ kind: 0 }), owner).access).toBe('owner');
    });

    it('invisible pour un autre utilisateur', () => {
      expect(resolveSpaceAccess(space({ kind: 0 }), stranger).visible).toBe(false);
    });

    it("invisible pour un administrateur (pas de passe-droit sur l'espace privé d'autrui)", () => {
      expect(resolveSpaceAccess(space({ kind: 0 }), admin)).toMatchObject({
        visible: false,
        access: null,
        canManage: false,
      });
    });

    it('invisible pour un « membre » résiduel, même gestionnaire, même par rôle', () => {
      const s = space({
        kind: 0,
        members: [
          { userGroupId: 20, roleId: null, permission: 2 },
          { userGroupId: null, roleId: 5, permission: 2 },
        ],
      });
      expect(resolveSpaceAccess(s, stranger).visible).toBe(false);
    });
  });

  it('espace inactif : invisible même pour le propriétaire', () => {
    expect(resolveSpaceAccess(space({ isActive: false }), owner).visible).toBe(false);
    expect(resolveSpaceAccess(space({ isActive: false, kind: 3 }), admin).visible).toBe(false);
  });

  it('nature inconnue : refus par défaut', () => {
    expect(resolveSpaceAccess(space({ kind: 9 }), admin).visible).toBe(false);
  });

  it('membre par rôle', () => {
    const d = resolveSpaceAccess(
      space({ kind: 2, members: [{ userGroupId: null, roleId: 5, permission: 1 }] }),
      stranger,
    );
    expect(d).toMatchObject({ visible: true, access: 1, canContribute: true, canManage: false });
  });

  it("un rôle n'ouvre rien si l'acteur n'a pas de rôle actif", () => {
    const d = resolveSpaceAccess(
      space({ members: [{ userGroupId: null, roleId: 5, permission: 2 }] }),
      { ...stranger, roleId: null },
    );
    expect(d.visible).toBe(false);
  });

  it('cumul compte + rôle : permission maximale', () => {
    const d = resolveSpaceAccess(
      space({
        members: [
          { userGroupId: 20, roleId: null, permission: 0 },
          { userGroupId: null, roleId: 5, permission: 2 },
        ],
      }),
      stranger,
    );
    expect(d).toMatchObject({ access: 2, canManage: true, canDelete: false });
  });

  it('lecture seule : ni contribution ni gestion', () => {
    const d = resolveSpaceAccess(
      space({ members: [{ userGroupId: 20, roleId: null, permission: 0 }] }),
      stranger,
    );
    expect(d).toMatchObject({ visible: true, access: 0, canContribute: false, canManage: false });
    expect(d.documentScope).toBe('full');
  });

  it("espace partagé d'autrui sans appartenance : invisible", () => {
    expect(resolveSpaceAccess(space({ kind: 2 }), stranger).visible).toBe(false);
  });

  it("administrateur non membre : lecture seule sur les espaces 1 à 3 d'autrui", () => {
    for (const kind of [1, 2, 3]) {
      expect(resolveSpaceAccess(space({ kind }), admin)).toMatchObject({
        visible: true,
        access: null,
        canContribute: false,
        canManage: false,
        canDelete: false,
      });
    }
  });

  it('publication : lecture seule pour tout authentifié, portée documentaire publique', () => {
    expect(resolveSpaceAccess(space({ kind: 3 }), stranger)).toMatchObject({
      visible: true,
      access: null,
      canContribute: false,
      canManage: false,
      documentScope: 'public',
    });
  });

  it('publication : un membre garde son droit réel et la portée complète', () => {
    const d = resolveSpaceAccess(
      space({ kind: 3, members: [{ userGroupId: 20, roleId: null, permission: 1 }] }),
      stranger,
    );
    expect(d).toMatchObject({ access: 1, canContribute: true, documentScope: 'full' });
  });
});

describe('memberPermission', () => {
  it('ignore une permission hors 0..2', () => {
    expect(
      memberPermission([{ userGroupId: 20, roleId: null, permission: 7 }], stranger),
    ).toBeNull();
  });
  it("ignore les lignes d'autrui", () => {
    expect(memberPermission([{ userGroupId: 99, roleId: 98, permission: 2 }], stranger)).toBeNull();
  });
});

describe('isDocumentListable', () => {
  it('canAccess prime toujours, quelle que soit la portée', () => {
    expect(isDocumentListable({ confidentialiteId: null }, 'full', false)).toBe(false);
    expect(isDocumentListable({ confidentialiteId: null }, 'public', false)).toBe(false);
  });
  it('portée publique : document avec confidentialité exclu même si accessible', () => {
    expect(isDocumentListable({ confidentialiteId: 3 }, 'public', true)).toBe(false);
    expect(isDocumentListable({ confidentialiteId: null }, 'public', true)).toBe(true);
  });
  it('portée complète : document avec confidentialité listé si accessible', () => {
    expect(isDocumentListable({ confidentialiteId: 3 }, 'full', true)).toBe(true);
  });
});

describe('changement de nature / publication', () => {
  it('un espace publié ne change pas de nature', () => {
    expect(canChangeKind(3, 1)).toBe(false);
    expect(canChangeKind(1, 2)).toBe(true);
    expect(canChangeKind(0, 1)).toBe(true);
  });
  it('un espace privé ne se publie pas', () => {
    expect(canPublish(0)).toBe(false);
    expect(canPublish(1)).toBe(true);
    expect(canPublish(2)).toBe(true);
    expect(canPublish(3)).toBe(true);
  });
});

describe('slug', () => {
  it('dérive un slug sans accents', () => {
    expect(slugify('  Rapport Été 2026 — Comité ')).toBe('rapport-ete-2026-comite');
  });
  it('libellé inexploitable : repli', () => {
    expect(slugify('***')).toBe('espace');
    expect(slugify('A')).toBe('espace-a');
  });
  it('slug dérivé toujours valide, même long', () => {
    const s = slugify('x'.repeat(500));
    expect(isValidSlug(s)).toBe(true);
    expect(isValidSlug(nextAvailableSlug(s, new Set([s])))).toBe(true);
  });
  it('suffixe numérique si pris', () => {
    expect(nextAvailableSlug('a-b', new Set())).toBe('a-b');
    expect(nextAvailableSlug('a-b', new Set(['a-b', 'a-b-2']))).toBe('a-b-3');
  });
  it('valide le format', () => {
    expect(isValidSlug('ok-slug-1')).toBe(true);
    expect(isValidSlug('Ab')).toBe(false);
    expect(isValidSlug('a--b')).toBe(false);
    expect(isValidSlug('-ab')).toBe(false);
  });
});
